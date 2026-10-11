// Solicitudes desde la página de la mesa: pedir la cuenta o llamar al mesero.
//
// 1. El cliente escanea el QR y pide algo. Se le avisa al mesero de la mesa
//    (push, tiempo real y su bandeja de la app).
// 2. Si en 30 s nadie toca "Voy", pasa a todos los meseros activos. Si la mesa
//    no tiene mesero, va a todos desde el inicio. La propina no escala: es
//    para su mesero.
// 3. El primero que toca "Voy" se la queda; a los demás se les quita el aviso.
// 4. El mesero la marca como atendida (o se cierra sola a los 10 min).
//
// El estado vive en la base, no en temporizadores: sweepTableRequests (cada
// pocos segundos, ver index.js) escala y limpia, aunque el servidor se haya
// reiniciado en medio.
import TableRequest, {
    ACTIVE_REQUEST_STATUSES,
    OPEN_REQUEST_STATUSES,
    PAY_METHODS,
    REQUEST_REASONS,
} from "../../models/tables/tableRequestModel.js";
import TablesModel from "../../models/tables/tablesModel.js";
import Order from "../../models/orders/orderModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import EmployeeNotification from "../../models/notifications/employeeNotificationModel.js";
import { WAITER_POPULATE } from "../orders/waiterPopulate.js";
import { notifyEmployee } from "../notifications/employeeNotificationUtils.js";
import { emitToTypes, SOCKET_EVENTS } from "../../config/socket.js";

export const ESCALATE_AFTER_MS = 30 * 1000;
// Entre una solicitud y la siguiente de la misma mesa.
export const REQUEST_COOLDOWN_MS = 45 * 1000;
// Una solicitud con "Voy" que nadie marcó como atendida se cierra sola.
const AUTO_RESOLVE_MS = 10 * 60 * 1000;

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const firstName = (fullName) => String(fullName || "").trim().split(/\s+/)[0] || null;

// Mesero de la mesa: el de su comanda más reciente en la ocupación actual.
export const assignedWaiterOf = async (table) => {
    const filter = { orderType: "local", table: table._id, waiter: { $ne: null }, status: { $ne: "cancelled" } };
    if (table.occupiedAt) filter.createdAt = { $gte: table.occupiedAt };
    const order = await Order.findOne(filter).sort({ createdAt: -1 }).select("waiter").populate(WAITER_POPULATE).lean();
    if (!order?.waiter?._id) return null;
    return { id: order.waiter._id, name: `${order.waiter.name || ""} ${order.waiter.lastname || ""}`.trim() || null };
};

const activeWaiterIds = async () => {
    const waiters = await EmployeeModel.find({ "personalInfo.type": "waiter", "workInfo.status": "active" })
        .select("_id")
        .lean();
    return waiters.map((w) => w._id);
};

// Lo que ve el cliente en la página de la mesa: nada de ids de empleados.
export const publicRequest = (request) =>
    request
        ? {
              id: String(request._id),
              type: request.type,
              status: request.status,
              reason: request.reason,
              payMethod: request.payMethod,
              // Quién viene (si ya tocó "Voy") o a quién se le avisó.
              waiterName: firstName(request.acknowledgedBy?.name || request.assignedWaiterName),
              acknowledged: request.status === "acknowledged",
              escalated: !!request.escalatedAt || (!request.assignedWaiter && request.status !== "acknowledged"),
              escalateAt: request.escalateAt,
              createdAt: request.createdAt,
          }
        : null;

// Lo que ve el mesero en la app.
export const staffRequest = (request) => ({
    _id: String(request._id),
    table: String(request.table),
    tableNumber: request.tableNumber,
    type: request.type,
    status: request.status,
    reason: request.reason,
    reasonLabel: request.reason ? REQUEST_REASONS[request.reason] : null,
    payMethod: request.payMethod,
    payMethodLabel: request.payMethod ? PAY_METHODS[request.payMethod] : null,
    assignedWaiter: request.assignedWaiter ? String(request.assignedWaiter) : null,
    assignedWaiterName: request.assignedWaiterName,
    escalated: !!request.escalatedAt,
    escalateAt: request.escalateAt,
    acknowledgedBy: request.acknowledgedBy?.id
        ? { id: String(request.acknowledgedBy.id), name: request.acknowledgedBy.name, at: request.acknowledgedBy.at }
        : null,
    createdAt: request.createdAt,
});

