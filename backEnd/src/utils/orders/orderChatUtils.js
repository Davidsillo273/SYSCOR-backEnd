import Order from "../../models/orders/orderModel.js";
import { emitToRoles, emitToTypes, emitToUser, SOCKET_EVENTS } from "../../config/socket.js";
import { sendPushToCustomer, sendPushToEmployee } from "../notifications/pushUtils.js";

// Chat de un pedido a domicilio entre el cliente y su repartidor.
//
// Los mensajes viven en order.driverMessages (cada uno con `from`), así que
// lo que el cliente manda desde Panchita o desde la tarjeta de seguimiento
// aparece en la misma conversación. order.chatRead guarda hasta cuándo leyó
// cada lado para contar los no leídos.
//
//   - El cliente puede escribir mientras el pedido siga activo, aunque todavía
//     no haya repartidor: el mensaje lo ve quien lo tome.
//   - El repartidor solo ve y escribe en los pedidos que tiene asignados.
//   - Entregado o cancelado: el chat queda de solo lectura.

export const CHAT_SIDES = ["customer", "driver"];
const ACTIVE_STATUSES = ["pending", "preparing", "ready", "atrasado"];
export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_TEXT = 500;

// Campos del pedido que necesita el chat (para los .select()).
export const CHAT_FIELDS = "code orderType isDelivery status deliveryStatus customer driver driverMessages chatRead contact eta";

const otherSide = (side) => (side === "customer" ? "driver" : "customer");

const orderCode = (order) => (order.code ? `#${order.code}` : `#${String(order._id).slice(-6).toUpperCase()}`);

export const isChatOrder = (order) => order?.orderType === "online" && !!order?.isDelivery;

export const isChatOpen = (order) =>
    isChatOrder(order) && ACTIVE_STATUSES.includes(order.status) && order.deliveryStatus !== "delivered";

// Mensajes del otro lado posteriores a la última lectura de `side`.
export const unreadCount = (order, side) => {
    const readAt = order?.chatRead?.[side] ? new Date(order.chatRead[side]).getTime() : 0;
    return (order?.driverMessages || []).filter(
        (m) => (m.from || "customer") !== side && new Date(m.createdAt).getTime() > readAt,
    ).length;
};

export const publicMessage = (message) => ({
    id: String(message._id || new Date(message.createdAt).toISOString()),
    from: message.from || "customer",
    text: message.text,
    preset: !!message.preset,
    createdAt: message.createdAt,
});

// Resumen para listas ("Mis pedidos", paradas del repartidor).
export const chatSummary = (order, side) => {
    const messages = order?.driverMessages || [];
    const last = messages[messages.length - 1];
    return {
        available: isChatOrder(order) && (side === "customer" || !!order.driver),
        open: isChatOpen(order),
        hasDriver: !!order?.driver,
        unread: unreadCount(order, side),
        lastMessage: last ? publicMessage(last) : null,
    };
};

// Quién está del otro lado, para el encabezado de la conversación.
const counterpartName = (order, side) => {
    if (side === "customer") {
        const info = order.driver?.personalInfo;
        return info ? `${info.name || ""} ${info.lastname || ""}`.trim() || "Tu repartidor" : null;
    }
    const info = order.customer?.personalInfo || order.contact;
    return info ? `${info.name || ""} ${info.lastname || ""}`.trim() || "Cliente" : "Cliente";
};

// Busca el pedido y confirma que `user` es parte del chat. Devuelve
// { order, side } o { error, code }.
export const loadChatOrder = async (orderId, user) => {
    if (!/^[0-9a-f]{24}$/i.test(String(orderId || ""))) return { code: 404, error: "Pedido no encontrado." };

    const order = await Order.findById(orderId)
        .select(CHAT_FIELDS)
        .populate("driver", "personalInfo.name personalInfo.lastname")
        .populate("customer", "personalInfo.name personalInfo.lastname");
    if (!order || !isChatOrder(order)) return { code: 404, error: "Este pedido no tiene chat con repartidor." };

    const customerId = String(order.customer?._id || order.customer || "");
    const driverId = String(order.driver?._id || order.driver || "");

    if (user?.role === "customer" && customerId === String(user.id)) return { order, side: "customer" };
    if (user?.role === "employee" && driverId && driverId === String(user.id)) return { order, side: "driver" };

    return { code: 403, error: "No participas en el chat de este pedido." };
};

