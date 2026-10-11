import mongoose from "mongoose";
import TablesModel, { TABLE_FLOORS } from "../../models/tables/tablesModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import TableRequest, {
    ACTIVE_REQUEST_STATUSES,
    OPEN_REQUEST_STATUSES,
    PAY_METHODS,
    REQUEST_REASONS,
} from "../../models/tables/tableRequestModel.js";
import { findOpenTabOrders } from "../orders/orderController.js";
import {
    REQUEST_COOLDOWN_MS,
    acknowledgeTableRequest,
    assignedWaiterOf,
    cancelTableRequest,
    createTableRequest,
    publicRequest,
    requestsForWaiter,
    resolveTableRequest,
    staffRequest,
} from "../../utils/tables/tableRequestUtils.js";

// Servicio de mesa (/table-service).
//
// Públicas, sin sesión: la página que abre el QR de la mesa
// (SYSCOR-tableSystem). Se identifican por el qrToken de la mesa, que solo
// tiene quien está frente a ella.
// Del mesero: sus solicitudes activas, "Voy" y "Atendida".
const tableServiceController = {};

const findTable = (token) =>
    /^[A-Za-z0-9_-]{6,64}$/.test(String(token || "")) ? TablesModel.findOne({ qrToken: token }).lean() : null;

const notFound = (res) =>
    res.status(404).json({ title: "Mesa no encontrada", message: "Este código no es de una mesa de El Corral." });

// Solicitudes de la visita actual (desde que se ocupó la mesa).
const visitFilter = (table) => ({
    table: table._id,
    ...(table.occupiedAt ? { createdAt: { $gte: table.occupiedAt } } : {}),
});

// Cuenta abierta de la mesa, agrupando el mismo producto al mismo precio.
const billOf = async (table) => {
    const orders = await findOpenTabOrders(table);
    const lines = new Map();
    for (const order of orders) {
        for (const item of order.items || []) {
            const key = `${item.name}|${item.price}`;
            const line = lines.get(key) || { name: item.name, price: item.price || 0, quantity: 0 };
            line.quantity += item.quantity || 1;
            lines.set(key, line);
        }
    }
    const items = [...lines.values()].map((line) => ({
        ...line,
        subtotal: Math.round(line.price * line.quantity * 100) / 100,
    }));
    const total = Math.round(orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0) * 100) / 100;
    return { items, total, orderCount: orders.length };
};

const cooldownLeft = (lastRequest) => {
    if (!lastRequest) return 0;
    const left = new Date(lastRequest.createdAt).getTime() + REQUEST_COOLDOWN_MS - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
};

// GET /table-service/:token
// Todo lo que muestra la página: la mesa, quién la atiende, la cuenta y la
// solicitud en curso (para ver "David ya viene" en vivo).
tableServiceController.getTable = async (req, res) => {
    try {
        const table = await findTable(req.params.token);
        if (!table) return notFound(res);

        const open = table.status === "ocupada";
        const base = {
            table: {
                number: table.number,
                floor: TABLE_FLOORS[table.floor] || null,
                status: table.status,
            },
            open,
        };
        if (!open) return res.status(200).json({ ...base, waiter: null, bill: null, request: null, cooldownSeconds: 0 });

        const [waiter, bill, active, last] = await Promise.all([
            assignedWaiterOf(table),
            billOf(table),
            TableRequest.findOne({ ...visitFilter(table), status: { $in: ACTIVE_REQUEST_STATUSES } })
                .sort({ createdAt: -1 })
                .lean(),
            TableRequest.findOne(visitFilter(table)).sort({ createdAt: -1 }).lean(),
        ]);

        return res.status(200).json({
            ...base,
            // Solo el nombre de pila de quien atiende.
            waiter: waiter ? { name: waiter.name?.split(/\s+/)[0] || null } : null,
            bill,
            request: publicRequest(active),
            cooldownSeconds: cooldownLeft(last),
        });
    } catch (error) {
        console.error("tableServiceController.getTable:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos cargar tu mesa. Inténtalo de nuevo." });
    }
};

