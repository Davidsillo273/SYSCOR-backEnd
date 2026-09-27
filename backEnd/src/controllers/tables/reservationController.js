// Reservas de mesa desde la app de clientes ("Comer en el local").
//
// Flujo:
//   1. En la pantalla de pago la app consulta /availability para no dejar
//      pagar una visita para la que no hay mesa.
//   2. Al aprobarse el pago se crea la reserva sin mesa (checkoutController).
//   3. Panchita abre un chat: pide /options, pregunta la planta si hay lugar
//      en las dos, enseña en el croquis la mesa sugerida y la confirma con
//      /assign (o el cliente elige otra).
//   4. Al llegar, el cliente escanea el QR de la mesa: /check-in la pasa a
//      'ocupada' y marca que sí llegó.
import Reservation from "../../models/tables/reservationModel.js";
import TablesModel, { TABLE_FLOORS } from "../../models/tables/tablesModel.js";
import Order from "../../models/orders/orderModel.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";
import {
    validateReservationTime,
    tablesForSlot,
    pickBestTable,
    floorsWithRoom,
    publicTable,
    releaseHeldTable,
    syncReservations,
    CHECK_IN_BEFORE_MS,
    HOLD_BEFORE_MS,
} from "../../utils/tables/reservationUtils.js";

const reservationController = {};

const parsePartySize = (value) => {
    const size = Number(value);
    return Number.isInteger(size) && size >= 1 && size <= 20 ? size : null;
};

export const publicReservation = (reservation) => ({
    id: String(reservation._id),
    orderId: String(reservation.order),
    status: reservation.status,
    reservedFor: reservation.reservedFor,
    expiresAt: reservation.expiresAt,
    partySize: reservation.partySize,
    alias: reservation.alias || "",
    table: reservation.table && reservation.table.number ? publicTable(reservation.table) : null,
    checkedInAt: reservation.checkedInAt || null,
});

const findOwnReservation = (req, filter) =>
    Reservation.findOne({ ...filter, customer: req.user.id }).populate("table");

// GET /reservations/availability?reservedFor=ISO&partySize=N
// Antes de pagar: ¿hay alguna mesa para esa hora y esas personas?
reservationController.getAvailability = async (req, res) => {
    try {
        const partySize = parsePartySize(req.query.partySize);
        if (!partySize) return res.status(400).json({ title: "Revisa las personas", message: "Indica para cuántas personas es la mesa." });
        const timeError = validateReservationTime(req.query.reservedFor);
        if (timeError) return res.status(400).json({ title: "Revisa la hora", message: timeError });

        await syncReservations();
        const tables = await tablesForSlot({ reservedFor: req.query.reservedFor, partySize });
        const floors = floorsWithRoom(tables);
        const maxCapacity = tables.reduce((max, t) => Math.max(max, t.capacity), 0);

        return res.status(200).json({
            available: floors.length > 0,
            floors,
            maxCapacity,
            message:
                floors.length > 0
                    ? null
                    : partySize > maxCapacity
                        ? `Nuestra mesa más grande es para ${maxCapacity} personas.`
                        : "No quedan mesas para esa hora. Prueba con otra.",
        });
    } catch (error) {
        console.error("reservationController.getAvailability:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos revisar las mesas." });
    }
};

// GET /reservations/by-order/:orderId
reservationController.getByOrder = async (req, res) => {
    try {
        await syncReservations();
        const reservation = await findOwnReservation(req, { order: req.params.orderId });
        if (!reservation) return res.status(404).json({ title: "Sin reserva", message: "Ese pedido no tiene mesa reservada." });
        return res.status(200).json(publicReservation(reservation));
    } catch (error) {
        console.error("reservationController.getByOrder:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos consultar tu reserva." });
    }
};

