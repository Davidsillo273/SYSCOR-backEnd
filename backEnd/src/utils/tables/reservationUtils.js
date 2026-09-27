// Reglas de las reservas de mesa que hacen los clientes desde la app al
// pedir "Comer en el local" (ver reservationController y checkoutController).
import TablesModel, { TABLE_FLOORS, TABLE_ZONES } from "../../models/tables/tablesModel.js";
import Reservation from "../../models/tables/reservationModel.js";
import { BRANCH, localMinutesOfDay } from "../../constants/branch.js";
import notificationUtils from "../notifications/notificationUtils.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Horario de la taquería (todos los días, hora de El Salvador). Es el mismo
// que muestra la app en apps/customer/src/constants/branch.js.
export const OPENS_AT = 10 * 60;
export const CLOSES_AT = 21 * 60;
// La última reserva es una hora antes de cerrar, para que dé tiempo de comer.
export const LAST_SLOT = CLOSES_AT - 60;
export const SLOT_STEP = 30;
// Se puede reservar para hoy y hasta 3 días adelante.
export const MAX_DAYS_AHEAD = 3;
// Con cuánta anticipación mínima se puede reservar.
export const MIN_LEAD_MS = 30 * MINUTE;
// Cuánto se le guarda la mesa después de la hora.
export const GRACE_MS = 30 * MINUTE;
// Cuánto dura una comida: dos reservas de la misma mesa no pueden quedar
// a menos de esto una de otra.
export const DINING_MS = 90 * MINUTE;
// La mesa pasa a 'reservada' (y deja de darse a quien llegue sin reserva)
// este tiempo antes de la hora.
export const HOLD_BEFORE_MS = 30 * MINUTE;
// Desde cuándo se puede escanear el QR para marcar la llegada.
export const CHECK_IN_BEFORE_MS = 60 * MINUTE;

const TABLES_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.tables;

// Número de día en hora de El Salvador (para comparar "hoy" con "en 3 días").
const localDay = (date) => Math.floor((date.getTime() + BRANCH.utcOffsetMinutes * MINUTE) / DAY);

// Revisa que la hora pedida sea reservable. Devuelve un mensaje si no lo es.
export const validateReservationTime = (value, now = new Date()) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Elige el día y la hora de tu visita.";

    const minutes = localMinutesOfDay(date);
    if (minutes < OPENS_AT || minutes > LAST_SLOT || minutes % SLOT_STEP !== 0 || date.getUTCSeconds() !== 0) {
        return "Esa hora no está en el horario de reservas (10:00 a. m. a 8:00 p. m.).";
    }
    if (date.getTime() < now.getTime() + MIN_LEAD_MS) {
        return "Reserva con al menos 30 minutos de anticipación.";
    }
    if (localDay(date) - localDay(now) > MAX_DAYS_AHEAD) {
        return "Solo se puede reservar hasta 3 días adelante.";
    }
    return null;
};

export const publicTable = (table) => ({
    id: String(table._id),
    number: table.number,
    capacity: table.capacity || 4,
    floor: table.floor || 1,
    floorLabel: TABLE_FLOORS[table.floor || 1],
    zone: table.zone,
    zoneLabel: TABLE_ZONES[table.zone]?.label || "",
    position: table.position || null,
});

// Todas las mesas con dos marcas para esa hora: `available` (nadie más la
// tiene) y `fits` (caben las personas).
export const tablesForSlot = async ({ reservedFor, partySize, excludeReservationId = null, now = new Date() }) => {
    const when = new Date(reservedFor).getTime();
    const [tables, conflicts] = await Promise.all([
        TablesModel.find().sort({ floor: 1, number: 1 }),
        Reservation.find({
            status: { $in: ["reserved", "checked_in"] },
            table: { $ne: null },
            reservedFor: { $gt: new Date(when - DINING_MS), $lt: new Date(when + DINING_MS) },
            ...(excludeReservationId ? { _id: { $ne: excludeReservationId } } : {}),
        }).select("table"),
    ]);

    const taken = new Set(conflicts.map((r) => String(r.table)));
    // Si la visita es pronto, lo que pasa hoy en la mesa también cuenta:
    // una mesa ocupada o apartada a mano no se libera sola.
    const soon = when - now.getTime() < DINING_MS;

    return tables.map((table) => {
        const heldByOther =
            table.status === "reservada" && String(table.reservation || "") !== String(excludeReservationId || "");
        const busyNow = soon && (table.status === "ocupada" || heldByOther);
        return {
            ...publicTable(table),
            available: !taken.has(String(table._id)) && !busyNow,
            fits: (table.capacity || 4) >= partySize,
        };
    });
};

