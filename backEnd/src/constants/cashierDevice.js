// Identidad de las pantallas de caja (POS, proyecto SYSCOR-cashierSystem).
//
// Igual que una pantalla de cocina, la caja no es una persona: se empareja
// una vez (un administrador escribe en el panel el código que muestra) y se
// identifica con un token de dispositivo. Quién cobra no lo decide la
// pantalla: lo decide el administrador al abrir el turno (ver
// cashSessionModel), y todo cobro queda a nombre de ese cajero.

export const CASHIER_DEVICE_ROLE = "CASHIER_DEVICE";

// Permisos de una caja. Menor privilegio: ver lo que hay por cobrar, cobrar
// y entregar, y administrar su propio turno (movimientos y cierre).
export const CASHIER_DEVICE_PERMISSIONS = Object.freeze([
    "cashier:read",
    "cashier:charge",
    "cashier:shift",
]);

// Audiencia propia: un token de caja no vale como sesión ni como pantalla de
// cocina (además se firma con otra llave).
export const CASHIER_DEVICE_AUDIENCE = "syscor-pos";

export const CASHIER_DEVICE_TOKEN_TTL = "30d";

// Código del lobby (mismo formato que cocina)
export const CASHIER_PAIRING_CODE_LENGTH = 6;
export const CASHIER_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const CASHIER_MAX_PENDING_PAIRINGS = 20;

// Límites de dinero que acepta la caja (evitan errores de dedo absurdos)
export const MAX_OPENING_FLOAT = 2000;
export const MAX_CASH_MOVEMENT = 5000;
export const MAX_CASH_RECEIVED = 10000;

export default {
    CASHIER_DEVICE_ROLE,
    CASHIER_DEVICE_PERMISSIONS,
    CASHIER_DEVICE_AUDIENCE,
    CASHIER_DEVICE_TOKEN_TTL,
    CASHIER_PAIRING_CODE_LENGTH,
    CASHIER_PAIRING_CODE_TTL_MS,
    CASHIER_MAX_PENDING_PAIRINGS,
    MAX_OPENING_FLOAT,
    MAX_CASH_MOVEMENT,
    MAX_CASH_RECEIVED,
};
