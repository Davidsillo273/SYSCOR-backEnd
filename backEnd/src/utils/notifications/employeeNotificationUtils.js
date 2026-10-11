import EmployeeNotification from "../../models/notifications/employeeNotificationModel.js";
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

const orderLabel = (order) =>
    order.kitchenNumber ? `#${order.kitchenNumber}` : order.code ? `#${order.code}` : "";

// Cocina terminó una comanda: avisa al mesero que la tomó, para que la lleve
// a la mesa. `order` viene con table y waiter poblados (applyOrderStatus).
export const notifyWaiterOrderReady = (order) => {
    const waiterId = order?.waiter?._id || order?.waiter;
    if (!waiterId || order.isDelivery) return;
    const tableNumber = order.table?.number;
    const where = tableNumber ? `Mesa ${tableNumber}` : order.localCustomerName || "Para llevar";
    const label = orderLabel(order);
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