// La mesa que Panchita propone: la más chica donde caben, y entre iguales la
// de número menor. Así las grandes quedan para los grupos grandes.
export const pickBestTable = (tables, floor = null) =>
    tables
        .filter((t) => t.available && t.fits && (floor === null || t.floor === floor))
        .sort((a, b) => a.capacity - b.capacity || a.number - b.number)[0] || null;

// Plantas donde hay al menos una mesa libre en la que caben.
export const floorsWithRoom = (tables) =>
    [...new Set(tables.filter((t) => t.available && t.fits).map((t) => t.floor))].sort();

const emitTable = (table) => {
    if (table) emitToRoles(TABLES_AUDIENCE, SOCKET_EVENTS.TABLE_UPDATED, { table: table.toObject() });
};

// Suelta la mesa que tenía apartada una reserva (si la seguía teniendo).
export const releaseHeldTable = async (reservation) => {
    if (!reservation?.table) return;
    const table = await TablesModel.findOneAndUpdate(
        { _id: reservation.table, status: "reservada", reservation: reservation._id },
        { $set: { status: "libre", reservation: null }, $unset: { customerName: "", peopleCount: "" } },
        { new: true },
    );
    emitTable(table);
};

// Cancela la reserva de un pedido (el cliente canceló) y suelta su mesa.
export const cancelReservationOfOrder = async (orderId) => {
    const reservation = await Reservation.findOneAndUpdate(
        { order: orderId, status: { $in: ["pending_table", "reserved"] } },
        { $set: { status: "cancelled" } },
        { new: true },
    );
    if (reservation) await releaseHeldTable(reservation);
};

// Pone al día las reservas con la hora actual:
//   1. vence las que pasaron 30 min de su hora sin llegada y suelta la mesa;
//   2. a las que siguen sin mesa cuando ya falta poco, les asigna la mejor;
//   3. aparta ('reservada') la mesa de las que están por llegar.
// No hay un proceso aparte que lo corra de fondo en todos los servidores, así
// que se llama al leer mesas o reservas (igual que flagDelayedOrders con los
// pedidos) y además cada minuto desde index.js. Si ya está corriendo, se
// espera a esa misma vuelta.
let running = null;
export const syncReservations = () => {
    if (!running) {
        running = runSync()
            .catch((error) => console.error("reservationUtils.syncReservations:", error))
            .finally(() => {
                running = null;
            });
    }
    return running;
};

const runSync = async () => {
    const now = new Date();

    const expired = await Reservation.find({
        status: { $in: ["pending_table", "reserved"] },
        expiresAt: { $lt: now },
    });
    for (const reservation of expired) {
        const updated = await Reservation.findOneAndUpdate(
            { _id: reservation._id, status: reservation.status },
            { $set: { status: "expired" } },
        );
        if (updated) await releaseHeldTable(reservation);
    }

    const holdLimit = new Date(now.getTime() + HOLD_BEFORE_MS);

    const unassigned = await Reservation.find({ status: "pending_table", reservedFor: { $lte: holdLimit } });
    for (const reservation of unassigned) {
        const tables = await tablesForSlot({
            reservedFor: reservation.reservedFor,
            partySize: reservation.partySize,
            excludeReservationId: reservation._id,
            now,
        });
        const best = pickBestTable(tables);
        if (best) {
            await Reservation.updateOne(
                { _id: reservation._id, status: "pending_table" },
                { $set: { status: "reserved", table: best.id } },
            );
        }
    }

    const upcoming = await Reservation.find({
        status: "reserved",
        reservedFor: { $lte: holdLimit },
        expiresAt: { $gte: now },
    });
    for (const reservation of upcoming) {
        const table = await TablesModel.findOneAndUpdate(
            { _id: reservation.table, status: "libre" },
            {
                $set: {
                    status: "reservada",
                    reservation: reservation._id,
                    customerName: reservation.displayName || reservation.alias || "Reserva app",
                    peopleCount: reservation.partySize,
                },
            },
            { new: true },
        );
        emitTable(table);
    }
};

export default {
    validateReservationTime,
    tablesForSlot,
    pickBestTable,
    floorsWithRoom,
    publicTable,
    releaseHeldTable,
    cancelReservationOfOrder,
    syncReservations,
};
