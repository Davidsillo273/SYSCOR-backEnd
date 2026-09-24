import crypto from "crypto";
import { config } from "../../../config.js";

// Cifrado del número de las tarjetas guardadas por los clientes.
//
// Wompi todavía no nos entrega un token de tarjeta reutilizable, así que para
// que el cliente no tenga que volver a escribir su tarjeta se guarda el número
// cifrado con AES-256-GCM. El CVV nunca se guarda: se pide en cada compra.
//
// El número cifrado solo se descifra en el servidor al momento de cobrar; a la
// app únicamente le llegan la marca y los últimos 4 dígitos.
//
// La clave sale de CARD_ENCRYPTION_KEY. Si no está definida se deriva de la
// clave de JWT para que el sistema funcione en desarrollo, pero en producción
// conviene definirla aparte: si alguien cambia JWT_Secret_key, las tarjetas
// guardadas dejarían de poder descifrarse.
const PREFIX = "enc_v1";

const getKey = () => {
    const secret = config.cards?.encryptionKey || config.jwt.secret;
    if (!secret) throw new Error("Falta la clave para cifrar tarjetas (CARD_ENCRYPTION_KEY).");
    return crypto.createHash("sha256").update(String(secret)).digest();
};

const encrypt = (plainText) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
    const data = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
};

const decrypt = (token) => {
    const [prefix, iv, tag, data] = String(token || "").split(":");
    if (prefix !== PREFIX || !iv || !tag || !data) throw new Error("Token de tarjeta con formato desconocido.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

export default { encrypt, decrypt };
