// Sistema de Caja (POS): emparejamiento de cajas, turnos y cobros.
//
// Dos públicos, nunca mezclados:
//   - Administrador (cookie): empareja cajas, abre el turno (elige al cajero
//     y cuenta el fondo inicial), lo puede cerrar, desvincula cajas y apaga
//     el sistema.
//   - Pantalla de caja (token de dispositivo): ve lo que hay por cobrar,
//     cobra (mesas, pedidos para recoger y ventas de mostrador), entrega lo
//     que ya está pagado y listo, registra movimientos de efectivo y cierra
//     su turno con el arqueo. Solo cobra mientras su turno esté abierto.
//
// Los cobros todavía son simulados: no hay pasarela de tarjeta ni
// transmisión a Hacienda. Pero todo lo demás es real: los pedidos quedan
// pagados y entregados, se genera su factura de venta (Invoice) como en
// cualquier otro cobro, y la caja emite su comprobante con correlativo.
import Order from "../../models/orders/orderModel.js";
import Invoice from "../../models/orders/invoiceModel.js";
import TablesModel from "../../models/tables/tablesModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import Saucers from "../../models/menu/saucersModel.js";
import Combos from "../../models/menu/combosModel.js";
import Drinks from "../../models/menu/drinksModel.js";
import Extras from "../../models/menu/extrasModel.js";
import Promotions from "../../models/menu/promotionsModel.js";
import CashierDeviceModel from "../../models/cashier/cashierDeviceModel.js";
import CashSession from "../../models/cashier/cashSessionModel.js";
import CashReceipt from "../../models/cashier/cashReceiptModel.js";
import settingsUtils from "../../utils/settings/settingsUtils.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { WAITER_POPULATE } from "../../utils/orders/waiterPopulate.js";
import { orderCode } from "../../utils/orders/orderCodeUtils.js";
import { targetsForProduct, extraFitsProduct } from "../../utils/extras/extraTargetsUtils.js";
import { includedDrinksOf } from "../../utils/drinks/drinkUpgradeUtils.js";
import { buildItems } from "../orders/checkoutController.js";
import {
    applyOrderStatus,
    settleTableTab,
    belongsToOpenTab,
    KITCHEN_ACTIVE_STATUSES,
} from "../orders/orderController.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";
import {
    findCashierPairing,
    deliverCashierToken,
    disconnectCashierDevices,
    notifyCashierSession,
    requestCashierRefresh,
} from "../../config/cashierSocket.js";
import {
    signCashierToken,
    revokeCashierDevices,
    publicCashierDevice,
} from "../../utils/cashier/cashierDeviceUtils.js";
import {
    round2,
    splitIva,
    nextDocumentCorrelative,
    controlNumberFor,
    newGenerationCode,
    newReceptionSeal,
    newAuthorizationCode,
    nextSessionCode,
    parseReceiptCustomer,
    summarizeSession,
    publicSession,
} from "../../utils/cashier/cashierUtils.js";
import { DOCUMENT_TYPES, ISSUER, IVA_RATE, DTE_ENVIRONMENT, DTE_QUERY_URL } from "../../constants/fiscal.js";
import { MAX_OPENING_FLOAT, MAX_CASH_MOVEMENT, MAX_CASH_RECEIVED } from "../../constants/cashierDevice.js";

const cashierController = {};

