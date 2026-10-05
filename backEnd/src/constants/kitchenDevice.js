// Identidad de las pantallas de cocina (KDS, proyecto SYSCOR-kitchenSystem).
//
// Una pantalla de cocina no es una persona: no inicia sesión con correo y
// contraseña. Se empareja una sola vez (un administrador escribe en el panel
// el código que muestra la pantalla) y desde ahí se identifica con un token
// de dispositivo, que solo sirve para lo que la cocina necesita.

export const KITCHEN_DEVICE_ROLE = "KITCHEN_DEVICE";

// Permisos de una pantalla de cocina. Menor privilegio: leer sus comandas y
// cambiarles el estado entre "En cocina" y "Lista". Nada más.
export const KITCHEN_DEVICE_PERMISSIONS = Object.freeze(["orders:read", "orders:update_status"]);

// Estados a los que una pantalla de cocina puede mover una comanda. "delivered"
// genera la factura y "cancelled" es una decisión de caja/admin: no son de cocina.
export const KITCHEN_DEVICE_STATUSES = Object.freeze(["preparing", "ready"]);

// Audiencia del JWT: un token de dispositivo no se confunde con uno de sesión
// aunque alguien lo copie a la cookie (además se firma con otra llave).
export const KITCHEN_DEVICE_AUDIENCE = "syscor-kds";

// Vida del token. La pantalla vive encendida en la cocina; al vencer vuelve al
// lobby y un admin la empareja otra vez. Revocarla (kill switch) es inmediato,
// no depende de este plazo.
export const KITCHEN_DEVICE_TOKEN_TTL = "30d";

// Código que muestra el lobby para emparejarse
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
// Tope de pantallas esperando código a la vez (el namespace de emparejamiento
// no exige sesión: esto evita que alguien llene la memoria abriendo conexiones).
export const MAX_PENDING_PAIRINGS = 50;

export default {
    KITCHEN_DEVICE_ROLE,
    KITCHEN_DEVICE_PERMISSIONS,
    KITCHEN_DEVICE_STATUSES,
    KITCHEN_DEVICE_AUDIENCE,
    KITCHEN_DEVICE_TOKEN_TTL,
    PAIRING_CODE_LENGTH,
    PAIRING_CODE_TTL_MS,
    MAX_PENDING_PAIRINGS,
};
