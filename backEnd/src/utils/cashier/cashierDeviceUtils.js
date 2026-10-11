// Token, validación y revocación de las pantallas de caja (POS).
//
// Mismo esquema que las pantallas de cocina (utils/kitchen), pero con su
// propia llave derivada, su propia audiencia y sus propios permisos: un token
// de caja no sirve en cocina ni como sesión de usuario, y viceversa.
import crypto from "crypto";
import jsonwebtoken from "jsonwebtoken";
import { config } from "../../../config.js";
import CashierDeviceModel from "../../models/cashier/cashierDeviceModel.js";
import SettingsModel from "../../models/settings/settingsModel.js";
import { isValidDeviceId } from "../kitchen/deviceTokenUtils.js";
import {
    CASHIER_DEVICE_ROLE,
    CASHIER_DEVICE_PERMISSIONS,
    CASHIER_DEVICE_AUDIENCE,
    CASHIER_DEVICE_TOKEN_TTL,
} from "../../constants/cashierDevice.js";

export { isValidDeviceId };

const cashierSecret = () =>
    crypto
        .createHmac("sha256", String(config.jwt.deviceSecret || config.jwt.secret || ""))
        .update("syscor:cashier-device")
        .digest("hex");

export const signCashierToken = (device) =>
    jsonwebtoken.sign(
        {
            role: CASHIER_DEVICE_ROLE,
            deviceId: device.deviceId,
            permissions: [...CASHIER_DEVICE_PERMISSIONS],
            tokenVersion: device.tokenVersion,
        },
        cashierSecret(),
        { expiresIn: CASHIER_DEVICE_TOKEN_TTL, audience: CASHIER_DEVICE_AUDIENCE, subject: device.deviceId },
    );

const verifyCashierToken = (token) => {
    const decoded = jsonwebtoken.verify(token, cashierSecret(), { audience: CASHIER_DEVICE_AUDIENCE });
    if (decoded.role !== CASHIER_DEVICE_ROLE || !isValidDeviceId(decoded.deviceId)) {
        throw new jsonwebtoken.JsonWebTokenError("Token de caja con forma inválida");
    }
    return decoded;
};

// ¿El token DICE ser de una caja? (todavía sin verificarlo)
export const claimsToBeCashierDevice = (token) => {
    const payload = jsonwebtoken.decode(token);
    return Boolean(payload) && (payload.role === CASHIER_DEVICE_ROLE || payload.aud === CASHIER_DEVICE_AUDIENCE);
};

const REJECTIONS = {
    expired: { title: "Caja desvinculada", message: "El acceso de esta caja venció. Un administrador debe emparejarla otra vez." },
    invalid: { title: "Caja no reconocida", message: "El token de esta caja no es válido." },
    revoked: { title: "Caja desvinculada", message: "Un administrador desvinculó esta caja." },
    disabled: { title: "Caja deshabilitada", message: "El sistema de caja está deshabilitado." },
};

/**
 * ¿Este token es de una caja que sigue autorizada AHORA? Registro activo,
 * misma versión y el sistema de caja encendido. El turno abierto NO se exige
 * aquí: una caja emparejada sin turno sigue conectada, esperando a que un
 * administrador lo abra.
 */
export const authenticateCashierToken = async (token) => {
    let decoded;
    try {
        decoded = verifyCashierToken(token);
    } catch (error) {
        const reason = error.name === "TokenExpiredError" ? "expired" : "invalid";
        return { ok: false, reason, ...REJECTIONS[reason] };
    }

    const [device, settings] = await Promise.all([
        CashierDeviceModel.findOne({ deviceId: decoded.deviceId }).select("active tokenVersion").lean(),
        SettingsModel.findOne().select("cashier.enabled").lean(),
    ]);

    if (!device || !device.active || device.tokenVersion !== decoded.tokenVersion) {
        return { ok: false, reason: "revoked", ...REJECTIONS.revoked };
    }
    if (!settings?.cashier?.enabled) {
        return { ok: false, reason: "disabled", ...REJECTIONS.disabled };
    }

    return { ok: true, deviceId: decoded.deviceId, permissions: decoded.permissions || [] };
};

// Kill switch: desactiva cajas y sube su versión (sus tokens mueren ya)
export const revokeCashierDevices = async (filter = {}) => {
    const devices = await CashierDeviceModel.find({ ...filter, active: true }).select("deviceId").lean();
    if (devices.length === 0) return [];
    await CashierDeviceModel.updateMany(
        { _id: { $in: devices.map((device) => device._id) } },
        { $set: { active: false, revokedAt: new Date() }, $inc: { tokenVersion: 1 } },
    );
    return devices.map((device) => device.deviceId);
};

export const publicCashierDevice = (device) => ({
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

export default {
    signCashierToken,
    claimsToBeCashierDevice,
    authenticateCashierToken,
    revokeCashierDevices,
    publicCashierDevice,
};
