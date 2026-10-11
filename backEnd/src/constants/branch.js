// Datos del local (los mismos que usa la app de clientes en
// apps/customer/src/constants/branch.js). De aquí sale la ruta de cada
// entrega a domicilio.
export const BRANCH = {
    name: "Taquería El Corral",
    address: "Km 14½, Carretera Troncal del Norte, Apopa",
    latitude: 13.8068232,
    longitude: -89.1705956,
    // Hora de El Salvador (UTC-6, sin horario de verano).
    utcOffsetMinutes: -6 * 60,
};

// Minutos del día en hora de El Salvador.
export const localMinutesOfDay = (date = new Date()) => {
    const utc = date.getUTCHours() * 60 + date.getUTCMinutes();
    return (utc + BRANCH.utcOffsetMinutes + 24 * 60) % (24 * 60);
};

// Fecha y hora en El Salvador, en texto: "sábado 11 de octubre, 2:05 p. m."
// (o solo "2:05 p. m." con { dateToo: false }). Es lo que se le pasa a
// Panchita: el servidor corre en UTC y, si recibe una fecha ISO, el modelo
// lee la hora UTC como si fuera la local (6 horas adelantada).
const TIME_ZONE = "America/El_Salvador";
export const formatLocalTime = (value, { dateToo = true } = {}) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const time = date.toLocaleTimeString("es-SV", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
    if (!dateToo) return time;
    const day = date.toLocaleDateString("es-SV", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long" });
    return `${day}, ${time}`;
};

export default BRANCH;