// POST /table-service/:token/requests
// { type: "bill", payMethod: "cash" | "card" } o { type: "waiter", reason }
tableServiceController.createRequest = async (req, res) => {
    try {
        const table = await findTable(req.params.token);
        if (!table) return notFound(res);

        const { type, reason, payMethod } = req.body || {};
        if (!["bill", "waiter"].includes(type)) {
            return res.status(400).json({ title: "Solicitud no válida", message: "Elige si quieres la cuenta o llamar a tu mesero." });
        }
        if (type === "bill" && !PAY_METHODS[payMethod]) {
            return res.status(400).json({ title: "Falta cómo pagarás", message: "Elige efectivo o tarjeta." });
        }
        if (type === "waiter" && !REQUEST_REASONS[reason]) {
            return res.status(400).json({ title: "Falta el motivo", message: "Cuéntanos para qué llamas a tu mesero." });
        }
        // Una foto del QR no sirve desde casa: solo una mesa ocupada pide cosas.
        if (table.status !== "ocupada") {
            return res.status(409).json({
                title: "Tu mesa todavía no está abierta",
                message: "Cuando un mesero te asigne esta mesa podrás pedir desde aquí.",
            });
        }

        const [open, last] = await Promise.all([
            TableRequest.findOne({ ...visitFilter(table), status: { $in: OPEN_REQUEST_STATUSES } }).lean(),
            TableRequest.findOne(visitFilter(table)).sort({ createdAt: -1 }).lean(),
        ]);
        if (open) {
            return res.status(409).json({
                title: "Ya avisamos",
                message: "Tu solicitud anterior sigue en camino. Espera un momento.",
                request: publicRequest(open),
            });
        }
        const wait = cooldownLeft(last);
        if (wait > 0) {
            return res.status(429).json({
                title: "Un momento",
                message: `Podrás hacer otra solicitud en ${wait} s.`,
                cooldownSeconds: wait,
            });
        }

        const request = await createTableRequest({ table, type, reason, payMethod });
        return res.status(201).json({ request: publicRequest(request), cooldownSeconds: Math.ceil(REQUEST_COOLDOWN_MS / 1000) });
    } catch (error) {
        console.error("tableServiceController.createRequest:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos avisar. Inténtalo de nuevo." });
    }
};

// DELETE /table-service/:token/requests/:id
tableServiceController.cancelRequest = async (req, res) => {
    try {
        const table = await findTable(req.params.token);
        if (!table) return notFound(res);
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ title: "No encontrada", message: "Esa solicitud ya no existe." });
        }
        const request = await cancelTableRequest(req.params.id, table._id);
        if (!request) {
            return res.status(409).json({ title: "Ya no se puede cancelar", message: "Tu mesero ya va en camino o ya te atendió." });
        }
        return res.status(200).json({ request: publicRequest(request) });
    } catch (error) {
        console.error("tableServiceController.cancelRequest:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo cancelar." });
    }
};

// GET /table-service/requests/active  (mesero)
tableServiceController.getActiveForWaiter = async (req, res) => {
    try {
        return res.status(200).json({ requests: await requestsForWaiter(req.user.id) });
    } catch (error) {
        console.error("tableServiceController.getActiveForWaiter:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudieron cargar las solicitudes de las mesas." });
    }
};

// PATCH /table-service/requests/:id/acknowledge  (mesero: "Voy")
tableServiceController.acknowledge = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ title: "Ya no existe", message: "Esa solicitud ya no existe." });
        }
        const employee = await EmployeeModel.findById(req.user.id).select("personalInfo.name personalInfo.lastname").lean();
        const name = `${employee?.personalInfo?.name || ""} ${employee?.personalInfo?.lastname || ""}`.trim() || "Tu mesero";
        const result = await acknowledgeTableRequest(req.params.id, { id: req.user.id, name });
        if (result.error) {
            const { code, ...body } = result.error;
            return res.status(code).json({ ...body, request: result.request ? staffRequest(result.request) : null });
        }
        return res.status(200).json({ request: staffRequest(result.request) });
    } catch (error) {
        console.error("tableServiceController.acknowledge:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo tomar la solicitud." });
    }
};

// PATCH /table-service/requests/:id/resolve  (mesero: "Atendida")
tableServiceController.resolve = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ title: "Ya no existe", message: "Esa solicitud ya no existe." });
        }
        const request = await resolveTableRequest(req.params.id);
        if (!request) return res.status(409).json({ title: "Ya estaba cerrada", message: "Esa solicitud ya no está activa." });
        return res.status(200).json({ request: staffRequest(request) });
    } catch (error) {
        console.error("tableServiceController.resolve:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo marcar como atendida." });
    }
};

export default tableServiceController;
