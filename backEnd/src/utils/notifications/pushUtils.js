import CustomerModel from "../../models/users/customerModel.js";

// Notificaciones push a la app de clientes, por el servicio de Expo
// (https://docs.expo.dev/push-notifications/sending-notifications/). La app
// registra su "ExpoPushToken" en customer.pushTokens al iniciar sesión.
//
// Un aviso que no sale nunca debe romper lo que lo disparó (cambiar el estado
// de un pedido, por ejemplo): todos los errores se registran y se ignoran.

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export const isPushToken = (token) => typeof token === "string" && TOKEN_PATTERN.test(token);

// Manda { title, body, data } a todos los teléfonos del cliente. Los tokens
// que Expo reporta como dados de baja (app desinstalada) se borran.
export const sendPushToCustomer = async (customerId, { title, body, data = {} }) => {
    try {
        if (!customerId) return;
        const customer = await CustomerModel.findById(customerId).select("pushTokens");
        const tokens = (customer?.pushTokens || []).filter(isPushToken);
        if (tokens.length === 0) return;

        const response = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(
                tokens.map((to) => ({ to, title, body, data, sound: "default", channelId: "orders", priority: "high" })),
            ),
            signal: AbortSignal.timeout(10000),
        });
        const result = await response.json().catch(() => null);

        const dead = (result?.data || [])
            .map((ticket, i) => (ticket?.details?.error === "DeviceNotRegistered" ? tokens[i] : null))
            .filter(Boolean);
        if (dead.length > 0) {
            await CustomerModel.updateOne({ _id: customerId }, { $pull: { pushTokens: { $in: dead } } });
        }
    } catch (error) {
        console.error("pushUtils.sendPushToCustomer:", error.message);
    }
};

// Texto del aviso según el nuevo estado del pedido. null = ese estado no avisa.
const orderStatusMessage = (order, status) => {
    const code = order.code ? ` ${order.code}` : "";
    const dineIn = order.fulfillment === "dine_in" || order.orderType === "local";
    switch (status) {
        case "preparing":
            return { title: "Tu pedido está en cocina", body: `Empezamos a preparar tu pedido${code}.` };
        case "ready":
            if (order.isDelivery) return { title: "Tu pedido va en camino", body: `El pedido${code} ya salió hacia tu domicilio.` };
            if (dineIn) return { title: "Tu pedido está listo", body: `El pedido${code} va en camino a tu mesa.` };
            return { title: "Tu pedido está listo", body: `Ya puedes pasar por tu pedido${code}.` };
        case "delivered":
            return { title: "¡Pedido entregado!", body: "¡Buen provecho! Cuéntanos qué tal estuvo: califica tu pedido." };
        case "cancelled":
            return { title: "Pedido cancelado", body: `Tu pedido${code} fue cancelado.` };
        default:
            return null;
    }
};

// Avisa al cliente que su pedido cambió de estado (si el pedido es de un
// cliente con la app). `order.customer` puede venir poblado o como id.
export const notifyOrderStatus = async (order, status) => {
    const customerId = order?.customer?._id || order?.customer;
    const message = orderStatusMessage(order || {}, status);
    if (!customerId || !message) return;
    await sendPushToCustomer(customerId, {
        ...message,
        data: { type: "order_status", orderId: String(order._id), status },
    });
};

export default { isPushToken, sendPushToCustomer, notifyOrderStatus };
