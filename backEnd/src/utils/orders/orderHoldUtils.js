// "Agregar más productos": el cliente pausa su pedido en línea mientras sigue
// "Recibido" para sumarle productos y pagarlos. Lo agregado vive en el
// carrito de la app hasta que se paga; entonces checkoutController lo suma
// al mismo pedido y la pausa termina. Si no paga a tiempo, la app borra lo
// agregado (en el servidor no hay nada que borrar).
//
// Reglas:
//   - Solo mientras el pedido está en "pending" y es en línea.
//   - Dura HOLD_MS; al terminar vuelve solo a la cola (releaseExpiredHolds).
//   - Una sola vez por pedido (hold.used).
//   - Mientras está en espera, cocina no lo puede pasar a preparación
//     (orderController.updateOrderStatus); los pedidos de atrás sí avanzan.
//   - El estado sigue siendo "pending": el pedido conserva su lugar original
//     en la cola (se ordena por fecha de creación), así el cliente no pierde
//     turno por pausar.
import Order from "../../models/orders/orderModel.js";
import Checkout from "../../models/orders/checkoutModel.js";
import notificationUtils from "../notifications/notificationUtils.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";

export const HOLD_MS = 10 * 60 * 1000;
// Margen extra para un pago de lo agregado que ya empezó cuando se acabó el tiempo.
const PAYMENT_GRACE_MS = 5 * 60 * 1000;

const ORDERS_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.orders;

// ¿Está en espera ahora mismo? (una pausa vencida cuenta como terminada
// aunque la limpieza todavía no haya pasado).
export const isOnHold = (order, now = Date.now()) =>
    !!order?.hold?.active && new Date(order.hold.until).getTime() > now;

export const canHold = (order) =>
    order.orderType === "online" && order.status === "pending" && !order.hold?.used;

// Lo que ven la app y el panel de la pausa.
export const publicHold = (order) => ({
    active: isOnHold(order),
    until: isOnHold(order) ? order.hold.until : null,
    used: !!order.hold?.used,
});

// Filtro de Mongo para "cocina lo puede empezar" (sirve para cambiar el
// estado de forma atómica: si el cliente pausa en el mismo instante, no se
// cocina). Usa la marca guardada y no la hora: una pausa vencida sigue
// bloqueando si el pago de lo agregado va en curso (releaseExpiredHolds la
// deja activa unos minutos más).
export const notOnHoldFilter = () => ({ "hold.active": { $ne: true } });

export const emitOrder = async (orderId) => {
    const populated = await Order.findById(orderId)
        .populate("table", "number status")
        .populate("waiter", "name lastname")
        .populate("customer", "personalInfo");
    if (populated) emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: populated.toObject() });
    return populated;
};

// Termina las pausas vencidas y avisa al panel para que el pedido vuelva a
// verse normal. Se llama al listar pedidos y cada minuto desde index.js.
export const releaseExpiredHolds = async () => {
    const now = new Date();
    const expired = await Order.find({ "hold.active": true, "hold.until": { $lte: now } }).select("_id");
    for (const { _id } of expired) {
        // Si el pago de lo agregado va en curso (verificación del banco), se
        // espera hasta PAYMENT_GRACE_MS más para no cocinar sin lo agregado.
        const paying = await Checkout.exists({
            addToOrder: _id,
            status: { $in: ["pending", "processing"] },
            createdAt: { $gte: new Date(now.getTime() - PAYMENT_GRACE_MS) },
        });
        if (paying) continue;
        const updated = await Order.findOneAndUpdate(
            { _id, "hold.active": true },
            { $set: { "hold.active": false, "hold.releasedAt": now, "hold.releasedBy": "timeout" } },
        );
        if (updated) await emitOrder(_id);
    }
};

export default { HOLD_MS, isOnHold, canHold, publicHold, notOnHoldFilter, releaseExpiredHolds, emitOrder };
