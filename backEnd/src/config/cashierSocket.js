// Tiempo real de las pantallas de caja (POS): namespace "/cashier".
//
// Funciona igual que el de cocina (kitchenSocket.js):
//   1. Sin token: la caja manda solo su deviceId y recibe un código de 6
//      dígitos para su lobby. No recibe nada más.
//   2. Con token válido: entra a la sala "devices" y a la suya propia.
//
// A diferencia de cocina, a la caja no se le manda el contenido de los
// pedidos por socket: solo un aviso de "algo cambió" (cashier:refresh) y ella
// vuelve a pedir lo que tiene por cobrar. Así lo que ve siempre sale de la
// misma consulta, con los montos calculados en el servidor.
//
// Los códigos viven en memoria (una sola instancia del backend).
import crypto from "crypto";
import CashierDeviceModel from "../models/cashier/cashierDeviceModel.js";
import { authenticateCashierToken, isValidDeviceId } from "../utils/cashier/cashierDeviceUtils.js";
import { readBearerToken } from "../utils/kitchen/deviceTokenUtils.js";
import {
    CASHIER_PAIRING_CODE_LENGTH,
    CASHIER_PAIRING_CODE_TTL_MS,
    CASHIER_MAX_PENDING_PAIRINGS,
} from "../constants/cashierDevice.js";

export const CASHIER_NAMESPACE = "/cashier";

export const CASHIER_SOCKET_EVENTS = {
    PAIRING_CODE: "cashier:pairing_code",
    PAIRING_UNAVAILABLE: "cashier:pairing_unavailable",
    DEVICE_PAIRED: "cashier:device_paired",
    DEVICE_REVOKED: "cashier:device_revoked",
    // Se abrió o se cerró el turno de esta caja
    SESSION_CHANGED: "cashier:session_changed",
    // Cambió algo de lo que hay por cobrar o entregar: volver a consultar
    REFRESH: "cashier:refresh",
};

const DEVICES_ROOM = "devices";
const deviceRoom = (deviceId) => `device:${deviceId}`;

let cashierNs = null;

const pendingByCode = new Map();
const codeBySocket = new Map();

const generateCode = () => {
    const max = 10 ** CASHIER_PAIRING_CODE_LENGTH;
    let code;
    do {
        code = String(crypto.randomInt(0, max)).padStart(CASHIER_PAIRING_CODE_LENGTH, "0");
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
    if (pendingByCode.size >= CASHIER_MAX_PENDING_PAIRINGS) {
        socket.emit(CASHIER_SOCKET_EVENTS.PAIRING_UNAVAILABLE, { message: "Hay demasiadas cajas esperando código. Intenta en unos minutos." });
        socket.disconnect(true);
        return;
    }
    const code = generateCode();
    const expiresAt = Date.now() + CASHIER_PAIRING_CODE_TTL_MS;
    pendingByCode.set(code, {
        deviceId: socket.data.pairing.deviceId,
        socketId: socket.id,
        userAgent: socket.data.pairing.userAgent,
        expiresAt,
    });
    codeBySocket.set(socket.id, code);
    socket.emit(CASHIER_SOCKET_EVENTS.PAIRING_CODE, { code, expiresAt: new Date(expiresAt).toISOString() });
    socket.data.codeTimer = setTimeout(() => issueCode(socket), CASHIER_PAIRING_CODE_TTL_MS);
};

export const findCashierPairing = (code) => {
    const pairing = pendingByCode.get(String(code || "").trim());
    if (!pairing || pairing.expiresAt < Date.now()) return null;
    return pairing;
};

export const deliverCashierToken = (pairing, payload) => {
    const socket = cashierNs?.sockets.get(pairing.socketId);
    if (!socket) return false;
    socket.emit(CASHIER_SOCKET_EVENTS.DEVICE_PAIRED, payload);
    dropCode(socket);
    return true;
};

export const disconnectCashierDevices = (deviceIds, info = {}) => {
    if (!cashierNs) return;
    for (const deviceId of deviceIds) {
        cashierNs.to(deviceRoom(deviceId)).emit(CASHIER_SOCKET_EVENTS.DEVICE_REVOKED, info);
        setTimeout(() => cashierNs.in(deviceRoom(deviceId)).disconnectSockets(true), 300);
    }
};

// Turno abierto o cerrado en una caja: solo a esa caja
export const notifyCashierSession = (deviceId, session) => {
    if (!cashierNs) return;
    cashierNs.to(deviceRoom(deviceId)).emit(CASHIER_SOCKET_EVENTS.SESSION_CHANGED, { session });
};

// Aviso a todas las cajas de que vuelvan a consultar. Se agrupan los avisos
// de un mismo instante (cobrar una mesa cambia varias comandas a la vez).
let refreshTimer = null;
export const requestCashierRefresh = () => {
    if (!cashierNs || refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        cashierNs.to(DEVICES_ROOM).emit(CASHIER_SOCKET_EVENTS.REFRESH, {});
    }, 400);
};

const authenticateCashierSocket = async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token || readBearerToken(socket.handshake.headers?.authorization);
        if (token) {
            const result = await authenticateCashierToken(token);
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
        console.error("cashierSocket.authenticate:", error);
        return next(new Error("DEVICE_AUTH_FAILED"));
    }
};

export const initCashierSocket = (io) => {
    cashierNs = io.of(CASHIER_NAMESPACE);
    cashierNs.use(authenticateCashierSocket);

    cashierNs.on("connection", (socket) => {
        if (socket.data.device) {
            const { deviceId } = socket.data.device;
            socket.join(DEVICES_ROOM);
            socket.join(deviceRoom(deviceId));
            CashierDeviceModel.updateOne({ deviceId }, { $set: { lastSeenAt: new Date() } })
                .catch((error) => console.error("cashierSocket.lastSeenAt:", error));
            return;
        }

        issueCode(socket);
        socket.on("disconnect", () => dropCode(socket));
    });

    return cashierNs;
};

export default {
    CASHIER_NAMESPACE,
    CASHIER_SOCKET_EVENTS,
    initCashierSocket,
    findCashierPairing,
    deliverCashierToken,
    disconnectCashierDevices,
    notifyCashierSession,
    requestCashierRefresh,
};
