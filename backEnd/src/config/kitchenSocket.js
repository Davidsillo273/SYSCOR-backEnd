// Tiempo real de las pantallas de cocina (KDS): namespace "/kitchen".
//
// Va aparte del namespace principal ("/"), que sigue exigiendo la cookie de
// sesión de un usuario: una pantalla de cocina no tiene usuario. Aquí entran
// de dos formas:
//
//   1. Sin token (emparejamiento): la pantalla manda solo su deviceId. El
//      servidor le asigna un código de 6 dígitos que ella muestra en su lobby.
//      En este modo NO recibe ninguna comanda: solo su código y, cuando un
//      admin escribe ese código en el panel, su token de dispositivo.
//   2. Con token de dispositivo válido: entra a la sala "devices" y recibe las
//      comandas, ya recortadas a lo que necesita cocina (kitchenOrderView).
//
// El token se entrega SOLO al socket que tiene ese código (no a una sala ni
// por deviceId): quien no está físicamente frente a esa pantalla no puede
// recibirlo aunque conozca su deviceId.
//
// Los códigos viven en memoria: el backend corre en una sola instancia. Si un
// día se escala a varias, esto tendría que pasar a Redis (adapter de Socket.IO).
import crypto from "crypto";
import KitchenDeviceModel from "../models/kitchen/kitchenDeviceModel.js";
import { authenticateDeviceToken } from "../utils/kitchen/kitchenDeviceUtils.js";
import { readBearerToken, isValidDeviceId } from "../utils/kitchen/deviceTokenUtils.js";
import { toKitchenOrder } from "../utils/kitchen/kitchenOrderView.js";
import { PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, MAX_PENDING_PAIRINGS } from "../constants/kitchenDevice.js";

export const KITCHEN_NAMESPACE = "/kitchen";

export const KITCHEN_SOCKET_EVENTS = {
    // Al lobby: el código que debe mostrar para emparejarse
    PAIRING_CODE: "kitchen:pairing_code",
    // Al lobby: emparejada, aquí está su token
    DEVICE_PAIRED: "kitchen:device_paired",
    // A la pantalla: la desvincularon (kill switch), vuelve al lobby
    DEVICE_REVOKED: "kitchen:device_revoked",
};

const DEVICES_ROOM = "devices";
const deviceRoom = (deviceId) => `device:${deviceId}`;

let kitchenNs = null;

// --- Códigos de emparejamiento ---
const pendingByCode = new Map(); // código -> { deviceId, socketId, userAgent, expiresAt }
const codeBySocket = new Map();  // socketId -> código

const generateCode = () => {
    const max = 10 ** PAIRING_CODE_LENGTH;
    let code;
    do {
        code = String(crypto.randomInt(0, max)).padStart(PAIRING_CODE_LENGTH, "0");
    } while (pendingByCode.has(code));
    return code;
};

const dropCode = (socket) => {
    clearTimeout(socket.data.codeTimer);
    const code = codeBySocket.get(socket.id);
    if (code) pendingByCode.delete(code);
    codeBySocket.delete(socket.id);
};

const issueCode = (socket) => {
    dropCode(socket);
    if (pendingByCode.size >= MAX_PENDING_PAIRINGS) {
        socket.emit("kitchen:pairing_unavailable", { message: "Hay demasiadas pantallas esperando código. Intenta en unos minutos." });
        socket.disconnect(true);
        return;
    }
    const code = generateCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    pendingByCode.set(code, {
        deviceId: socket.data.pairing.deviceId,
        socketId: socket.id,
        userAgent: socket.data.pairing.userAgent,
        expiresAt,
    });
    codeBySocket.set(socket.id, code);
    socket.emit(KITCHEN_SOCKET_EVENTS.PAIRING_CODE, { code, expiresAt: new Date(expiresAt).toISOString() });
    // Al vencer, la pantalla recibe uno nuevo sola
    socket.data.codeTimer = setTimeout(() => issueCode(socket), PAIRING_CODE_TTL_MS);
};