// La conversación completa, desde el punto de vista de `side`.
export const conversationFor = (order, side) => ({
    orderId: String(order._id),
    code: orderCode(order),
    side,
    open: isChatOpen(order),
    hasDriver: !!order.driver,
    counterpart: counterpartName(order, side),
    // Hasta dónde leyó el otro lado (para las palomitas de "visto").
    readByOther: order.chatRead?.[otherSide(side)] || null,
    messages: (order.driverMessages || []).map(publicMessage),
});

// Marca la conversación como leída por `side`. Si había mensajes sin leer,
// avisa al otro lado para que pinte el "Visto" al instante.
export const markChatRead = async (order, side) => {
    const hadUnread = unreadCount(order, side) > 0;
    const now = new Date();
    await Order.updateOne({ _id: order._id }, { $set: { [`chatRead.${side}`]: now } });
    if (!order.chatRead) order.chatRead = {};
    order.chatRead[side] = now;

    if (hadUnread) {
        const otherId = side === "customer" ? order.driver?._id || order.driver : order.customer?._id || order.customer;
        emitToUser(otherId, SOCKET_EVENTS.ORDER_CHAT_READ, { orderId: String(order._id), side, readAt: now });
    }
    return now;
};

/**
 * Guarda un mensaje y avisa al otro lado. Nunca lanza: devuelve
 * { message } o { error }.
 */
export const postChatMessage = async (order, side, rawText, { preset = false } = {}) => {
    if (!isChatOrder(order)) return { error: "Ese pedido no es a domicilio, así que no lleva repartidor." };
    if (!isChatOpen(order)) return { error: `El pedido ${orderCode(order)} ya no está en camino.` };
    if (side === "driver" && !order.driver) return { error: "Este pedido no está asignado a ti." };

    const text = String(rawText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_CHAT_TEXT);
    if (!text) return { error: "El mensaje está vacío." };
    if ((order.driverMessages || []).length >= MAX_CHAT_MESSAGES) {
        return { error: "Esta conversación llegó a su límite. Si es urgente, llama por teléfono." };
    }

    const message = { from: side, text, preset: !!preset, createdAt: new Date() };
    // Quien escribe ya leyó todo lo anterior.
    const updated = await Order.findByIdAndUpdate(
        order._id,
        { $push: { driverMessages: message }, $set: { [`chatRead.${side}`]: message.createdAt } },
        { new: true, projection: { driverMessages: { $slice: -1 } } },
    ).lean();
    const saved = publicMessage(updated?.driverMessages?.[0] || message);

    const payload = { orderId: String(order._id), code: orderCode(order), message: saved };
    const customerId = order.customer?._id || order.customer;
    const driverId = order.driver?._id || order.driver;

    if (side === "customer") {
        if (driverId) {
            emitToUser(driverId, SOCKET_EVENTS.ORDER_CHAT_MESSAGE, payload);
            const info = order.customer?.personalInfo || order.contact;
            sendPushToEmployee(driverId, {
                title: `Mensaje de ${info?.name || "el cliente"} · ${orderCode(order)}`,
                body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
                data: { type: "order_chat", orderId: String(order._id) },
            });
        }
        // Lo que ya escuchaban el panel y los repartidores desde Panchita.
        const legacy = { orderId: order._id, shortId: orderCode(order), message: { text, preset: !!preset, createdAt: message.createdAt } };
        if (!driverId) emitToTypes(["delivery"], SOCKET_EVENTS.ORDER_DRIVER_MESSAGE, legacy);
        emitToRoles(["admin"], SOCKET_EVENTS.ORDER_DRIVER_MESSAGE, legacy);
    } else {
        emitToUser(customerId, SOCKET_EVENTS.ORDER_CHAT_MESSAGE, payload);
        // El cliente casi nunca tiene el chat abierto: se le avisa al teléfono.
        sendPushToCustomer(customerId, {
            title: "Mensaje de tu repartidor",
            body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
            data: { type: "order_chat", orderId: String(order._id) },
        });
    }

    return { message: saved };
};

export default {
    CHAT_FIELDS,
    isChatOrder,
    isChatOpen,
    unreadCount,
    chatSummary,
    loadChatOrder,
    conversationFor,
    markChatRead,
    postChatMessage,
};
