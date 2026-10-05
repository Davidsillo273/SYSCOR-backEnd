// Validación y revocación de las pantallas de cocina emparejadas.
import KitchenDeviceModel from "../../models/kitchen/kitchenDeviceModel.js";
import SettingsModel from "../../models/settings/settingsModel.js";
import { verifyDeviceToken } from "./deviceTokenUtils.js";

// Motivos de rechazo. Todos son 401: el token ya no sirve y la pantalla debe
// volver a su lobby a emparejarse (el 403 queda para "token válido, pero esto
// no le toca a una pantalla de cocina").
const REJECTIONS = {
    expired: { title: "Pantalla desvinculada", message: "El acceso de esta pantalla venció. Un administrador debe emparejarla otra vez." },
    invalid: { title: "Pantalla no reconocida", message: "El token de esta pantalla no es válido." },
    revoked: { title: "Pantalla desvinculada", message: "Un administrador desvinculó esta pantalla de cocina." },
    disabled: { title: "Cocina deshabilitada", message: "El sistema de cocina está deshabilitado." },
};

/**
 * ¿Este token es de una pantalla de cocina que sigue autorizada AHORA?
 * No basta con la firma: el registro tiene que seguir activo, con la misma
 * versión, y el sistema de cocina encendido. Así el kill switch es inmediato.
 *
 * @returns {Promise<{ ok: true, deviceId: string, permissions: string[] } | { ok: false, reason: string, title: string, message: string }>}
 */
export const authenticateDeviceToken = async (token) => {
    let decoded;
    try {
        decoded = verifyDeviceToken(token);
    } catch (error) {
        const reason = error.name === "TokenExpiredError" ? "expired" : "invalid";
        return { ok: false, reason, ...REJECTIONS[reason] };
    }

    const [device, settings] = await Promise.all([
        KitchenDeviceModel.findOne({ deviceId: decoded.deviceId }).select("active tokenVersion").lean(),
        SettingsModel.findOne().select("kitchen.enabled").lean(),
    ]);

    if (!device || !device.active || device.tokenVersion !== decoded.tokenVersion) {
        return { ok: false, reason: "revoked", ...REJECTIONS.revoked };
    }
    if (!settings?.kitchen?.enabled) {
        return { ok: false, reason: "disabled", ...REJECTIONS.disabled };
    }

    return { ok: true, deviceId: decoded.deviceId, permissions: decoded.permissions || [] };
};

// Kill switch: desactiva pantallas y sube su versión, así cualquier token que
// ya tengan deja de valer en la siguiente petición. Devuelve los deviceId
// afectados para cortar también sus sockets.
export const revokeKitchenDevices = async (filter = {}) => {
    const devices = await KitchenDeviceModel.find({ ...filter, active: true }).select("deviceId").lean();
    if (devices.length === 0) return [];
    await KitchenDeviceModel.updateMany(
        { _id: { $in: devices.map((device) => device._id) } },
        { $set: { active: false, revokedAt: new Date() }, $inc: { tokenVersion: 1 } },
    );
    return devices.map((device) => device.deviceId);
};

// Lo que ve el panel de una pantalla emparejada
export const publicDevice = (device) => ({
    deviceId: device.deviceId,
    shortId: device.deviceId.slice(0, 8).toUpperCase(),
    label: device.label,
    active: device.active,
    userAgent: device.userAgent,
    pairedBy: device.pairedBy?.name || null,
    pairedAt: device.pairedAt,
    revokedAt: device.revokedAt,
    lastSeenAt: device.lastSeenAt,
});

export default { authenticateDeviceToken, revokeKitchenDevices, publicDevice };
