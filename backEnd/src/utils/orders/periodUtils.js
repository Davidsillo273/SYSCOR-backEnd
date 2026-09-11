// Resuelve un filtro de fecha ("período") a partir de los query params que
// mandan las pantallas de leaderboard (clientes y empleados). Antes cada
// tarjeta del ranking tenía su rango fijo (7 días, semana en curso, todo el
// historial); ahora todas aceptan el mismo vocabulario de período, para que
// un único selector en el frontend controle las dos pantallas.
//
// Vocabulario soportado:
//   - period=day    -> desde las 00:00 de hoy
//   - period=week   -> desde el lunes de esta semana (semana ISO, lunes a domingo)
//   - period=month  -> desde el día 1 del mes en curso
//   - period=year   -> desde el 1 de enero del año en curso
//   - period=all    -> sin filtro de fecha (todo el historial)
//   - from & to     -> rango personalizado (fechas ISO), ignora "period" si
//     ambas vienen presentes
//
// Devuelve { start, end } listos para un $match de Mongo con $gte/$lte, o
// { start: null, end: null } cuando el período es "all" (sin filtro).
const startOfDay = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

const startOfWeek = (date) => {
    const d = startOfDay(date);
    const dow = d.getDay();
    // getDay() da 0 para domingo; se quiere que la semana empiece en lunes.
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return d;
};

export const resolvePeriodRange = (query = {}) => {
    const now = new Date();

    // Rango personalizado: si mandan ambas fechas, tienen prioridad sobre
    // "period". Fechas inválidas se ignoran y se cae al período por defecto,
    // para no reventar el reporte por un parámetro mal formado.
    if (query.from && query.to) {
        const from = new Date(query.from);
        const to = new Date(query.to);

        if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
            // El "to" se extiende hasta el final de ese día, para que un rango
            // "2026-09-01 a 2026-09-01" incluya todo ese día y no solo su
            // primer instante (medianoche).
            const end = new Date(to);
            end.setHours(23, 59, 59, 999);
            return { start: startOfDay(from), end, period: "custom" };
        }
    }

    const period = ["day", "week", "month", "year", "all"].includes(query.period)
        ? query.period
        : "week";

    switch (period) {
        case "day":
            return { start: startOfDay(now), end: null, period };
        case "month":
            return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null, period };
        case "year":
            return { start: new Date(now.getFullYear(), 0, 1), end: null, period };
        case "all":
            return { start: null, end: null, period };
        case "week":
        default:
            return { start: startOfWeek(now), end: null, period: "week" };
    }
};

// Arma la parte "createdAt" de un filtro de Mongo a partir del rango
// resuelto. Si start es null (período "all"), no agrega ninguna condición.
export const buildDateMatch = ({ start, end }, field = "createdAt") => {
    if (!start) return {};

    const condition = { $gte: start };
    if (end) condition.$lte = end;

    return { [field]: condition };
};

export default { resolvePeriodRange, buildDateMatch };
