import CashierWaiterCall from "../../models/cashier/cashierWaiterCallModel.js";
import CashSession from "../../models/cashier/cashSessionModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import EmployeeNotification from "../../models/notifications/employeeNotificationModel.js";
import { emitToUser, SOCKET_EVENTS } from "../../config/socket.js";
import { notifyEmployee } from "../notifications/employeeNotificationUtils.js";

export const CASHIER_WAITER_RESPONSE_MS = 30 * 1000;

const activeWaiters = async (excluded = []) => EmployeeModel.find({
    "personalInfo.type": "waiter",
    "workInfo.status": "active",
    _id: { $nin: excluded },
}).select("_id").lean();

const randomWaiter = (waiters) => waiters[Math.floor(Math.random() * waiters.length)];

const notifyAssignedWaiter = (call, waiterId) => {
    emitToUser(waiterId, SOCKET_EVENTS.CASHIER_WAITER_CALL_CHANGED, { callId: String(call._id) });
    notifyEmployee(waiterId, {
        type: "cashier_waiter_call",
        title: "Te necesitan en caja",
        body: "Hay personas esperando para comer en el restaurante. Toca «Voy» para aceptar y ayudarlas a ubicarse.",
        data: { callId: String(call._id) },
    }).catch((error) => console.error("cashierWaiterCall.notify:", error));
};

export const startCashierWaiterCall = async ({ deviceId, sessionId }) => {
    const waiters = await activeWaiters();
    if (waiters.length === 0) return { error: "No hay meseros activos a quienes avisar." };

    const existing = await CashierWaiterCall.findOne({ deviceId, status: "pending" }).lean();
    if (existing) return { error: "Ya hay un llamado en curso; avisaremos al siguiente mesero si no responden." };

    const waiter = randomWaiter(waiters);
    const call = await CashierWaiterCall.create({
        deviceId,
        session: sessionId,
        assignedWaiter: waiter._id,
        triedWaiters: [waiter._id],
        respondBy: new Date(Date.now() + CASHIER_WAITER_RESPONSE_MS),
    });
    notifyAssignedWaiter(call, waiter._id);
    return { call };
};

export const activeCashierWaiterCallsFor = async (waiterId) => CashierWaiterCall.find({
    assignedWaiter: waiterId,
    status: "pending",
    respondBy: { $gt: new Date() },
}).sort({ createdAt: 1 }).select("_id respondBy createdAt").lean();

export const acknowledgeCashierWaiterCall = async (callId, waiterId) => {
    const employee = await EmployeeModel.findOne({
        _id: waiterId,
        "personalInfo.type": "waiter",
        "workInfo.status": "active",
    }).select("_id").lean();
    if (!employee) return { error: { code: 403, message: "Solo un mesero activo puede aceptar este llamado." } };

    const current = await CashierWaiterCall.findOne({ _id: callId, assignedWaiter: waiterId, status: "pending" })
        .select("session")
        .lean();
    if (current && !(await CashSession.exists({ _id: current.session, status: "open" }))) {
        await CashierWaiterCall.updateOne({ _id: current._id, status: "pending" }, { $set: { status: "cancelled" } });
        return { error: { code: 409, message: "El turno de caja ya se cerró." } };
    }

    const call = await CashierWaiterCall.findOneAndUpdate(
        { _id: callId, assignedWaiter: waiterId, status: "pending", respondBy: { $gt: new Date() } },
        { $set: { status: "acknowledged", acknowledgedAt: new Date() } },
        { returnDocument: "after" },
    ).lean();
    if (!call) return { error: { code: 409, message: "Este llamado ya venció o fue atendido por otro mesero." } };

    await EmployeeNotification.updateMany(
        { type: "cashier_waiter_call", "data.callId": String(call._id), employee: waiterId, readAt: null },
        { $set: { readAt: new Date() } },
    ).catch((error) => console.error("cashierWaiterCall.acknowledge inbox:", error.message));
    emitToUser(waiterId, SOCKET_EVENTS.CASHIER_WAITER_CALL_CHANGED, { callId: String(call._id), status: call.status });
    return { call };
};

export const sweepCashierWaiterCalls = async () => {
    const dueCalls = await CashierWaiterCall.find({
        status: "pending",
        respondBy: { $lte: new Date() },
    }).limit(100).lean();

    for (const candidate of dueCalls) {
        const sessionOpen = await CashSession.exists({ _id: candidate.session, status: "open" });
        if (!sessionOpen) {
            await CashierWaiterCall.updateOne(
                { _id: candidate._id, status: "pending" },
                { $set: { status: "cancelled" } },
            );
            await EmployeeNotification.deleteMany({
                type: "cashier_waiter_call",
                "data.callId": String(candidate._id),
            }).catch((error) => console.error("cashierWaiterCall.cancel inbox:", error.message));
            emitToUser(candidate.assignedWaiter, SOCKET_EVENTS.CASHIER_WAITER_CALL_CHANGED, {
                callId: String(candidate._id),
                status: "cancelled",
            });
            continue;
        }

        const next = randomWaiter(await activeWaiters(candidate.triedWaiters || []));
        const now = new Date();
        const update = next
            ? {
                $set: { assignedWaiter: next._id, respondBy: new Date(now.getTime() + CASHIER_WAITER_RESPONSE_MS) },
                $addToSet: { triedWaiters: next._id },
            }
            : { $set: { status: "unanswered" } };
        const call = await CashierWaiterCall.findOneAndUpdate(
            { _id: candidate._id, status: "pending", assignedWaiter: candidate.assignedWaiter, respondBy: { $lte: now } },
            update,
            { returnDocument: "after" },
        ).lean();
        if (!call) continue;

        await EmployeeNotification.deleteMany({
            type: "cashier_waiter_call",
            "data.callId": String(call._id),
            employee: candidate.assignedWaiter,
        }).catch((error) => console.error("cashierWaiterCall.expire inbox:", error.message));
        emitToUser(candidate.assignedWaiter, SOCKET_EVENTS.CASHIER_WAITER_CALL_CHANGED, { callId: String(call._id), status: call.status });
        if (next) notifyAssignedWaiter(call, next._id);
    }
};