const announce = (request) =>
    emitToTypes(["waiter"], SOCKET_EVENTS.TABLE_REQUEST_CHANGED, { request: staffRequest(request) });

// Texto del aviso al mesero.
const messageFor = (request, { escalated = false } = {}) => {
    const table = `Mesa ${request.tableNumber}`;
    const detail = request.type === "bill" ? PAY_METHODS[request.payMethod] : REQUEST_REASONS[request.reason];
    const title = request.type === "bill" ? `${table} pide la cuenta` : escalated ? `${table} necesita un mesero` : `${table} te llama`;
    const prefix = escalated && request.assignedWaiterName ? `${firstName(request.assignedWaiterName)} no ha respondido. ` : "";
    return { title, body: `${prefix}${detail || ""}`.trim() };
};

const notifyWaiters = (request, employeeIds, options) => {
    const { title, body } = messageFor(request, options);
    return Promise.all(
        employeeIds.map((id) =>
            notifyEmployee(id, {
                type: "table_request",
                title,
                body,
                data: { requestId: String(request._id), tableId: String(request.table), tableNumber: request.tableNumber },
            }),
        ),
    );
};

// Crea la solicitud y avisa. Las validaciones de la página (mesa ocupada,
// una a la vez, espera entre solicitudes) las hace el controller.
export const createTableRequest = async ({ table, type, reason = null, payMethod = null }) => {
    const waiter = await assignedWaiterOf(table);
    // Sin mesero no hay a quién esperar; la propina espera a su mesero.
    const escalates = !!waiter && !(type === "waiter" && reason === "tip");
    const request = await TableRequest.create({
        table: table._id,
        tableNumber: table.number,
        occupiedAt: table.occupiedAt || null,
        type,
        reason: type === "waiter" ? reason : null,
        payMethod: type === "bill" ? payMethod : null,
        assignedWaiter: waiter?.id || null,
        assignedWaiterName: waiter?.name || null,
        escalateAt: escalates ? new Date(Date.now() + ESCALATE_AFTER_MS) : null,
    });
    announce(request);
    const recipients = waiter ? [waiter.id] : await activeWaiterIds();
    notifyWaiters(request, recipients).catch((error) => console.error("tableRequest.notify:", error.message));
    return request;
};

// Pasa a todos los meseros las que nadie atendió a tiempo.
const escalateDueRequests = async () => {
    const due = await TableRequest.find({ status: "pending", escalateAt: { $ne: null, $lte: new Date() } }).lean();
    if (due.length === 0) return;
    const waiters = await activeWaiterIds();
    for (const candidate of due) {
        const request = await TableRequest.findOneAndUpdate(
            { _id: candidate._id, status: "pending" },
            { $set: { status: "escalated", escalatedAt: new Date() } },
            { returnDocument: "after" },
        ).lean();
        if (!request) continue;
        announce(request);
        const others = waiters.filter((id) => !sameId(id, request.assignedWaiter));
        notifyWaiters(request, others, { escalated: true }).catch((error) =>
            console.error("tableRequest.escalate:", error.message),
        );
    }
};

