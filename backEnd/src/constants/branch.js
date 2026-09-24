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

export default BRANCH;