const SERVER_ERROR = { title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." };
const ORDERS_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.orders;
const TABLES_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.tables;

const fullName = (person) => `${person?.name || ""} ${person?.lastname || ""}`.trim();
const ACTIVE_STATUS_WORDS = ["disponible", "activo", "active"];
const isActive = (doc) => ACTIVE_STATUS_WORDS.includes(String(doc?.status || "").toLowerCase());

const publicCashier = (settings) => ({
    enabled: Boolean(settings?.cashier?.enabled),
    changedAt: settings?.cashier?.changedAt || null,
    changedBy: settings?.cashier?.changedBy || null,
});

// Avisa al panel (Ajustes) y a los meseros de que cambió el sistema o un turno
const broadcastCashier = async () => {
    const settings = await settingsUtils.getOrCreateSettings();
    const open = settings.cashier?.enabled ? Boolean(await CashSession.exists({ status: "open" })) : false;
    emitToRoles(["admin", "employee"], SOCKET_EVENTS.CASHIER_STATUS_CHANGED, { cashier: { ...publicCashier(settings), open } });
    emitToRoles(["admin"], SOCKET_EVENTS.CASHIER_DEVICES_CHANGED, {});
};

const sessionWithSummary = async (session) => {
    const receipts = await CashReceipt.find({ session: session._id }).lean();
    return publicSession(session, session.status === "closed" && session.summary ? session.summary : summarizeSession(session, receipts));
};

// Valida cajero y fondo inicial para abrir un turno
const parseShiftOpening = async ({ cashierId, openingFloat }) => {
    const float = Number(openingFloat);
    if (!Number.isFinite(float) || float < 0 || float > MAX_OPENING_FLOAT) {
        return { error: `El fondo inicial debe estar entre $0 y $${MAX_OPENING_FLOAT}.` };
    }
    if (!/^[a-f\d]{24}$/i.test(String(cashierId || ""))) return { error: "Elige al cajero del turno." };
    const cashier = await EmployeeModel.findOne({
        _id: cashierId,
        "personalInfo.type": "cashier",
        "workInfo.status": "active",
    }).select("personalInfo.name personalInfo.lastname").lean();
    if (!cashier) return { error: "Ese empleado no es un cajero activo." };

    const busy = await CashSession.exists({ status: "open", "cashier.id": cashier._id });
    if (busy) return { error: `${fullName(cashier.personalInfo)} ya tiene un turno abierto en otra caja.` };

    return { cashier: { id: cashier._id, name: fullName(cashier.personalInfo) || "Cajero" }, openingFloat: round2(float) };
};

const openSession = async ({ deviceId, cashier, openingFloat, actor }) => {
    const session = await CashSession.create({
        code: await nextSessionCode(),
        deviceId,
        cashier,
        openingFloat,
        openedBy: { id: actor.id, name: actor.name },
        openedAt: new Date(),
    });
    notifyCashierSession(deviceId, publicSession(session, summarizeSession(session, [])));
    return session;
};

/**
 * Cierra un turno con el arqueo. `countedCash` null = cierre forzado sin
 * contar (lo hace el admin al desvincular o apagar el sistema).
 */
const closeSession = async (session, { countedCash = null, notes = null, closedBy }) => {
    const receipts = await CashReceipt.find({ session: session._id }).lean();
    const summary = summarizeSession(session, receipts);
    const counted = countedCash === null ? null : round2(countedCash);

    const closed = await CashSession.findOneAndUpdate(
        { _id: session._id, status: "open" },
        {
            $set: {
                status: "closed",
                closedAt: new Date(),
                closedBy,
                countedCash: counted,
                expectedCash: summary.expectedCash,
                difference: counted === null ? null : round2(counted - summary.expectedCash),
                closingNotes: notes,
                summary,
            },
        },
        { returnDocument: "after" },
    );
    if (!closed) return null;
    notifyCashierSession(closed.deviceId, null);
    return closed;
};

// ======================== Administrador ========================

// GET /cashier/admin/overview — todo lo que muestra Ajustes → Sistema de caja
cashierController.getOverview = async (req, res) => {
    try {
        const [settings, devices, openSessions, recentSessions, cashiers] = await Promise.all([
            settingsUtils.getOrCreateSettings(),
            CashierDeviceModel.find({ active: true }).sort({ pairedAt: -1 }).lean(),
            CashSession.find({ status: "open" }).sort({ openedAt: -1 }).lean(),
            CashSession.find({ status: "closed" }).sort({ closedAt: -1 }).limit(15).lean(),
            EmployeeModel.find({ "personalInfo.type": "cashier", "workInfo.status": "active" })
                .select("personalInfo.name personalInfo.lastname personalInfo.image")
                .sort({ "personalInfo.name": 1 })
                .lean(),
        ]);

        const open = await Promise.all(openSessions.map(sessionWithSummary));
        return res.status(200).json({
            cashier: publicCashier(settings),
            devices: devices.map((device) => ({
                ...publicCashierDevice(device),
                session: open.find((s) => s.deviceId === device.deviceId) || null,
            })),
            openSessions: open,
            recentSessions: recentSessions.map((s) => publicSession(s)),
            cashiers: cashiers.map((c) => ({ id: c._id, name: fullName(c.personalInfo), image: c.personalInfo?.image || null })),
        });
    } catch (error) {
        console.error("cashierController.getOverview:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/devices/pair { code, cashierId, openingFloat }
// Empareja la caja que muestra ese código, habilita el sistema si estaba
// apagado y abre el turno con el cajero y el fondo indicados.
cashierController.pairDevice = async (req, res) => {
    try {
        const code = String(req.body?.code || "").replace(/\D/g, "");
        const pairing = findCashierPairing(code);
        if (!pairing) {
            return res.status(404).json({ title: "Código no encontrado", message: "Ese código no corresponde a ninguna caja esperando, o ya venció. Revisa el código que muestra la caja." });
        }

        const opening = await parseShiftOpening(req.body || {});
        if (opening.error) return res.status(400).json({ title: "No se pudo abrir el turno", message: opening.error });

        const stale = await CashSession.findOne({ deviceId: pairing.deviceId, status: "open" });
        if (stale) return res.status(409).json({ title: "Turno abierto", message: "Esta caja ya tiene un turno abierto. Ciérralo desde el panel antes de volver a emparejarla." });

        const actor = await notificationUtils.resolveActor(req);
        const device = await CashierDeviceModel.findOneAndUpdate(
            { deviceId: pairing.deviceId },
            {
                $set: {
                    active: true,
                    userAgent: pairing.userAgent || null,
                    pairedBy: { id: req.user.id, name: actor.name },
                    pairedAt: new Date(),
                    revokedAt: null,
                    lastSeenAt: new Date(),
                },
                $inc: { tokenVersion: 1 },
            },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
        );

        const settings = await settingsUtils.getOrCreateSettings();
        const wasEnabled = Boolean(settings.cashier?.enabled);
        if (!wasEnabled) {
            settings.cashier = { enabled: true, changedAt: new Date(), changedBy: actor.name };
            await settings.save();
        }

        const session = await openSession({ deviceId: device.deviceId, cashier: opening.cashier, openingFloat: opening.openingFloat, actor });

        const delivered = deliverCashierToken(pairing, { token: signCashierToken(device), deviceId: device.deviceId });
        if (!delivered) {
            await CashSession.deleteOne({ _id: session._id });
            await revokeCashierDevices({ deviceId: device.deviceId });
            return res.status(409).json({ title: "Caja desconectada", message: "La caja se desconectó antes de recibir el acceso. Recárgala y usa el código nuevo." });
        }

        await broadcastCashier();
        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "updated",
            title: "Turno de caja abierto",
            message: (who) => `${who.name} abrió el turno de ${opening.cashier.name} con $${opening.openingFloat.toFixed(2)} de fondo`,
            icon: "cash-register",
            severity: "info",
            entity: { model: "CashSession", id: session._id, label: session.code },
        });

        return res.status(200).json({
            title: "Caja habilitada",
            message: `La caja quedó abierta para ${opening.cashier.name}.`,
            data: { cashier: publicCashier(settings), device: publicCashierDevice(device), session: publicSession(session) },
        });
    } catch (error) {
        console.error("cashierController.pairDevice:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/sessions { deviceId, cashierId, openingFloat }
// Abre un turno nuevo en una caja ya emparejada (ej. al día siguiente).
cashierController.openShift = async (req, res) => {
    try {
        const device = await CashierDeviceModel.findOne({ deviceId: req.body?.deviceId, active: true }).lean();
        if (!device) return res.status(404).json({ title: "Caja no encontrada", message: "Esa caja no está emparejada." });

        const settings = await settingsUtils.getOrCreateSettings();
        if (!settings.cashier?.enabled) return res.status(409).json({ title: "Caja deshabilitada", message: "Habilita el sistema de caja primero." });

        if (await CashSession.exists({ deviceId: device.deviceId, status: "open" })) {
            return res.status(409).json({ title: "Turno abierto", message: "Esta caja ya tiene un turno abierto." });
        }

        const opening = await parseShiftOpening(req.body || {});
        if (opening.error) return res.status(400).json({ title: "No se pudo abrir el turno", message: opening.error });

        const actor = await notificationUtils.resolveActor(req);
        const session = await openSession({ deviceId: device.deviceId, cashier: opening.cashier, openingFloat: opening.openingFloat, actor });
        await broadcastCashier();
        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "updated",
            title: "Turno de caja abierto",
            message: (who) => `${who.name} abrió el turno de ${opening.cashier.name} con $${opening.openingFloat.toFixed(2)} de fondo`,
            icon: "cash-register",
            severity: "info",
            entity: { model: "CashSession", id: session._id, label: session.code },
        });

        return res.status(200).json({ title: "Turno abierto", message: `La caja quedó abierta para ${opening.cashier.name}.`, data: publicSession(session) });
    } catch (error) {
        console.error("cashierController.openShift:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/sessions/:id/close { countedCash?, notes? } — cierre por el admin
cashierController.adminCloseShift = async (req, res) => {
    try {
        const session = await CashSession.findOne({ _id: req.params.id, status: "open" });
        if (!session) return res.status(404).json({ title: "Turno no encontrado", message: "Ese turno ya está cerrado." });

        const counted = req.body?.countedCash;
        let countedCash = null;
        if (counted !== undefined && counted !== null && counted !== "") {
            countedCash = Number(counted);
            if (!Number.isFinite(countedCash) || countedCash < 0) return res.status(400).json({ title: "Monto inválido", message: "El efectivo contado no es válido." });
        }

        const actor = await notificationUtils.resolveActor(req);
        const closed = await closeSession(session, {
            countedCash,
            notes: String(req.body?.notes || "").trim().slice(0, 300) || null,
            closedBy: { kind: "admin", name: actor.name },
        });
        await broadcastCashier();
        return res.status(200).json({ title: "Turno cerrado", message: "El turno de caja quedó cerrado.", data: publicSession(closed) });
    } catch (error) {
        console.error("cashierController.adminCloseShift:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// GET /cashier/sessions/:id — corte de un turno con sus comprobantes (admin)
cashierController.getSessionReport = async (req, res) => {
    try {
        const session = await CashSession.findById(req.params.id).lean();
        if (!session) return res.status(404).json({ title: "Turno no encontrado", message: "No existe ese turno." });
        const receipts = await CashReceipt.find({ session: session._id }).sort({ issuedAt: -1 }).lean();
        return res.status(200).json({
            session: await sessionWithSummary(session),
            receipts: receipts.map(publicReceipt),
            issuer: ISSUER,
        });
    } catch (error) {
        console.error("cashierController.getSessionReport:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// DELETE /cashier/devices/:deviceId — desvincular (cierra su turno sin arqueo)
cashierController.unpairDevice = async (req, res) => {
    try {
        const actor = await notificationUtils.resolveActor(req);
        const open = await CashSession.findOne({ deviceId: req.params.deviceId, status: "open" });
        if (open) await closeSession(open, { closedBy: { kind: "admin", name: actor.name }, notes: "Cerrado al desvincular la caja (sin arqueo)." });

        const revoked = await revokeCashierDevices({ deviceId: req.params.deviceId });
        if (revoked.length === 0) return res.status(404).json({ title: "Caja no encontrada", message: "Esa caja no estaba emparejada." });
        disconnectCashierDevices(revoked, { message: "Un administrador desvinculó esta caja." });
        await broadcastCashier();
        return res.status(200).json({ title: "Caja desvinculada", message: "La caja perdió su acceso." });
    } catch (error) {
        console.error("cashierController.unpairDevice:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/disable — apaga el sistema (cierra turnos sin arqueo y revoca)
cashierController.disableCashier = async (req, res) => {
    try {
        const actor = await notificationUtils.resolveActor(req);
        const openSessions = await CashSession.find({ status: "open" });
        for (const session of openSessions) {
            await closeSession(session, { closedBy: { kind: "admin", name: actor.name }, notes: "Cerrado al deshabilitar el sistema de caja (sin arqueo)." });
        }

        const settings = await settingsUtils.getOrCreateSettings();
        settings.cashier = { enabled: false, changedAt: new Date(), changedBy: actor.name };
        await settings.save();

        const revoked = await revokeCashierDevices();
        disconnectCashierDevices(revoked, { message: "Un administrador deshabilitó el sistema de caja." });
        await broadcastCashier();

        return res.status(200).json({ title: "Caja deshabilitada", message: "Las cajas perdieron su acceso.", data: { cashier: publicCashier(settings) } });
    } catch (error) {
        console.error("cashierController.disableCashier:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// GET /cashier/public-status — para la app de meseros (cookie de empleado)
cashierController.getPublicStatus = async (req, res) => {
    try {
        const settings = await settingsUtils.getOrCreateSettings();
        const open = settings.cashier?.enabled ? Boolean(await CashSession.exists({ status: "open" })) : false;
        return res.status(200).json({ cashier: { enabled: Boolean(settings.cashier?.enabled), open } });
    } catch (error) {
        console.error("cashierController.getPublicStatus:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// ======================== Pantalla de caja ========================

const currentSession = (deviceId) => CashSession.findOne({ deviceId, status: "open" });

const requireOpenSession = async (req, res) => {
    const session = await currentSession(req.cashierDevice.deviceId);
    if (!session) {
        res.status(409).json({ code: "SHIFT_CLOSED", title: "Caja cerrada", message: "Esta caja no tiene un turno abierto. Un administrador debe abrirlo." });
        return null;
    }
    return session;
};

// GET /cashier/status
cashierController.getStatus = async (req, res) => {
    try {
        const session = await currentSession(req.cashierDevice.deviceId);
        const device = await CashierDeviceModel.findOne({ deviceId: req.cashierDevice.deviceId }).lean();
        return res.status(200).json({
            device: device ? publicCashierDevice(device) : null,
            session: session ? await sessionWithSummary(session) : null,
            issuer: ISSUER,
            ivaRate: IVA_RATE,
        });
    } catch (error) {
        console.error("cashierController.getStatus:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// Lo que el cliente debe en caja de un pedido de la app: el total menos el
// saldo a favor que ya se aplicó.
const amountDueOf = (order) => round2(Math.max((order.total || 0) - (order.payment?.creditApplied || 0), 0));

const lineItems = (orders) =>
    orders.flatMap((order) => (order.items || []).map((item) => ({
        name: item.name,
        quantity: item.quantity || 1,
        unitPrice: round2(item.price || 0),
        total: round2((item.price || 0) * (item.quantity || 1)),
        notes: item.notes || "",
    })));

const customerNameOf = (order) =>
    fullName(order.contact) || fullName(order.customer?.personalInfo) || order.localCustomerName || "Cliente";

// GET /cashier/pending — mesas por cobrar, pedidos para recoger por cobrar y
// pedidos pagados por entregar
cashierController.getPending = async (req, res) => {
    try {
        const tables = await TablesModel.find({ status: "ocupada" }).sort({ number: 1 }).lean();
        const oldest = tables.reduce((min, t) => (t.occupiedAt && (!min || t.occupiedAt < min) ? t.occupiedAt : min), null);

        const [tableOrders, pickupOrders, deliverOrders] = await Promise.all([
            tables.length
                ? Order.find({
                    orderType: "local",
                    table: { $in: tables.map((t) => t._id) },
                    paymentStatus: "pending",
                    $or: [
                        { status: { $in: KITCHEN_ACTIVE_STATUSES } },
                        { status: "delivered", createdAt: { $gte: oldest || new Date(0) } },
                    ],
                }).populate(WAITER_POPULATE).sort({ createdAt: 1 }).lean()
                : [],
            // Pedidos de la app que se pagan al recoger: llegan a caja cuando
            // cocina los marca listos (antes no hay nada que entregar).
            Order.find({
                orderType: "online",
                isDelivery: { $ne: true },
                fulfillment: { $ne: "delivery" },
                paymentStatus: "pending",
                status: "ready",
            }).populate("customer", "personalInfo").sort({ updatedAt: 1 }).lean(),
            Order.find({
                paymentStatus: "paid",
                status: { $in: [...KITCHEN_ACTIVE_STATUSES, "ready"] },
                $or: [
                    { channel: "counter" },
                    { orderType: "online", isDelivery: { $ne: true }, fulfillment: { $in: ["pickup", null] } },
                ],
            }).populate("customer", "personalInfo").sort({ createdAt: 1 }).lean(),
        ]);

        const tabs = tables
            .map((table) => {
                const orders = tableOrders.filter((o) => String(o.table) === String(table._id) && belongsToOpenTab(o, table));
                if (orders.length === 0) return null;
                const total = round2(orders.reduce((sum, o) => sum + (o.total || 0), 0));
                return {
                    tableId: table._id,
                    number: table.number,
                    customerName: table.customerName || null,
                    peopleCount: table.peopleCount || null,
                    occupiedAt: table.occupiedAt || null,
                    billRequestedAt: table.billRequestedAt || null,
                    billRequestedBy: table.billRequestedBy || null,
                    waiters: [...new Set(orders.map((o) => fullName(o.waiter)).filter(Boolean))],
                    blocked: orders.some((o) => o.waiting && o.status === "pending"),
                    allServed: orders.every((o) => o.status === "delivered"),
                    orders: orders.map((o) => ({
                        id: o._id,
                        code: orderCode(o),
                        round: o.round || null,
                        status: o.status,
                        waiting: Boolean(o.waiting),
                        total: round2(o.total || 0),
                    })),
                    items: lineItems(orders),
                    total,
                };
            })
            .filter(Boolean)
            // Primero las que el mesero mandó a caja
            .sort((a, b) => (b.billRequestedAt ? 1 : 0) - (a.billRequestedAt ? 1 : 0) || a.number - b.number);

        const pickups = pickupOrders.map((o) => ({
            orderId: o._id,
            code: orderCode(o),
            kitchenNumber: o.kitchenNumber ?? null,
            status: o.status,
            fulfillment: o.fulfillment || "pickup",
            customerName: customerNameOf(o),
            scheduledFor: o.scheduledFor || null,
            items: lineItems([o]),
            total: round2(o.total || 0),
            creditApplied: round2(o.payment?.creditApplied || 0),
            amountDue: amountDueOf(o),
            readyAt: [...(o.statusHistory || [])].reverse().find((h) => h.status === "ready")?.changedAt || o.updatedAt,
            createdAt: o.createdAt,
        }));

        const toDeliver = deliverOrders.map((o) => ({
            orderId: o._id,
            code: orderCode(o),
            kitchenNumber: o.kitchenNumber ?? null,
            status: o.status,
            source: o.channel === "counter" ? "counter" : "pickup",
            customerName: customerNameOf(o),
            items: lineItems([o]),
            total: round2(o.total || 0),
            createdAt: o.createdAt,
        }));

        return res.status(200).json({ tables: tabs, pickups, toDeliver });
    } catch (error) {
        console.error("cashierController.getPending:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// GET /cashier/menu — lo que se puede vender en el mostrador, con precios
cashierController.getMenu = async (req, res) => {
    try {
        const [saucers, combos, drinks, extras, promotions] = await Promise.all([
            Saucers.find().select("name price category subcategory image status").sort({ name: 1 }).lean(),
            Combos.find()
                .select("name price category image status saucers selective selectiveOptions selectiveMaxPicks drinkPolicy")
                .populate("saucers.saucerId", "name category")
                .populate("selectiveOptions.saucerId", "name category")
                .populate({ path: "drinkPolicy.drinkSetIds", select: "drinkIds", populate: { path: "drinkIds", select: "name price status" } })
                .populate("drinkPolicy.thirdPartyDrinkIds", "name price status")
                .sort({ name: 1 })
                .lean(),
            Drinks.find().select("name price category subcategory image status").sort({ name: 1 }).lean(),
            Extras.find().select("name price status appliesTo").sort({ name: 1 }).lean(),
            // Sin lean: la virtual isLive (vigencia) solo existe en el documento
            Promotions.find().select("-items"),
        ]);

        const activeExtras = extras.filter(isActive);
        const extrasFor = (productType, product) => {
            const targets = targetsForProduct(productType, product);
            return activeExtras.filter((extra) => extraFitsProduct(extra, targets)).map((extra) => String(extra._id));
        };

        const product = (productType, doc, extra = {}) => ({
            id: doc._id,
            productType,
            name: doc.name,
            price: round2(doc.price || 0),
            image: doc.image || null,
            category: doc.category || null,
            subcategory: doc.subcategory || null,
            extras: extrasFor(productType, doc),
            ...extra,
        });

        return res.status(200).json({
            saucers: saucers.filter(isActive).map((doc) => product("saucer", doc)),
            combos: combos.filter(isActive).map((doc) => product("combo", doc, {
                fixed: (doc.saucers || []).map((s) => s.saucerId?.name).filter(Boolean),
                selective: Boolean(doc.selective),
                selectiveOptions: (doc.selectiveOptions || []).map((s) => s.saucerId?.name).filter(Boolean),
                selectiveMaxPicks: doc.selectiveMaxPicks || 1,
                drinks: includedDrinksOf(doc).filter(isActive).map((d) => ({ id: d._id, name: d.name })),
            })),
            drinks: drinks.filter(isActive).map((doc) => product("drink", doc)),
            promotions: promotions.filter((p) => p.isLive).map((p) => ({
                id: p._id,
                productType: "promotion",
                name: p.name,
                price: round2(p.price || 0),
                image: p.image || null,
                category: "Promociones",
                extras: [],
            })),
            extras: activeExtras.map((e) => ({ id: e._id, name: e.name, price: round2(e.price || 0) })),
        });
    } catch (error) {
        console.error("cashierController.getMenu:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// Comprobante tal como lo ven la caja y el panel (para mostrar e imprimir)
const publicReceipt = (receipt) => ({
    id: receipt._id,
    documentType: receipt.documentType,
    documentLabel: DOCUMENT_TYPES[receipt.documentType].label,
    dteType: receipt.dteType,
    correlative: receipt.correlative,
    controlNumber: receipt.controlNumber,
    generationCode: receipt.generationCode,
    receptionSeal: receipt.receptionSeal,
    queryUrl: `${DTE_QUERY_URL}?ambiente=${DTE_ENVIRONMENT}&codGen=${receipt.generationCode}&fechaEmi=${new Date(receipt.issuedAt).toISOString().slice(0, 10)}`,
    source: receipt.source,
    items: receipt.items,
    base: receipt.base,
    iva: receipt.iva,
    total: receipt.total,
    creditApplied: receipt.creditApplied,
    tip: receipt.tip,
    amountDue: receipt.amountDue,
    payment: receipt.payment,
    customer: receipt.customer,
    cashier: receipt.cashier?.name || null,
    issuedAt: receipt.issuedAt,
});

const parsePayment = (raw = {}, amountDue) => {
    const method = raw.method;
    if (!["cash", "card"].includes(method)) return { error: "Elige cómo paga el cliente: efectivo o tarjeta." };

    if (method === "cash") {
        const received = Number(raw.received);
        if (!Number.isFinite(received) || received <= 0 || received > MAX_CASH_RECEIVED) {
            return { error: "Escribe cuánto efectivo entregó el cliente." };
        }
        if (round2(received) < amountDue) {
            return { error: `El efectivo recibido no alcanza: faltan $${round2(amountDue - received).toFixed(2)}.` };
        }
        return { payment: { method, received: round2(received), change: round2(received - amountDue) } };
    }

    const last4 = String(raw.cardLast4 || "").replace(/\D/g, "");
    if (last4.length !== 4) return { error: "Escribe los últimos 4 dígitos de la tarjeta." };
    const brand = ["Visa", "Mastercard", "American Express", "Otra"].includes(raw.cardBrand) ? raw.cardBrand : "Visa";
    // POS simulado: siempre aprueba y entrega un número de autorización
    return { payment: { method, cardBrand: brand, cardLast4: last4, authorizationCode: newAuthorizationCode() } };
};

// Libera la mesa al terminar de cobrar (ya no queda nada pendiente en ella)
const releaseTable = async (tableId) => {
    const updated = await TablesModel.findByIdAndUpdate(
        tableId,
        {
            $set: { status: "libre", reservation: null, billRequestedAt: null, billRequestedBy: null },
            $unset: { customerName: "", peopleCount: "", occupiedAt: "" },
        },
        { returnDocument: "after" },
    );
    if (updated) emitToRoles(TABLES_AUDIENCE, SOCKET_EVENTS.TABLE_UPDATED, { table: updated.toObject() });
};

const emitOrder = async (orderId) => {
    const populated = await Order.findById(orderId)
        .populate("table", "number status")
        .populate(WAITER_POPULATE)
        .populate("customer", "personalInfo");
    if (populated) emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: populated.toObject() });
    return populated;
};

/**
 * POST /cashier/charges
 * {
 *   source: "table" | "pickup" | "counter",
 *   tableId?, releaseTable?,          // mesa
 *   orderId?,                          // pedido para recoger
 *   sale?: { items, customerName, fulfillment: "pickup"|"dine_in", notes },  // mostrador
 *   document: { type: "fcf" | "ccf", customer? },
 *   payment: { method: "cash"|"card", received?, cardBrand?, cardLast4? },
 *   tip?
 * }
 *
 * Primero se valida y se calcula todo; recién después se tocan los pedidos y
 * se emite el comprobante.
 */
cashierController.charge = async (req, res) => {
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return undefined;

        const body = req.body || {};
        const documentType = body.document?.type === "ccf" ? "ccf" : "fcf";
        const parsedCustomer = parseReceiptCustomer(documentType, body.document?.customer || {});
        if (parsedCustomer.error) return res.status(400).json({ title: "Datos del cliente", message: parsedCustomer.error });

        const tip = round2(Number(body.tip) || 0);
        if (tip < 0 || tip > 500) return res.status(400).json({ title: "Propina inválida", message: "La propina no es válida." });

        // --- 1. Qué se cobra y cuánto ---
        let plan;
        if (body.source === "table") {
            const table = await TablesModel.findOne({ _id: body.tableId, status: "ocupada" }).lean();
            if (!table) return res.status(404).json({ title: "Mesa no encontrada", message: "Esa mesa ya no está ocupada." });
            const orders = (await Order.find({ orderType: "local", table: table._id, paymentStatus: "pending" }).lean())
                .filter((o) => belongsToOpenTab(o, table) && [...KITCHEN_ACTIVE_STATUSES, "delivered"].includes(o.status));
            if (orders.length === 0) return res.status(400).json({ title: "Sin consumo", message: "La mesa no tiene consumos pendientes de cobro." });
            if (orders.some((o) => o.waiting && o.status === "pending")) {
                return res.status(409).json({ title: "Hay un tiempo en espera", message: "La mesa tiene una comanda esperando a que el mesero la marche. Debe marcharla o cancelarla antes de cobrar." });
            }
            const total = round2(orders.reduce((sum, o) => sum + (o.total || 0), 0));
            plan = { kind: "table", table, orders, total, creditApplied: 0, customerName: table.customerName || null };
        } else if (body.source === "pickup") {
            const order = await Order.findOne({
                _id: body.orderId,
                orderType: "online",
                paymentStatus: "pending",
                status: { $nin: ["cancelled", "delivered"] },
            }).populate("customer", "personalInfo").lean();
            if (!order) return res.status(404).json({ title: "Pedido no encontrado", message: "Ese pedido ya se cobró o se canceló." });
            if (order.status !== "ready") {
                return res.status(409).json({ title: "Todavía en cocina", message: "Este pedido se cobra cuando cocina lo marque como listo." });
            }
            if (order.isDelivery || order.fulfillment === "delivery") {
                return res.status(400).json({ title: "Pedido a domicilio", message: "Los pedidos a domicilio los cobra el repartidor." });
            }
            plan = {
                kind: "pickup",
                orders: [order],
                total: round2(order.total || 0),
                creditApplied: round2(order.payment?.creditApplied || 0),
                customerName: customerNameOf(order),
            };
        } else if (body.source === "counter") {
            const sale = body.sale || {};
            const cart = Array.isArray(sale.items) ? sale.items : [];
            const built = await buildItems(cart);
            if (built.error) return res.status(400).json({ title: "No se pudo armar la venta", message: built.error });
            // Comentario libre por producto ("sin hielo"), igual que el mesero
            built.items.forEach((line, index) => {
                const comment = typeof cart[index]?.comment === "string" ? cart[index].comment.trim().slice(0, 120) : "";
                if (comment) line.notes = [line.notes, `Nota: ${comment}`].filter(Boolean).join(" · ").slice(0, 300);
            });
            plan = {
                kind: "counter",
                items: built.items,
                total: built.subtotal,
                creditApplied: 0,
                customerName: String(sale.customerName || "").trim().slice(0, 60) || null,
                fulfillment: sale.fulfillment === "dine_in" ? "dine_in" : "pickup",
                notes: String(sale.notes || "").trim().slice(0, 300) || undefined,
            };
        } else {
            return res.status(400).json({ title: "Cobro inválido", message: "Indica qué se va a cobrar." });
        }

        const amountDue = round2(Math.max(plan.total - plan.creditApplied, 0) + tip);
        const parsedPayment = parsePayment(body.payment, amountDue);
        if (parsedPayment.error) return res.status(400).json({ title: "Pago", message: parsedPayment.error });
        const { payment } = parsedPayment;

        // --- 2. Se aplica el cobro a los pedidos ---
        let orderIds = [];
        let orderCodes = [];
        let receiptItems = [];

        if (plan.kind === "table") {
            const settled = await settleTableTab({ tableId: plan.table._id, paymentMethod: payment.method });
            if (settled.code !== 200) return res.status(settled.code).json(settled.body);
            orderIds = settled.orders.map((o) => o._id);
            orderCodes = settled.orders.map((o) => orderCode(o));
            receiptItems = lineItems(settled.orders);
            if (body.releaseTable !== false) await releaseTable(plan.table._id);
        } else if (plan.kind === "pickup") {
            const order = plan.orders[0];
            const updated = await Order.findOneAndUpdate(
                { _id: order._id, paymentStatus: "pending" },
                {
                    $set: {
                        paymentStatus: "paid",
                        paymentMethod: payment.method,
                        "payment.collectedBy": session.cashier.id,
                        "payment.collectedAmount": round2(amountDue - tip),
                        "payment.collectedAt": new Date(),
                    },
                },
                { returnDocument: "after" },
            );
            if (!updated) return res.status(409).json({ title: "Ya se cobró", message: "Otro cobro se adelantó con este pedido." });
            // Si ya estaba listo, se entrega en el mismo momento (genera su factura)
            if (updated.status === "ready") await applyOrderStatus({ orderId: updated._id, status: "delivered", user: null });
            else await emitOrder(updated._id);
            orderIds = [updated._id];
            orderCodes = [orderCode(updated)];
            receiptItems = lineItems([updated]);
        } else {
            const newOrder = new Order({
                orderType: "local",
                channel: "counter",
                fulfillment: plan.fulfillment,
                isDelivery: false,
                localCustomerName: plan.customerName || undefined,
                notes: plan.notes,
                soldBy: { id: session.cashier.id, name: session.cashier.name },
                paymentMethod: payment.method,
                paymentStatus: "paid",
                items: plan.items,
                total: plan.total,
                status: "pending",
                statusHistory: [{ status: "pending", changedAt: new Date() }],
            });
            await newOrder.save();
            const populated = await Order.findById(newOrder._id)
                .populate("table", "number status")
                .populate(WAITER_POPULATE)
                .populate("customer", "personalInfo");
            emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_CREATED, { order: populated.toObject() });
            orderIds = [newOrder._id];
            orderCodes = [orderCode(newOrder)];
            receiptItems = lineItems([newOrder]);
        }

        // --- 3. Comprobante ---
        const { base, iva } = splitIva(plan.total);
        const correlative = await nextDocumentCorrelative(documentType);
        const issuedAt = new Date();
        const customer = { ...parsedCustomer.customer };
        if (!customer.name && plan.customerName) customer.name = plan.customerName;

        const receipt = await CashReceipt.create({
            session: session._id,
            deviceId: session.deviceId,
            cashier: session.cashier,
            documentType,
            dteType: DOCUMENT_TYPES[documentType].code,
            correlative,
            controlNumber: controlNumberFor(documentType, correlative),
            generationCode: newGenerationCode(),
            receptionSeal: newReceptionSeal(issuedAt),
            source: {
                kind: plan.kind,
                tableNumber: plan.table?.number ?? null,
                orders: orderIds,
                orderCodes,
                customerName: plan.customerName,
            },
            items: receiptItems.map(({ notes, ...item }) => item),
            base,
            iva,
            total: plan.total,
            creditApplied: plan.creditApplied,
            tip,
            amountDue,
            payment,
            customer,
            issuedAt,
        });

        // La factura de venta (Invoice) de esos pedidos queda con el método real
        await Invoice.updateMany({ order: { $in: orderIds } }, { $set: { paymentMethod: payment.method } });

        const label = plan.kind === "table" ? `Mesa ${plan.table.number}` : plan.kind === "pickup" ? `pedido ${orderCodes[0]}` : `venta de mostrador ${orderCodes[0]}`;
        await notificationUtils.createNotification({
            req,
            actor: { id: session.cashier.id, role: "employee", name: session.cashier.name, image: null },
            category: "orders",
            action: "updated",
            title: "Cobro en caja",
            message: (who) => `${who.name} cobró ${label} ($${amountDue.toFixed(2)} ${payment.method === "cash" ? "en efectivo" : "con tarjeta"})`,
            icon: "cash-register",
            severity: "success",
            entity: { model: "CashReceipt", id: receipt._id, label: receipt.controlNumber },
        });

        requestCashierRefresh();
        emitToRoles(["admin"], SOCKET_EVENTS.CASHIER_DEVICES_CHANGED, {});

        return res.status(201).json({
            title: "Cobro registrado",
            message: payment.method === "cash" && payment.change > 0 ? `Vuelto: $${payment.change.toFixed(2)}` : "Cobro registrado.",
            data: { receipt: publicReceipt(receipt), issuer: ISSUER },
        });
    } catch (error) {
        console.error("cashierController.charge:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/orders/:id/deliver — entregar un pedido ya pagado y listo
cashierController.deliverOrder = async (req, res) => {
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return undefined;

        const order = await Order.findOne({
            _id: req.params.id,
            paymentStatus: "paid",
            $or: [{ channel: "counter" }, { orderType: "online", isDelivery: { $ne: true } }],
        }).lean();
        if (!order) return res.status(404).json({ title: "Pedido no encontrado", message: "Ese pedido no se entrega en caja." });
        if (order.status !== "ready") {
            return res.status(409).json({ title: "Todavía no está listo", message: "Cocina todavía no marca este pedido como listo." });
        }

        const result = await applyOrderStatus({ orderId: order._id, status: "delivered", user: null });
        if (result.code !== 200) return res.status(result.code).json(result.body);
        requestCashierRefresh();
        return res.status(200).json({ title: "Pedido entregado", message: `${orderCode(order)} se entregó al cliente.` });
    } catch (error) {
        console.error("cashierController.deliverOrder:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// GET /cashier/receipts — comprobantes del turno abierto
cashierController.getReceipts = async (req, res) => {
    try {
        const session = await currentSession(req.cashierDevice.deviceId);
        if (!session) return res.status(200).json({ receipts: [] });
        const receipts = await CashReceipt.find({ session: session._id }).sort({ issuedAt: -1 }).lean();
        return res.status(200).json({ receipts: receipts.map(publicReceipt), issuer: ISSUER });
    } catch (error) {
        console.error("cashierController.getReceipts:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// GET /cashier/receipts/:id — un comprobante de esta caja (para reimprimir)
cashierController.getReceipt = async (req, res) => {
    try {
        const receipt = await CashReceipt.findOne({ _id: req.params.id, deviceId: req.cashierDevice.deviceId }).lean();
        if (!receipt) return res.status(404).json({ title: "Comprobante no encontrado", message: "No existe ese comprobante en esta caja." });
        return res.status(200).json({ receipt: publicReceipt(receipt), issuer: ISSUER });
    } catch (error) {
        console.error("cashierController.getReceipt:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/movements { type: "in"|"out", amount, reason }
cashierController.addMovement = async (req, res) => {
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return undefined;

        const { type, reason } = req.body || {};
        const amount = round2(Number(req.body?.amount));
        if (!["in", "out"].includes(type)) return res.status(400).json({ title: "Movimiento inválido", message: "Indica si es entrada o salida de efectivo." });
        if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CASH_MOVEMENT) {
            return res.status(400).json({ title: "Monto inválido", message: `El monto debe estar entre $0.01 y $${MAX_CASH_MOVEMENT}.` });
        }
        const cleanReason = String(reason || "").trim().slice(0, 120);
        if (!cleanReason) return res.status(400).json({ title: "Falta el motivo", message: "Escribe el motivo del movimiento." });

        if (type === "out") {
            const receipts = await CashReceipt.find({ session: session._id }).lean();
            const { expectedCash } = summarizeSession(session, receipts);
            if (amount > expectedCash) {
                return res.status(400).json({ title: "No alcanza", message: `En la gaveta debería haber $${expectedCash.toFixed(2)}: no se puede sacar más que eso.` });
            }
        }

        session.movements.push({ type, amount, reason: cleanReason, at: new Date() });
        await session.save();
        const data = await sessionWithSummary(session);
        notifyCashierSession(session.deviceId, data);
        emitToRoles(["admin"], SOCKET_EVENTS.CASHIER_DEVICES_CHANGED, {});
        return res.status(201).json({ title: "Movimiento registrado", message: type === "in" ? "Entrada de efectivo registrada." : "Salida de efectivo registrada.", data });
    } catch (error) {
        console.error("cashierController.addMovement:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// POST /cashier/session/close { countedCash, notes } — arqueo y corte Z
cashierController.closeOwnShift = async (req, res) => {
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return undefined;

        const countedCash = Number(req.body?.countedCash);
        if (!Number.isFinite(countedCash) || countedCash < 0 || countedCash > 100000) {
            return res.status(400).json({ title: "Arqueo", message: "Escribe cuánto efectivo contaste en la gaveta." });
        }

        const closed = await closeSession(session, {
            countedCash,
            notes: String(req.body?.notes || "").trim().slice(0, 300) || null,
            closedBy: { kind: "cashier", name: session.cashier.name },
        });
        if (!closed) return res.status(409).json({ title: "Turno cerrado", message: "Este turno ya estaba cerrado." });

        await broadcastCashier();
        await notificationUtils.createNotification({
            req,
            actor: { id: session.cashier.id, role: "employee", name: session.cashier.name, image: null },
            category: "settings",
            action: "updated",
            title: "Corte de caja",
            message: (who) => {
                const diff = closed.difference;
                const detail = diff === 0 ? "sin diferencia" : diff > 0 ? `sobrante de $${diff.toFixed(2)}` : `faltante de $${Math.abs(diff).toFixed(2)}`;
                return `${who.name} cerró el turno ${closed.code}: ventas $${closed.summary.sales.toFixed(2)}, ${detail}`;
            },
            icon: "cash-register",
            severity: closed.difference === 0 ? "success" : "warning",
            entity: { model: "CashSession", id: closed._id, label: closed.code },
        });

        return res.status(200).json({ title: "Turno cerrado", message: "El corte de caja quedó registrado.", data: { session: publicSession(closed), issuer: ISSUER } });
    } catch (error) {
        console.error("cashierController.closeOwnShift:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

export default cashierController;
