// Reglas para resolver los reclamos que levanta Panchita.
//
// La IA NUNCA decide si se devuelve dinero: solo junta los datos (qué pedido,
// qué pasó, qué productos) y los manda aquí. Estas reglas son las que
// aprueban al instante o mandan el caso a revisión de un admin.
import Claim from "../../models/orders/claimModel.js";
import Order from "../../models/orders/orderModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import notificationUtils from "../notifications/notificationUtils.js";
import { logWalletMovement, orderRef as walletOrderRef } from "../wallet/walletUtils.js";

// Hasta cuánto se aprueba sin que lo vea una persona.
export const AUTO_APPROVE_LIMIT = 10;
// Cuántos reclamos aprobados en automático puede tener un cliente por mes.
const MAX_AUTO_PER_30_DAYS = 2;
// Cuánto tiempo después de entregado se puede reclamar.
const CLAIM_WINDOW_HOURS = 24;
// Un pedido "tardó demasiado" si pasó más de esto entre pedirlo y recibirlo.
const LATE_THRESHOLD_MINUTES = { delivery: 60, pickup: 40 };

export const CLAIM_TYPE_LABELS = {
    missing_item: "Faltó un producto",
    wrong_item: "Llegó un producto equivocado",
    quality: "Problema con la calidad",
    late: "El pedido llegó tarde",
    other: "Otro problema",
    cancelled: "Pedido cancelado",
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const normalize = (text) =>
    String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

const changedAt = (order, status) =>
    [...(order.statusHistory || [])].reverse().find((h) => h.status === status)?.changedAt;

// Busca en el pedido los productos que el cliente dice (por nombre, sin
// importar tildes ni mayúsculas) y calcula cuánto valen. Nunca más de lo que
// se pidió.
const matchItems = (order, claimedItems = []) => {
    const lines = (order.items || []).map((line) => ({ ...line, remaining: line.quantity || 1 }));
    const matched = [];

    for (const claimed of claimedItems.slice(0, 20)) {
        const wanted = normalize(claimed?.name);
        if (!wanted) continue;
        const line = lines.find(
            (l) => l.remaining > 0 && (normalize(l.name).includes(wanted) || wanted.includes(normalize(l.name))),
        );
        if (!line) continue;
        const quantity = Math.min(Math.max(parseInt(claimed.quantity, 10) || 1, 1), line.remaining);
        line.remaining -= quantity;
        matched.push({ name: line.name, quantity, amount: round2((Number(line.price) || 0) * quantity) });
    }
    return matched;
};

// Decide un reclamo nuevo. Devuelve { claim, created } o { error }.
export const fileClaim = async ({ req, customerId, orderId, type, items, description, resolution }) => {
    if (!CLAIM_TYPE_LABELS[type]) return { error: "Ese tipo de problema no existe." };

    const order = await Order.findOne({ _id: orderId, customer: customerId });
    if (!order) return { error: "No encontré ese pedido en tu cuenta." };
    if (order.orderType !== "online") {
        return { error: "Los pedidos que se hicieron en el local se atienden ahí mismo con el personal." };
    }
    if (order.status === "cancelled") return { error: "Ese pedido está cancelado." };

    // Un reclamo por pedido: si ya existe, se informa el que hay.
    const existing = await Claim.findOne({ order: order._id });
    if (existing) return { claim: existing, created: false };

    const wantsCard = resolution === "card_refund" && order.paymentStatus === "paid" && order.payment?.provider === "wompi";
    let amount = 0;
    let matched = [];
    let reviewReason = null;

    const deliveredAt = changedAt(order, "delivered");
    const hoursSinceDelivery = deliveredAt ? (Date.now() - new Date(deliveredAt)) / 3600000 : null;

    if (type === "late") {
        const end = deliveredAt ? new Date(deliveredAt) : new Date();
        const minutes = (end - new Date(order.createdAt)) / 60000;
        const limit = LATE_THRESHOLD_MINUTES[order.isDelivery ? "delivery" : "pickup"];
        if (minutes < limit) {
            return {
                error: `Tu pedido lleva ${Math.round(minutes)} min: todavía está dentro del tiempo normal (${limit} min). Si pasa de ahí, con gusto lo reviso.`,
            };
        }
        // Compensación por retraso: 10% del pedido, entre $1 y $3, solo como saldo.
        amount = round2(Math.min(Math.max(order.total * 0.1, 1), 3));
    } else {
        if (order.status !== "delivered") {
            return { error: "Podrás reportarlo en cuanto el pedido aparezca como entregado." };
        }
        if (hoursSinceDelivery !== null && hoursSinceDelivery > CLAIM_WINDOW_HOURS) {
            reviewReason = `Pasaron más de ${CLAIM_WINDOW_HOURS} horas desde la entrega; lo revisará una persona del equipo.`;
        }
        if (type === "other") {
            reviewReason = reviewReason || "Lo revisará una persona del equipo para darte la mejor solución.";
        } else {
            matched = matchItems(order, items);
            if (matched.length === 0) {
                reviewReason = reviewReason || "No pude identificar los productos en tu pedido; lo revisará una persona del equipo.";
            }
            const value = matched.reduce((sum, m) => sum + m.amount, 0);
            // Calidad: se reconoce la mitad de lo afectado.
            amount = round2(type === "quality" ? value * 0.5 : value);
        }
    }

    amount = Math.min(amount, round2(order.total));

    if (!reviewReason && amount > AUTO_APPROVE_LIMIT) {
        reviewReason = `El monto supera los $${AUTO_APPROVE_LIMIT} que puedo aprobar sola; lo revisará una persona del equipo.`;
    }
    if (!reviewReason) {
        const since = new Date(Date.now() - 30 * 24 * 3600000);
        const recentAuto = await Claim.countDocuments({
            customer: customerId,
            decidedBy: "panchita",
            status: { $in: ["approved", "pending_refund", "refunded"] },
            createdAt: { $gte: since },
        });
        if (recentAuto >= MAX_AUTO_PER_30_DAYS) {
            reviewReason = "Ya tuviste varios reclamos este mes; este lo revisará una persona del equipo.";
        }
    }

    // El retraso solo se compensa con saldo: no hubo un producto que devolver.
    const finalResolution = type === "late" ? "credit" : wantsCard ? "card_refund" : "credit";
    let status;
    let reason;
    if (reviewReason) {
        status = "in_review";
        reason = reviewReason;
    } else if (finalResolution === "card_refund") {
        status = "pending_refund";
        reason = `Aprobado. El reembolso de $${amount.toFixed(2)} a tu tarjeta lo procesa el equipo; puede tardar unos días hábiles en verse según tu banco.`;
    } else {
        status = "approved";
        reason = `Aprobado. Te abonamos $${amount.toFixed(2)} de saldo a favor para tu próximo pedido.`;
    }

    let claim;
    try {
        claim = await Claim.create({
            customer: customerId,
            order: order._id,
            type,
            items: matched,
            description: String(description || "").slice(0, 500),
            amount,
            resolution: finalResolution,
            status,
            decidedBy: "panchita",
            reason,
            resolvedAt: status === "approved" ? new Date() : null,
        });
    } catch (error) {
        // Índice único por pedido: otra petición lo creó al mismo tiempo.
        if (error?.code === 11000) return { claim: await Claim.findOne({ order: order._id }), created: false };
        throw error;
    }

    if (status === "approved" && amount > 0) {
        await CustomerModel.updateOne({ _id: customerId }, { $inc: { "wallet.balance": amount } });
        await logWalletMovement({
            customer: customerId,
            type: "claim_credit",
            amount,
            description: `Reclamo del pedido ${walletOrderRef(order._id)}: ${CLAIM_TYPE_LABELS[type] || "reclamo"}`,
            order: order._id,
            claim: claim._id,
        });
    }

    // Lo que necesita a una persona le llega al panel.
    if (status === "in_review" || status === "pending_refund") {
        const orderRef = String(order._id).slice(-6).toUpperCase();
        await notificationUtils.createNotification({
            req,
            category: "orders",
            action: status === "in_review" ? "claim_review" : "claim_refund",
            title: status === "in_review" ? "Reclamo por revisar" : "Reembolso pendiente",
            message: (actor) =>
                status === "in_review"
                    ? `${actor.name} reportó "${CLAIM_TYPE_LABELS[type]}" en el pedido #${orderRef}. Necesita revisión.`
                    : `Panchita aprobó un reembolso de $${amount.toFixed(2)} a tarjeta para el pedido #${orderRef}. Hazlo desde el panel de Wompi y márcalo como reembolsado.`,
            icon: "receipt",
            severity: "warning",
            entity: { model: "Claim", id: claim._id, label: `Pedido #${orderRef}` },
        });
    }

    return { claim, created: true };
};

// Lo que el cliente ve de un reclamo.
export const toPublicClaim = (claim) => ({
    id: claim._id,
    orderId: claim.order,
    type: claim.type,
    typeLabel: CLAIM_TYPE_LABELS[claim.type],
    items: claim.items,
    amount: claim.amount,
    resolution: claim.resolution,
    status: claim.status,
    reason: claim.reason,
    createdAt: claim.createdAt,
});

export default { fileClaim, toPublicClaim, AUTO_APPROVE_LIMIT, CLAIM_TYPE_LABELS };