// El emparejamiento pendiente de un código (o null si no existe o venció)
export const findPairing = (code) => {
    const pairing = pendingByCode.get(String(code || "").trim());
    if (!pairing || pairing.expiresAt < Date.now()) return null;
    return pairing;
};

// Entrega el token SOLO al socket que mostró ese código
export const deliverDeviceToken = (pairing, payload) => {
    const socket = kitchenNs?.sockets.get(pairing.socketId);
    if (!socket) return false;
    socket.emit(KITCHEN_SOCKET_EVENTS.DEVICE_PAIRED, payload);
    dropCode(socket);
    return true;
};

// --- Kill switch ---
// Avisa a las pantallas revocadas y corta sus sockets. El aviso es la vía
// rápida; aunque se perdiera, al reconectar su token ya no pasa el middleware.
export const disconnectKitchenDevices = (deviceIds, info = {}) => {
    if (!kitchenNs) return;
    for (const deviceId of deviceIds) {
        kitchenNs.to(deviceRoom(deviceId)).emit(KITCHEN_SOCKET_EVENTS.DEVICE_REVOKED, info);
        setTimeout(() => kitchenNs.in(deviceRoom(deviceId)).disconnectSockets(true), 300);
    }
};

// --- Reenvío de eventos a las pantallas ---
// socket.js llama esto con los eventos de comandas y del sistema de cocina.
// Nunca se reenvía el payload tal cual: las comandas van recortadas.
export const relayToKitchenDevices = (event, payload = {}) => {
    if (!kitchenNs) return;
    try {
        let data;
        if (payload.order) data = { order: toKitchenOrder(payload.order) };
        else if (payload.kitchen) {
            const { enabled, warningMinutes, maxMinutes } = payload.kitchen;
            data = { kitchen: { enabled, warningMinutes, maxMinutes } };
        } else if (payload.orderId) data = { orderId: String(payload.orderId) };
        else return;
        kitchenNs.to(DEVICES_ROOM).emit(event, data);
    } catch (error) {
        console.error("kitchenSocket.relayToKitchenDevices:", error);
    }
};

// Middleware del namespace: decide si es una pantalla emparejada o una que
// está pidiendo código. Un token presente pero inválido NO cae a modo
// emparejamiento: se rechaza para que la pantalla lo borre y vuelva a pedir.
const authenticateKitchenSocket = async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token || readBearerToken(socket.handshake.headers?.authorization);
        if (token) {
            const result = await authenticateDeviceToken(token);
            if (!result.ok) {
                const error = new Error("DEVICE_UNAUTHORIZED");
                error.data = { reason: result.reason, title: result.title, message: result.message };
                return next(error);
            }
            socket.data.device = { deviceId: result.deviceId };
            return next();
        }

        const deviceId = socket.handshake.auth?.deviceId;
        if (!isValidDeviceId(deviceId)) return next(new Error("DEVICE_ID_REQUIRED"));
        socket.data.pairing = {
            deviceId,
            userAgent: String(socket.handshake.headers?.["user-agent"] || "").slice(0, 200),
        };
        return next();
    } catch (error) {
        console.error("kitchenSocket.authenticate:", error);
        return next(new Error("DEVICE_AUTH_FAILED"));
    }
};

export const initKitchenSocket = (io) => {
    kitchenNs = io.of(KITCHEN_NAMESPACE);
    kitchenNs.use(authenticateKitchenSocket);

    kitchenNs.on("connection", (socket) => {
        if (socket.data.device) {
            const { deviceId } = socket.data.device;
            socket.join(DEVICES_ROOM);
            socket.join(deviceRoom(deviceId));
            KitchenDeviceModel.updateOne({ deviceId }, { $set: { lastSeenAt: new Date() } })
                .catch((error) => console.error("kitchenSocket.lastSeenAt:", error));
            return;
        }

        issueCode(socket);
        socket.on("disconnect", () => dropCode(socket));
    });

    return kitchenNs;
};

export default {
    KITCHEN_NAMESPACE,
    KITCHEN_SOCKET_EVENTS,
    initKitchenSocket,
    findPairing,
    deliverDeviceToken,
    disconnectKitchenDevices,
    relayToKitchenDevices,
};