// GET /reservations/:id/options
// Todas las mesas por planta (para dibujar el croquis), marcando cuáles se
// pueden elegir y cuál propone Panchita en cada planta.
reservationController.getOptions = async (req, res) => {
    try {
        await syncReservations();
        const reservation = await findOwnReservation(req, { _id: req.params.id });
        if (!reservation) return res.status(404).json({ title: "Reserva no encontrada", message: "No encontramos tu reserva." });

        const tables = await tablesForSlot({
            reservedFor: reservation.reservedFor,
            partySize: reservation.partySize,
            excludeReservationId: reservation._id,
        });
        // La mesa que ya tiene sigue siendo suya aunque la vea "ocupada" por él.
        const ownTableId = reservation.table ? String(reservation.table._id) : null;
        const marked = tables.map((t) => (t.id === ownTableId ? { ...t, available: true } : t));

        const floors = Object.keys(TABLE_FLOORS).map(Number).map((floor) => ({
            floor,
            label: TABLE_FLOORS[floor],
            tables: marked.filter((t) => t.floor === floor),
            suggestedId: pickBestTable(marked, floor)?.id || null,
        }));

        return res.status(200).json({
            reservation: publicReservation(reservation),
            floors,
            floorsWithRoom: floorsWithRoom(marked),
        });
    } catch (error) {
        console.error("reservationController.getOptions:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos buscar mesas." });
    }
};

// POST /reservations/:id/assign { tableId }
// El cliente acepta la mesa sugerida o elige otra. Se puede cambiar mientras
// no haya llegado.
reservationController.assignTable = async (req, res) => {
    try {
        await syncReservations();
        const reservation = await findOwnReservation(req, { _id: req.params.id });
        if (!reservation) return res.status(404).json({ title: "Reserva no encontrada", message: "No encontramos tu reserva." });
        if (!["pending_table", "reserved"].includes(reservation.status)) {
            return res.status(400).json({ title: "Ya no se puede cambiar", message: "Esta reserva ya no admite cambios de mesa." });
        }

        const tables = await tablesForSlot({
            reservedFor: reservation.reservedFor,
            partySize: reservation.partySize,
            excludeReservationId: reservation._id,
        });
        const chosen = tables.find((t) => t.id === String(req.body?.tableId || ""));
        const isOwn = reservation.table && String(reservation.table._id) === chosen?.id;
        if (!chosen) return res.status(404).json({ title: "Mesa no encontrada", message: "Esa mesa no existe." });
        if (!chosen.fits) {
            return res.status(400).json({
                title: "No caben",
                message: `La mesa ${chosen.number} es para ${chosen.capacity} personas y tu reserva es para ${reservation.partySize}.`,
            });
        }
        if (!chosen.available && !isOwn) {
            return res.status(409).json({ title: "Mesa ocupada", message: `Alguien más tomó la mesa ${chosen.number}. Elige otra.` });
        }

        // Si cambia de mesa y la anterior ya estaba apartada, se suelta.
        if (reservation.table && !isOwn) await releaseHeldTable(reservation);

        const updated = await Reservation.findOneAndUpdate(
            { _id: reservation._id, status: { $in: ["pending_table", "reserved"] } },
            { $set: { status: "reserved", table: chosen.id } },
            { new: true },
        );
        if (!updated) return res.status(409).json({ title: "Reserva cambió", message: "Vuelve a abrir tu reserva." });

        // Si la visita es pronto, se aparta la mesa de una vez.
        if (updated.reservedFor.getTime() - Date.now() <= HOLD_BEFORE_MS) await syncReservations();

        await notificationUtils.createNotification({
            req,
            category: "tables",
            action: "reserved",
            title: "Mesa reservada desde la app",
            message: () =>
                `${updated.displayName || "Un cliente"} reservó la Mesa ${chosen.number} para ${updated.partySize} ` +
                `(${updated.reservedFor.toLocaleString("es-SV", { timeZone: "America/El_Salvador", dateStyle: "short", timeStyle: "short" })})`,
            icon: "chair",
            severity: "info",
            entity: { model: "Tables", id: chosen.id, label: `Mesa ${chosen.number}` },
        });

        const populated = await Reservation.findById(updated._id).populate("table");
        return res.status(200).json(publicReservation(populated));
    } catch (error) {
        console.error("reservationController.assignTable:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos reservar la mesa." });
    }
};

