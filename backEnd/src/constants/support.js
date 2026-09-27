// Canales para hablar con una persona del equipo. Son los mismos que usa la
// app de clientes (packages/shared/src/constants/support.js) y el sistema
// web: el teléfono sirve para llamar y para WhatsApp.
export const SUPPORT = {
    email: "taqueriaelcorralsyscor@gmail.com",
    phone: "7168-6876",
    phoneIntl: "50371686876",
    // Horario en que alguien responde (el mismo de la taquería).
    hours: "todos los días de 10:00 a. m. a 9:00 p. m.",
};

export const SUPPORT_LINKS = {
    whatsapp: `https://wa.me/${SUPPORT.phoneIntl}`,
    call: `tel:+${SUPPORT.phoneIntl}`,
    email: `mailto:${SUPPORT.email}`,
};

export default SUPPORT;