// "Voy": el primero que la toma se la queda. Devuelve { request } o { error }.
export const acknowledgeTableRequest = async (requestId, employee) => {
    const request = await TableRequest.findOneAndUpdate(
        { _id: requestId, status: { $in: OPEN_REQUEST_STATUSES } },
        { $set: { status: "acknowledged", acknowledgedBy: { id: employee.id, name: employee.name, at: new Date() } } },
        { returnDocument: "after" },
    ).lean();
    if (!request) {
        const current = await TableRequest.findById(requestId).lean();
        if (!current) return { error: { code: 404, title: "Ya no existe", message: "Esa solicitud ya no existe." } };
        const who = current.acknowledgedBy?.name ? `${firstName(current.acknowledgedBy.name)} ya va.` : "Ya no está pendiente.";
        return { error: { code: 409, title: "Ya la atendieron", message: who }, request: current };
    }
    // A los demás se les quita el aviso; el de quien la tomó queda leído.
    await Promise.all([
        EmployeeNotification.deleteMany({ type: "table_request", "data.requestId": String(request._id), employee: { $ne: employee.id } }),
        EmployeeNotification.updateMany(
            { type: "table_request", "data.requestId": String(request._id), employee: employee.id, readAt: null },
            { $set: { readAt: new Date() } },
        ),
    ]).catch((error) => console.error("tableRequest.acknowledge inbox:", error.message));
    announce(request);
    return { request };
};

// El mesero la atendió.
export const resolveTableRequest = async (requestId) => {
    const request = await TableRequest.findOneAndUpdate(
        { _id: requestId, status: { $in: ACTIVE_REQUEST_STATUSES } },
        { $set: { status: "resolved", resolvedAt: new Date() } },
        { returnDocument: "after" },
    ).lean();
    if (request) announce(request);
    return request;
};

// El cliente la canceló desde la página.
export const cancelTableRequest = async (requestId, tableId) => {
    const request = await TableRequest.findOneAndUpdate(
        { _id: requestId, table: tableId, status: { $in: OPEN_REQUEST_STATUSES } },
        { $set: { status: "cancelled" } },
        { returnDocument: "after" },
    ).lean();
    if (request) {
        await EmployeeNotification.deleteMany({ type: "table_request", "data.requestId": String(request._id) }).catch(() => {});
        announce(request);
    }
    return request;
};

// Solicitudes que le tocan a este mesero ahora: las de sus mesas, las que ya
// son de todos y las que él tomó.
export const requestsForWaiter = async (employeeId) => {
    const requests = await TableRequest.find({
        $or: [
            { status: "escalated" },
            { status: "pending", assignedWaiter: null },
            { status: "pending", assignedWaiter: employeeId },
            { status: "acknowledged", "acknowledgedBy.id": employeeId },
        ],
    })
        .sort({ createdAt: 1 })
        .lean();
    return requests.map(staffRequest);
};

// Revisión periódica: escala, cierra las viejas y cancela las de mesas que
// ya se liberaron (o que se volvieron a ocupar con otros clientes).
export const sweepTableRequests = async () => {
    await escalateDueRequests();

    const stale = await TableRequest.find({
        status: "acknowledged",
        "acknowledgedBy.at": { $lte: new Date(Date.now() - AUTO_RESOLVE_MS) },
    }).select("_id").lean();
    for (const { _id } of stale) await resolveTableRequest(_id);

    const active = await TableRequest.find({ status: { $in: ACTIVE_REQUEST_STATUSES } }).select("table occupiedAt").lean();
    if (active.length === 0) return;
    const tables = await TablesModel.find({ _id: { $in: active.map((r) => r.table) } }).select("status occupiedAt").lean();
    const byId = new Map(tables.map((t) => [String(t._id), t]));
    for (const request of active) {
        const table = byId.get(String(request.table));
        const sameVisit =
            table?.status === "ocupada" &&
            String(table.occupiedAt?.getTime?.() ?? "") === String(request.occupiedAt?.getTime?.() ?? "");
        if (sameVisit) continue;
        const closed = await TableRequest.findOneAndUpdate(
            { _id: request._id, status: { $in: ACTIVE_REQUEST_STATUSES } },
            { $set: { status: "cancelled" } },
            { returnDocument: "after" },
        ).lean();
        if (closed) {
            await EmployeeNotification.deleteMany({ type: "table_request", "data.requestId": String(closed._id) }).catch(() => {});
            announce(closed);
        }
    }
};

export default {
    createTableRequest,
    acknowledgeTableRequest,
    resolveTableRequest,
    cancelTableRequest,
    requestsForWaiter,
    sweepTableRequests,
    assignedWaiterOf,
    publicRequest,
    staffRequest,
};
