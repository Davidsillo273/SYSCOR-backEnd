// Capa de tiempo real del sistema (Socket.IO).
//
// Antes, el panel preguntaba al servidor cada 30 segundos si había novedades
// (sondeo/polling). Eso significaba hasta 30 segundos de retraso para ver una
// mesa desocuparse o una comanda cambiar de estado, y una petición constante
// por cada pestaña abierta aunque no hubiera pasado nada.
//
// Ahora es el servidor quien avisa: cuando un controlador guarda un cambio,
// llama a emitToRoles/emitNotification y el panel lo recibe al instante.
//
// Reglas de este módulo:
//   - NUNCA lanza un error hacia el controlador. Si el tiempo real falla, la
//     operación de negocio (guardar el pedido, liberar la mesa) sigue su curso.
//     Igual que notificationUtils.createNotification.
//   - No decide QUÉ mostrar, solo A QUIÉN mandarlo. El filtro por rol es el
//     mismo "audience" que ya calcula notificationUtils.
import { Server } from "socket.io";
import jsonwebtoken from "jsonwebtoken";
import { config } from "../../config.js";
import EmployeeModel from "../models/users/employeeModel.js";

// Instancia única del servidor de sockets. Se llena en initSocket() y se lee
// desde getIO(); mientras sea null, los emit son operaciones vacías (útil en
// pruebas o si el servidor todavía no terminó de levantar).
let io = null;

// --- Nombres de eventos ---
// Se declaran aquí para que backend y frontend no se desincronicen por un
// typo: el frontend importa esta misma lista desde su propio constants.
export const SOCKET_EVENTS = {
    // Órdenes/comandas
    ORDER_CREATED: "order:created",
    ORDER_UPDATED: "order:updated",
    ORDER_DELETED: "order:deleted",
    // Mesas
    TABLE_CREATED: "table:created",
    TABLE_UPDATED: "table:updated",
    TABLE_DELETED: "table:deleted",
    TABLES_BULK_UPDATED: "table:bulk_updated",
    // Notificaciones del sistema (la campana del TopBar)
    NOTIFICATION_CREATED: "notification:created",
};

/**
 * Lee la cookie de sesión del handshake y devuelve el token.
 *
 * El cliente NO puede leer la cookie authCookie (es httpOnly), así que tampoco
 * puede mandárnosla a mano en el auth del handshake. Pero el navegador sí la
 * adjunta sola a la petición de conexión, siempre que el cliente use
 * withCredentials y CORS permita credenciales. Por eso la sacamos del header.
 */
const readAuthCookie = (handshake) => {
    const rawCookie = handshake?.headers?.cookie;
    if (!rawCookie) return null;

    // Formato del header: "nombre=valor; otro=valor"
    const match = rawCookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("authCookie="));

    if (!match) return null;

    return decodeURIComponent(match.slice("authCookie=".length));
};

/**
 * Middleware de autenticación del socket.
 *
 * Usa exactamente la misma cookie y el mismo secreto que validateAuthCookie,
 * así que un socket conectado equivale a una sesión válida de la API: no hay
 * una segunda forma de autenticarse que pudiera quedar desactualizada.
 *
 * A diferencia de attachUser, aquí SÍ se rechaza la conexión sin sesión: un
 * socket anónimo no tendría ninguna room a la que pertenecer.
 */
const authenticateSocket = async (socket, next) => {
    try {
        const token = readAuthCookie(socket.handshake);
        if (!token) return next(new Error("Sesión requerida"));

        const decoded = jsonwebtoken.verify(token, config.jwt.secret);

        // El token guarda id, rol y permisos, pero no el puesto del empleado
        // (personalInfo.type), que es lo que separa cocina de meseros. Para
        // los empleados lo consultamos una sola vez, al conectar, y de paso
        // confirmamos que la cuenta siga activa.
        let employeeType = null;
        if (decoded.role === "employee") {
            const employee = await EmployeeModel.findById(decoded.id)
                .select("personalInfo.type workInfo.status tokenVersion");

            if (!employee) return next(new Error("Cuenta no encontrada"));
            if (employee.workInfo?.status !== "active") return next(new Error("Cuenta inactiva"));
            // Mismo criterio que validateAuthCookie: si le cambiaron los
            // permisos, el token viejo ya no vale.
            if (decoded.tokenVersion !== employee.tokenVersion) {
                return next(new Error("Permisos actualizados"));
            }

            employeeType = employee.personalInfo?.type || null;
        }

        socket.data.user = {
            id: String(decoded.id),
            role: decoded.role,
            permissions: decoded.permissions || [],
            employeeType,
        };

        return next();
    } catch (error) {
        // Token vencido, alterado o inválido: se rechaza la conexión. El
        // cliente lo trata como "sin tiempo real" y sigue funcionando.
        return next(new Error("Sesión inválida"));
    }
};

