// Cola automática del Sistema de Cocina (KDS).
//
// Regla, solo mientras el admin tiene habilitado el Sistema de Cocina
// (settings.kitchen.enabled):
//   - Si no hay ninguna comanda en cocina ("preparing"/"atrasado"), la
//     siguiente de la cola entra directo a cocina.
//   - Si ya hay una en cocina, el pedido nuevo se queda "pending" (Pendiente).
//   - En cuanto la cocina se vacía (la comanda pasa a Lista, se cancela...),
//     entra sola la siguiente.
//
// Con el sistema apagado no se toca nada: los pedidos siguen el flujo manual
// de siempre (la app de empleados los pasa a preparación con un botón).
//
// "La siguiente" es la que lleva más tiempo esperando que se pueda cocinar:
// un 2º tiempo cuenta desde que el mesero lo marchó y un pedido programado
// desde SCHEDULED_LEAD_MS antes de su hora (o desde que el cliente llegó a su
// mesa, si llegó antes: ya no hay que esperar la hora). Nunca entran los que cocina no
// puede empezar: un 2º tiempo en espera (waiting) ni un pedido cuyo cliente
// está agregando productos (hold), igual que en orderController.updateOrderStatus.
//
// Igual que socket.js y notificationUtils, este módulo NUNCA lanza un error
// hacia quien lo llama: si la cola falla, el pedido se guarda igual y la
// cocina lo puede empezar a mano.
//
// El modelo de pedidos se pide por nombre (mongoose.model) y no se importa,
// porque orderModel importa este archivo para sus hooks.
import mongoose from "mongoose";
import SettingsModel from "../../models/settings/settingsModel.js";
import { WAITER_POPULATE } from "./waiterPopulate.js";
import notificationUtils from "../notifications/notificationUtils.js";
import { notifyOrderStatus } from "../notifications/pushUtils.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";

const ORDERS_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.orders;

// Estados que cuentan como "hay algo en cocina".
export const IN_KITCHEN_STATUSES = ["preparing", "atrasado"];

// Un pedido programado entra a la cola este tiempo antes de su hora, para que
// esté listo cuando llegue el cliente.
export const SCHEDULED_LEAD_MS = 20 * 60 * 1000;

// Espera antes de revisar la cola tras un cambio: si llegan varios cambios
// seguidos (ej. cobrar una mesa actualiza todas sus comandas), se revisa una
// sola vez al final.
const SYNC_DEBOUNCE_MS = 250;

const Order = () => mongoose.model("Order");

// Se lee sin crear el documento (getOrCreateSettings lo crea en la primera
// consulta del panel); si todavía no existe, el sistema está apagado.
export const isKitchenEnabled = async () => {
    const settings = await SettingsModel.findOne().select("kitchen.enabled").lean();
    return Boolean(settings?.kitchen?.enabled);
};

// Desde cuándo un pedido se puede cocinar (ver la nota de arriba).
export const kitchenReadyAt = (order) => {
    // Cliente con reserva que ya llegó: su turno cuenta desde que llegó
    if (order.arrivedAt) return new Date(order.arrivedAt).getTime();
    if (order.scheduledFor) {
        return Math.max(
            new Date(order.createdAt || Date.now()).getTime(),
            new Date(order.scheduledFor).getTime() - SCHEDULED_LEAD_MS,
        );
    }
    return new Date(order.firedAt || order.createdAt || Date.now()).getTime();
};

// Filtro de Mongo de "cocina lo puede empezar ya".
const cookableFilter = (now = Date.now()) => ({
    status: "pending",
    waiting: { $ne: true },
    "hold.active": { $ne: true },
    $or: [
        { scheduledFor: null },
        { scheduledFor: { $lte: new Date(now + SCHEDULED_LEAD_MS) } },
        // Programado, pero el cliente ya llegó a su mesa
        { arrivedAt: { $ne: null } },
    ],
});

const isCookable = (order, now = Date.now()) =>
    order.status === "pending" &&
    !order.waiting &&
    !order.hold?.active &&
    (!order.scheduledFor || Boolean(order.arrivedAt) || new Date(order.scheduledFor).getTime() <= now + SCHEDULED_LEAD_MS);

/**
 * Hook de orderModel (pre "save" de un pedido NUEVO): si el sistema está
 * habilitado, la cocina está libre y nadie más espera turno, el pedido nace
 * directamente "preparing" en vez de "pending".
 */
export const admitNewOrder = async (order) => {
    try {
        if (!isCookable(order)) return;
        if (!(await isKitchenEnabled())) return;

        const busy = await Order().exists({ status: { $in: IN_KITCHEN_STATUSES } });
        if (busy) return;

        // Cocina libre pero con pedidos anteriores esperando (ej. el sistema
        // se acaba de encender): el nuevo no se brinca la fila. La revisión de
        // la cola que dispara el propio guardado meterá al que va primero.
        const waitingBefore = await Order().exists(cookableFilter());
        if (waitingBefore) return;

        const now = new Date();
        order.status = "preparing";
        order.statusHistory.push({ status: "preparing", changedAt: now });
    } catch (error) {
        console.error("kitchenQueueUtils.admitNewOrder:", error);
    }
};

// Mete a cocina la siguiente comanda si la cocina está libre.
export const syncKitchenQueue = async () => {
    try {
        if (!(await isKitchenEnabled())) return null;

        const busy = await Order().exists({ status: { $in: IN_KITCHEN_STATUSES } });
        if (busy) return null;

        const now = Date.now();
        const candidates = await Order().find(cookableFilter(now))
            .select("createdAt firedAt scheduledFor arrivedAt")
            .lean();
        if (candidates.length === 0) return null;

        const next = candidates.reduce((first, order) =>
            kitchenReadyAt(order) < kitchenReadyAt(first) ? order : first);

        // Se vuelve a exigir el filtro completo en la misma operación: si en
        // este instante alguien la empezó a mano o el cliente la pausó, no se toca.
        const promoted = await Order().findOneAndUpdate(
            { _id: next._id, ...cookableFilter(now) },
            {
                $set: { status: "preparing" },
                $push: { statusHistory: { status: "preparing", changedAt: new Date(now) } },
            },
            { new: true },
        ).populate("table", "number status")
         .populate(WAITER_POPULATE)
         .populate("customer", "personalInfo");

        if (!promoted) return null;

        emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: promoted.toObject() });
        // El cliente de la app se entera de que su pedido ya se está
        // preparando, igual que cuando cocina lo empieza a mano.
        notifyOrderStatus(promoted, "preparing").catch((error) =>
            console.error("kitchenQueueUtils.notifyOrderStatus:", error));

        return promoted;
    } catch (error) {
        console.error("kitchenQueueUtils.syncKitchenQueue:", error);
        return null;
    }
};

// Las revisiones se encadenan (nunca corren dos a la vez en este proceso) y
// se agrupan con un pequeño retraso. Así dos cambios simultáneos no pueden
// meter dos comandas a cocina por ver ambos la cocina libre al mismo tiempo.
let pendingTimer = null;
let running = Promise.resolve();

export const requestKitchenSync = () => {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
        running = running.then(syncKitchenQueue);
    }, SYNC_DEBOUNCE_MS);
};

export default {
    IN_KITCHEN_STATUSES,
    SCHEDULED_LEAD_MS,
    isKitchenEnabled,
    kitchenReadyAt,
    admitNewOrder,
    syncKitchenQueue,
    requestKitchenSync,
};
