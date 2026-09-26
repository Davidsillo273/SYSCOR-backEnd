// Datos que Panchita arma para el cliente: sus pedidos, "lo de siempre" y los
// mensajes sugeridos para el repartidor. Todo se consulta siempre con el id
// del cliente de la sesión, nunca con uno que venga del chat.
import Order from "../../models/orders/orderModel.js";
import Combos from "../../models/menu/combosModel.js";
import Drinks from "../../models/menu/drinksModel.js";
import Saucers from "../../models/menu/saucersModel.js";
import Extras from "../../models/menu/extrasModel.js";
import { targetsForProduct, extraFitsProduct } from "../extras/extraTargetsUtils.js";

export const ACTIVE_ORDER_STATUSES = ["pending", "preparing", "ready", "atrasado"];

export const STATUS_LABELS = {
    pending: "Recibido",
    preparing: "En preparación",
    ready: "Listo",
    atrasado: "Con retraso",
    delivered: "Entregado",
    cancelled: "Cancelado",
};

export const shortId = (id) => String(id).slice(-6).toUpperCase();

// Resumen corto de un pedido, para el chat y para la app.
export const summarizeOrder = (order) => ({
    id: order._id,
    shortId: shortId(order._id),
    status: order.status,
    statusLabel: STATUS_LABELS[order.status] || order.status,
    orderType: order.orderType,
    isDelivery: !!order.isDelivery,
    deliveryAddress: order.deliveryAddress || null,
    total: order.total,
    createdAt: order.createdAt,
    items: (order.items || []).map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
    driverMessages: (order.driverMessages || []).map((m) => ({ text: m.text, createdAt: m.createdAt })),
});

// Resuelve "mi pedido", "el de ayer" o un número corto (#A1B2C3) a un pedido
// del cliente. Sin referencia: el activo más reciente, o el último entregado.
export const findCustomerOrder = async (customerId, reference) => {
    const ref = String(reference || "").replace("#", "").trim().toLowerCase();
    if (/^[0-9a-f]{24}$/.test(ref)) {
        return Order.findOne({ _id: ref, customer: customerId });
    }
    const recent = await Order.find({ customer: customerId }).sort({ createdAt: -1 }).limit(30);
    if (/^[0-9a-f]{6}$/.test(ref)) {
        return recent.find((o) => String(o._id).slice(-6).toLowerCase() === ref) || null;
    }
    return recent.find((o) => ACTIVE_ORDER_STATUSES.includes(o.status)) || recent[0] || null;
};

const MODELS = { combo: Combos, drink: Drinks, saucer: Saucers };
const ACTIVE_STATUS_WORDS = ["disponible", "activo", "active"];
const isActive = (doc) => ACTIVE_STATUS_WORDS.includes(String(doc?.status || "").toLowerCase());

// Firma de un pedido: qué productos y cuántos, sin importar el orden.
const signatureOf = (order) =>
    (order.items || [])
        .filter((i) => i.itemType !== "extra")
        .map((i) => `${i.itemType}:${i.itemId}:${i.quantity}`)
        .sort()
        .join("|");

// "Lo de siempre": la combinación que más ha repetido el cliente (si la pidió
// al menos 2 veces); si no, su último pedido. Devuelve los productos listos
// para el carrito de la app, con el precio de HOY y sin los que ya no están.
export const usualOrder = async (customerId) => {
    const orders = await Order.find({ customer: customerId, status: { $ne: "cancelled" } })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    if (orders.length === 0) return null;

    const counts = new Map();
    for (const order of orders) {
        const sig = signatureOf(order);
        if (!sig) continue;
        counts.set(sig, (counts.get(sig) || 0) + 1);
    }
    const [bestSig, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    const isHabit = bestCount >= 2;
    const source = isHabit ? orders.find((o) => signatureOf(o) === bestSig) : orders[0];

    const items = [];
    const unavailable = [];
    let parent = null;

    for (const line of source.items || []) {
        if (line.itemType === "extra") {
            // Los extras van pegados al producto de la línea anterior.
            const extra = await Extras.findById(line.itemId).select("name price status appliesTo").lean();
            // Solo si hoy le corresponde a ese producto (ver extraTargetsUtils).
            if (parent && extra && isActive(extra) && extraFitsProduct(extra, parent.targets)) {
                parent.selectedExtras.push({ extraId: extra._id, name: extra.name, price: extra.price });
                parent.unitPrice += Number(extra.price) || 0;
                parent.totalPrice = parent.unitPrice * parent.quantity;
            }
            continue;
        }
        const model = MODELS[line.itemType];
        let query = model ? model.findById(line.itemId).select("name price status image category saucers selectiveOptions") : null;
        if (query && line.itemType === "combo") {
            query = query.populate("saucers.saucerId", "category").populate("selectiveOptions.saucerId", "category");
        }
        const product = query ? await query.lean() : null;
        if (!product || !isActive(product)) {
            unavailable.push(line.name);
            parent = null;
            continue;
        }
        parent = {
            productType: line.itemType,
            productId: product._id,
            name: product.name,
            imageUrl: product.image || null,
            quantity: line.quantity || 1,
            unitPrice: Number(product.price) || 0,
            totalPrice: (Number(product.price) || 0) * (line.quantity || 1),
            selectedDrinkId: null,
            selectedSauces: [],
            selectedSelectiveItems: [],
            selectedExtras: [],
        };
        items.push(parent);
        // Se guarda aparte (no viaja a la app) para validar sus extras.
        Object.defineProperty(parent, "targets", { value: targetsForProduct(line.itemType, product), enumerable: false });
    }

    return {
        label: isHabit ? "Lo de siempre" : "Tu último pedido",
        timesOrdered: isHabit ? bestCount : 1,
        items,
        unavailable,
        total: Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100,
    };
};

// Mensajes de un toque para el repartidor. Los fijos siempre están; Panchita
// agrega los que tienen sentido según el momento (lluvia, noche, retraso).
const BASE_DRIVER_MESSAGES = [
    "Déjalo en la recepción, por favor.",
    "El timbre no funciona, llámame al llegar.",
    "Toca el portón, por favor.",
    "Ya voy bajando.",
    "Déjalo con el vigilante.",
    "Estoy en camino a recibirlo, espérame un momento.",
];

export const suggestDriverMessages = (order, eta) => {
    const contextual = [];
    if (eta?.raining) contextual.push("Si llueve, déjalo bajo techo, por favor.");
    if (eta?.risk === "high") contextual.push("No te preocupes por la demora, aquí te espero.");
    const hour = (new Date().getUTCHours() + 18) % 24; // hora de El Salvador (UTC-6)
    if (hour >= 18) contextual.push("La casa tiene la luz de afuera encendida.");
    return [...contextual, ...BASE_DRIVER_MESSAGES].slice(0, 8);
};

export default {
    ACTIVE_ORDER_STATUSES,
    STATUS_LABELS,
    shortId,
    summarizeOrder,
    findCustomerOrder,
    usualOrder,
    suggestDriverMessages,
};
