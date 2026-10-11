// Autenticación de las pantallas de caja (POS) en la API HTTP.
//
// Mismo esquema deny-by-default que las pantallas de cocina
// (kitchenDeviceMiddleware):
//   1. attachCashierDevice (global, en app.js) identifica la caja por su
//      "Authorization: Bearer". Si el token ya no sirve responde 401 (la
//      caja vuelve a su lobby); si va a cualquier ruta fuera de /api/cashier,
//      responde 403.
//   2. requireCashierDevice(permiso) exige el permiso en cada ruta de caja.
//   3. validateAuthCookie y requirePermission también rechazan a una caja.
import { readBearerToken } from "../../utils/kitchen/deviceTokenUtils.js";
import { authenticateCashierToken, claimsToBeCashierDevice } from "../../utils/cashier/cashierDeviceUtils.js";
import { CASHIER_DEVICE_PERMISSIONS } from "../../constants/cashierDevice.js";

export const rejectCashierDevice = (res) =>
    res.status(403).json({
        code: "DEVICE_FORBIDDEN",
        title: "Acceso denegado",
        message: "Una caja solo puede usar las rutas del sistema de caja.",
    });

export const attachCashierDevice = (cashierPrefix) => async (req, res, next) => {
    try {
        const token = readBearerToken(req.headers.authorization);
        if (!token || !claimsToBeCashierDevice(token)) return next();

        const result = await authenticateCashierToken(token);
        if (!result.ok) {
            return res.status(401).json({ code: "DEVICE_UNAUTHORIZED", reason: result.reason, title: result.title, message: result.message });
        }

        const path = req.path.replace(/\/+$/, "");
        if (path !== cashierPrefix && !path.startsWith(`${cashierPrefix}/`)) return rejectCashierDevice(res);

        req.cashierDevice = { deviceId: result.deviceId, permissions: result.permissions };
        // La identidad es la caja y nada más: una cookie de admin del mismo
        // navegador no le presta permisos.
        req.user = undefined;
        return next();
    } catch (error) {
        console.error("attachCashierDevice:", error);
        return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno al validar la caja." });
    }
};

export const requireCashierDevice = (permission) => (req, res, next) => {
    if (!req.cashierDevice) {
        return res.status(401).json({ code: "DEVICE_UNAUTHORIZED", title: "Caja no reconocida", message: "Esta ruta es solo para cajas emparejadas." });
    }
    const granted = req.cashierDevice.permissions.includes(permission) && CASHIER_DEVICE_PERMISSIONS.includes(permission);
    if (!granted) {
        return res.status(403).json({ code: "DEVICE_FORBIDDEN", title: "Acceso denegado", message: `Esta caja no tiene el permiso ${permission}.` });
    }
    return next();
};

export default { attachCashierDevice, requireCashierDevice, rejectCashierDevice };
