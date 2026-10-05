// Token de dispositivo de las pantallas de cocina (KDS).
//
// Es un JWT, pero distinto en todo al de sesión de usuario:
//   - Se firma con OTRA llave (config.jwt.deviceSecret) y lleva audiencia
//     propia, así que nunca valida como sesión aunque se copie a la cookie.
//   - Viaja en "Authorization: Bearer", no en cookie: la pantalla no tiene
//     usuario y su token se lo entrega el servidor por socket al emparejarla.
//   - Su payload es restringido: rol KITCHEN_DEVICE, el deviceId y los
//     permisos de cocina. No trae ningún dato de una persona.
import crypto from "crypto";
import jsonwebtoken from "jsonwebtoken";
import { config } from "../../../config.js";
import {
    KITCHEN_DEVICE_ROLE,
    KITCHEN_DEVICE_PERMISSIONS,
    KITCHEN_DEVICE_AUDIENCE,
    KITCHEN_DEVICE_TOKEN_TTL,
} from "../../constants/kitchenDevice.js";

// Sin JWT_DEVICE_SECRET_KEY se deriva una llave de la de sesiones con HMAC:
// sigue siendo distinta (un token de sesión no valida aquí ni viceversa).
const deviceSecret = () =>
    config.jwt.deviceSecret ||
    crypto.createHmac("sha256", String(config.jwt.secret || "")).update("syscor:kitchen-device").digest("hex");

// UUID que genera el navegador (crypto.randomUUID)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isValidDeviceId = (value) => typeof value === "string" && UUID_RE.test(value);

export const signDeviceToken = (device) =>
    jsonwebtoken.sign(
        {
            role: KITCHEN_DEVICE_ROLE,
            deviceId: device.deviceId,
            permissions: [...KITCHEN_DEVICE_PERMISSIONS],
            // Con esto se revoca: si el registro cambia de versión, el token muere
            tokenVersion: device.tokenVersion,
        },
        deviceSecret(),
        { expiresIn: KITCHEN_DEVICE_TOKEN_TTL, audience: KITCHEN_DEVICE_AUDIENCE, subject: device.deviceId },
    );

// Verifica firma, vencimiento, audiencia y forma del payload. Lanza el error
// de jsonwebtoken si algo no cuadra.
export const verifyDeviceToken = (token) => {
    const decoded = jsonwebtoken.verify(token, deviceSecret(), { audience: KITCHEN_DEVICE_AUDIENCE });
    if (decoded.role !== KITCHEN_DEVICE_ROLE || !isValidDeviceId(decoded.deviceId)) {
        throw new jsonwebtoken.JsonWebTokenError("Token de dispositivo con forma inválida");
    }
    return decoded;
};

// "Authorization: Bearer <token>" -> token (o null)
export const readBearerToken = (header) => {
    const match = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
    return match ? match[1].trim() : null;
};

export default { isValidDeviceId, signDeviceToken, verifyDeviceToken, readBearerToken };