/**
 * Mete al socket en las rooms que le corresponden según quién es.
 *
 * Tres niveles, del más amplio al más específico:
 *   - role:<rol>            -> "role:admin", "role:employee", "role:customer"
 *   - type:<puesto>         -> "type:kitchen", "type:waiter"... (solo empleados)
 *   - user:<id>             -> para avisos dirigidos a una persona concreta
 *
 * El filtro real de quién ve qué se hace por role, que es el mismo criterio
 * que ya usa el modelo de notificaciones (campo audience). Las rooms por
 * puesto quedan disponibles para mandar algo solo a cocina o solo a meseros
 * sin tener que rehacer nada.
 */
const joinRooms = (socket) => {
    const { id, role, employeeType } = socket.data.user;

    socket.join(`role:${role}`);
    socket.join(`user:${id}`);

    if (role === "employee" && employeeType) {
        socket.join(`type:${employeeType}`);
    }
};

/**
 * Levanta el servidor de Socket.IO sobre el mismo servidor HTTP de Express.
 *
 * Comparten puerto a propósito: Render expone un solo puerto por servicio, así
 * que el tiempo real tiene que viajar por la misma dirección que la API.
 */
export const initSocket = (httpServer, allowedOrigins = []) => {
    io = new Server(httpServer, {
        // Mismo criterio de CORS que la API en app.js, y con credenciales
        // habilitadas para que el navegador adjunte la cookie de sesión.
        cors: {
            origin: (origin, callback) => {
                if (!origin || allowedOrigins.includes(origin)) {
                    callback(null, true);
                } else {
                    callback(new Error(`Origen no permitido por CORS: ${origin}`));
                }
            },
            credentials: true,
        },
        // Render soporta WebSocket, pero dejamos el polling como respaldo por
        // si una red intermedia (wifi de la feria, proxy corporativo) bloquea
        // el upgrade: la conexión igual se establece, solo que menos eficiente.
        transports: ["websocket", "polling"],
        // Render corta las conexiones inactivas; un ping más frecuente que ese
        // corte mantiene el socket vivo y detecta rápido las caídas reales.
        pingInterval: 25000,
        pingTimeout: 20000,
        path: "/socket.io",
    });

    io.use(authenticateSocket);

    io.on("connection", (socket) => {
        joinRooms(socket);

        // El cliente pregunta esto al conectar para confirmar que el servidor
        // lo reconoció y saber en qué rooms quedó (útil para depurar en la feria).
        socket.on("whoami", (callback) => {
            if (typeof callback === "function") {
                callback({
                    ...socket.data.user,
                    rooms: [...socket.rooms].filter((room) => room !== socket.id),
                });
            }
        });
    });

    console.log("Socket.IO listo (tiempo real activo)");
    return io;
};

// Devuelve la instancia por si algún módulo necesita algo más avanzado.
export const getIO = () => io;

/**
 * Manda un evento a todos los usuarios de ciertos roles.
 *
 * "roles" usa el mismo vocabulario que el audience de las notificaciones
 * (["admin", "employee"]), así que un controlador puede reutilizar el mismo
 * arreglo para notificar y para emitir.
 */
export const emitToRoles = (roles, event, payload) => {
    if (!io) return;

    try {
        const targets = (Array.isArray(roles) ? roles : [roles]).map((role) => `role:${role}`);
        if (targets.length === 0) return;

        io.to(targets).emit(event, payload);
    } catch (error) {
        // El tiempo real es una mejora, no un requisito: si falla, se registra
        // y la operación que lo disparó continúa normalmente.
        console.error("socket.emitToRoles:", error);
    }
};

// Manda un evento solo a los empleados de cierto puesto (ej. "kitchen").
export const emitToTypes = (types, event, payload) => {
    if (!io) return;

    try {
        const targets = (Array.isArray(types) ? types : [types]).map((type) => `type:${type}`);
        if (targets.length === 0) return;

        io.to(targets).emit(event, payload);
    } catch (error) {
        console.error("socket.emitToTypes:", error);
    }
};

// Manda un evento a todas las pestañas/dispositivos de una persona concreta.
export const emitToUser = (userId, event, payload) => {
    if (!io || !userId) return;

    try {
        io.to(`user:${String(userId)}`).emit(event, payload);
    } catch (error) {
        console.error("socket.emitToUser:", error);
    }
};

export default {
    initSocket,
    getIO,
    emitToRoles,
    emitToTypes,
    emitToUser,
    SOCKET_EVENTS,
};
