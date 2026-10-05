// Autenticación de las pantallas de cocina (KDS) en la API HTTP.
//
// Las pantallas no tienen cookie de sesión: mandan su token de dispositivo en
// "Authorization: Bearer". El esquema es de menor privilegio y deny-by-default:
//
//   1. attachKitchenDevice (global, en app.js) identifica la pantalla. Si el
//      token ya no sirve (vencido, revocado, cocina apagada) responde 401 y la
//      pantalla vuelve a su lobby. Si la petición va a cualquier ruta fuera de
//      /api/kitchen, responde 403: finanzas, usuarios, reportes, menú, etc.
//      quedan negados sin tener que tocarlos uno por uno.
//   2. requireKitchenDevice(permiso) exige el permiso concreto en cada ruta de
//      cocina (routes/kitchen/kitchenRoutes.js).
//   3. Defensa extra: validateAuthCookie y requirePermission también rechazan
//      con 403 a una pantalla, aunque el navegador traiga una cookie de admin.
import jsonwebtoken from "jsonwebtoken";
import { readBearerToken } from "../../utils/kitchen/deviceTokenUtils.js";
import { authenticateDeviceToken } from "../../utils/kitchen/kitchenDeviceUtils.js";
import {
    KITCHEN_DEVICE_ROLE,
    KITCHEN_DEVICE_AUDIENCE,
    KITCHEN_DEVICE_PERMISSIONS,
} from "../../constants/kitchenDevice.js";

// ¿El token DICE ser de una pantalla de cocina? (todavía sin verificarlo).
// Otros Bearer que pudieran llegar (ej. un webhook externo) pasan de largo.
const claimsToBeKitchenDevice = (token) => {
    const payload = jsonwebtoken.decode(token);
    return Boolean(payload) && (payload.role === KITCHEN_DEVICE_ROLE || payload.aud === KITCHEN_DEVICE_AUDIENCE);
};

/**
 * @param {string} kitchenPrefix Ruta base de las rutas de cocina ("/api/kitchen").
 *   Una pantalla de cocina no puede llegar a NINGUNA otra ruta, ni siquiera a
 *   las que son públicas para usuarios (mesas, carritos, menú...): 403 antes
 *   de enrutar.
 */
export const attachKitchenDevice = (kitchenPrefix) => async (req, res, next) => {
    try {
        const token = readBearerToken(req.headers.authorization);
        if (!token || !claimsToBeKitchenDevice(token)) return next();

        const result = await authenticateDeviceToken(token);
        if (!result.ok) {
            return res.status(401).json({ code: "DEVICE_UNAUTHORIZED", reason: result.reason, title: result.title, message: result.message });
        }

        const path = req.path.replace(/\/+$/, "");
        if (path !== kitchenPrefix && !path.startsWith(`${kitchenPrefix}/`)) return rejectKitchenDevice(res);

        req.kitchenDevice = { deviceId: result.deviceId, permissions: result.permissions };
        // La identidad de la petición es la pantalla y nada más: si el mismo
        // navegador tiene una sesión de admin, esa cookie no le presta permisos.
        req.user = undefined;
        return next();
    } catch (error) {
        console.error("attachKitchenDevice:", error);
        return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno al validar la pantalla de cocina." });
    }
};

// Guardia de las rutas de cocina. El permiso se exige al token Y a la lista
// fija del servidor: aunque alguien firmara un token con más permisos, una
// pantalla nunca podría usar uno que no sea de cocina.
export const requireKitchenDevice = (permission) => (req, res, next) => {
    if (!req.kitchenDevice) {
        return res.status(401).json({ code: "DEVICE_UNAUTHORIZED", title: "Pantalla no reconocida", message: "Esta ruta es solo para pantallas de cocina emparejadas." });
    }
    const granted = req.kitchenDevice.permissions.includes(permission) && KITCHEN_DEVICE_PERMISSIONS.includes(permission);
    if (!granted) {
        return res.status(403).json({ code: "DEVICE_FORBIDDEN", title: "Acceso denegado", message: `Esta pantalla de cocina no tiene el permiso ${permission}.` });
    }
    return next();
};

// Respuesta común cuando una pantalla de cocina llega a una ruta de usuarios
export const rejectKitchenDevice = (res) =>
    res.status(403).json({
        code: "DEVICE_FORBIDDEN",
        title: "Acceso denegado",
        message: "Una pantalla de cocina solo puede leer comandas y cambiar su estado.",
    });

export default { attachKitchenDevice, requireKitchenDevice, rejectKitchenDevice };