// El QR de la mesa trae "syscor-mesa:<token>". Se acepta también el token solo.
const tokenFromCode = (code) => {
    const text = String(code || "").trim();
    const match = text.match(/^syscor-mesa:([A-Za-z0-9_-]{6,64})$/);
    if (match) return match[1];
    return /^[A-Za-z0-9_-]{6,64}$/.test(text) ? text : null;
};

// POST /reservations/check-in { code }
// El cliente escaneó el QR de su mesa: llegó. La mesa pasa a 'ocupada' y el
// pedido queda ligado a ella, para que el mesero lo sirva ahí.
reservationController.checkIn = async (req, res) => {
    try {
        const token = tokenFromCode(req.body?.code);
        if (!token) return res.status(400).json({ title: "Código no válido", message: "Ese código no es el de una mesa de El Corral." });

        await syncReservations();
        const table = await TablesModel.findOne({ qrToken: token });
        if (!table) return res.status(404).json({ title: "Mesa no encontrada", message: "Ese código no es el de una mesa de El Corral." });

        const now = Date.now();
        const reservations = await Reservation.find({ customer: req.user.id, status: "reserved" })
            .populate("table")
            .sort({ reservedFor: 1 });
        // La que toca ahora (se puede llegar hasta 1 hora antes).
        const current = reservations.find(
            (r) => r.reservedFor.getTime() - CHECK_IN_BEFORE_MS <= now && r.expiresAt.getTime() >= now,
        );
        if (!current) {
            const next = reservations[0];
            return res.status(400).json({
                title: next ? "Todavía no es tu hora" : "Sin reserva activa",
                message: next
                    ? `Tu reserva es para las ${next.reservedFor.toLocaleTimeString("es-SV", { timeZone: "America/El_Salvador", hour: "numeric", minute: "2-digit" })}. Puedes escanear desde 1 hora antes.`
                    : "No tienes una mesa reservada para esta hora.",
            });
        }
        if (String(current.table?._id) !== String(table._id)) {
            return res.status(400).json({
                title: "Esa no es tu mesa",
                message: `Tu mesa es la ${current.table?.number}. Busca su código QR.`,
            });
        }
        if (table.status === "ocupada") {
            return res.status(409).json({
                title: "La mesa sigue ocupada",
                message: "Avísale a un mesero: te ayudará a liberarla o a darte otra.",
            });
        }

        const checkedIn = await Reservation.findOneAndUpdate(
            { _id: current._id, status: "reserved" },
            { $set: { status: "checked_in", checkedInAt: new Date() } },
            { new: true },
        );
        if (!checkedIn) return res.status(409).json({ title: "Reserva cambió", message: "Vuelve a intentarlo." });

        const occupied = await TablesModel.findByIdAndUpdate(
            table._id,
            {
                $set: {
                    status: "ocupada",
                    occupiedAt: new Date(),
                    customerName: current.displayName || current.alias || "Reserva app",
                    peopleCount: current.partySize,
                    reservation: null,
                },
            },
            { new: true },
        );
        emitToRoles(notificationUtils.AUDIENCE_BY_CATEGORY.tables, SOCKET_EVENTS.TABLE_UPDATED, { table: occupied.toObject() });

        const order = await Order.findByIdAndUpdate(current.order, { $set: { table: table._id } }, { new: true })
            .populate("table", "number status")
            .populate("customer", "personalInfo");
        if (order) {
            emitToRoles(notificationUtils.AUDIENCE_BY_CATEGORY.orders, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });
        }

        await notificationUtils.createNotification({
            req,
            category: "tables",
            action: "status_changed",
            title: "Cliente llegó a su mesa",
            message: () => `${current.displayName || "Un cliente"} llegó a la Mesa ${table.number} (reserva de la app)`,
            icon: "chair",
            severity: "success",
            entity: { model: "Tables", id: table._id, label: `Mesa ${table.number}` },
        });

        const populated = await Reservation.findById(checkedIn._id).populate("table");
        return res.status(200).json(publicReservation(populated));
    } catch (error) {
        console.error("reservationController.checkIn:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos registrar tu llegada." });
    }
};

export default reservationController;
