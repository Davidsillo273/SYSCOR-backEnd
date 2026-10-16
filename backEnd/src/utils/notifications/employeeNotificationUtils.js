import EmployeeNotification from "../../models/notifications/employeeNotificationModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { emitToUser, SOCKET_EVENTS } from "../../config/socket.js";
import { sendPushToEmployee } from "./pushUtils.js";

// Aviso personal a un empleado: queda en su bandeja de la app, le llega al
// momento si la tiene abierta (tiempo real) y como push si está cerrada.
//
// Igual que los push, un aviso que no sale nunca debe romper lo que lo
// disparó: los errores se registran y se ignoran. No hace falta esperarlo.
export const notifyEmployee = async (employeeId, { type, title, body, data = {} }) => {
    if (!employeeId) return;
    const payload = { type, ...data };
    let notificationId = null;
    try {
        const notification = await EmployeeNotification.create({
            employee: employeeId,
            type,
            title,
            body,
            data: payload,
        });
        notificationId = String(notification._id);
        emitToUser(employeeId, SOCKET_EVENTS.EMPLOYEE_NOTIFICATION, { notification: notification.toObject() });
    } catch (error) {
        console.error("employeeNotificationUtils.notifyEmployee:", error.message);
    }
    // Con el id, al tocar el push la app lo marca como leído en la bandeja.
    await sendPushToEmployee(employeeId, { title, body, data: { ...payload, notificationId } });
};

export const notifyActiveWaiters = async (notification) => {
    const waiters = await EmployeeModel.find({
        "personalInfo.type": "waiter",
        "workInfo.status": "active",
    }).select("_id").lean();
    await Promise.all(waiters.map(({ _id }) => notifyEmployee(_id, notification)));
    return waiters.length;
};

const orderLabel = (order) =>
    order.kitchenNumber ? `#${order.kitchenNumber}` : order.code ? `#${order.code}` : "";

// Cocina terminó una comanda: avisa al mesero que la tomó o, si es una
// reservación de la app que aún no tiene mesero asignado, a los meseros activos.
export const notifyWaiterOrderReady = (order) => {
    if (order?.isDelivery) return;
    const label = orderLabel(order);
    const reservation = order?.reservation;
    const reservationTable = reservation?.table;
    const table = order?.table?.number ? order.table : reservationTable;
    const isAppReservation = order?.orderType === "online" && order?.fulfillment === "dine_in";

    if (isAppReservation) {
        const tableId = order.table?._id || reservationTable?._id || reservationTable || null;
        const tableNumber = table?.number;
        const guest = reservation?.displayName || reservation?.alias;
        const where = tableNumber
            ? `Mesa ${tableNumber}${guest ? ` · ${guest}` : ""}`
            : `La reserva${guest ? ` de ${guest}` : ""}`;
        return notifyActiveWaiters({
            type: "order_ready",
            title: tableNumber ? `Comanda lista · Mesa ${tableNumber}` : "Comanda lista para una reserva",
            body: `${where}: la comanda${label ? ` ${label}` : ""} ya salió de cocina. Pasa a recogerla.`,
            data: {
                orderId: String(order._id),
                tableId: tableId ? String(tableId) : null,
            },
        });
    }

    const waiterId = order?.waiter?._id || order?.waiter;
    if (!waiterId) return;
    const tableNumber = order.table?.number;
    const where = tableNumber ? `Mesa ${tableNumber}` : order.localCustomerName || "Para llevar";
    return notifyEmployee(waiterId, {
        type: "order_ready",
        title: tableNumber ? `Comanda lista · Mesa ${tableNumber}` : "Comanda lista",
        body: `${where}: la comanda${label ? ` ${label}` : ""} ya salió de cocina. Pasa a recogerla.`,
        data: {
            orderId: String(order._id),
            tableId: order.table?._id ? String(order.table._id) : null,
        },
    });
};

export default { notifyEmployee, notifyWaiterOrderReady };
