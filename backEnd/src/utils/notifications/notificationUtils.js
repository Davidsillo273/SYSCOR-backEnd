// Importamos el modelo de notificaciones, los modelos de usuarios (para saber
// quién hizo cada movimiento) y los ajustes (para respetar qué categorías están activas)
import NotificationModel from "../../models/notifications/notificationsModel.js";
import AdminModel from "../../models/users/adminModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import settingsUtils from "../settings/settingsUtils.js";
// Capa de tiempo real: al guardar la notificación se avisa en el acto a las
// sesiones que pueden verla, en vez de esperar a que el panel pregunte.
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";

// Mismo mapeo que usa authMeController: según el rol sabemos en qué colección buscar al usuario
const MODELS_BY_ROLE = {
    admin: AdminModel,
    employee: EmployeeModel,
    customer: CustomerModel,
};

// Quién puede ver cada tipo de movimiento.
// Lo operativo lo ve todo el personal; lo sensible (planilla, clientes,
// configuración del negocio) queda reservado al administrador.
const AUDIENCE_BY_CATEGORY = {
    orders: ["admin", "employee"],
    tables: ["admin", "employee"],
    inventory: ["admin", "employee"],
    menu: ["admin", "employee"],
    staff: ["admin"],
    clients: ["admin"],
    settings: ["admin"],
};

// Traducciones para mostrar el puesto del empleado en español dentro del mensaje
const EMPLOYEE_TYPE_LABELS = {
    kitchen: "Cocina",
    waiter: "Mesero",
    cashier: "Cajero",
    manager: "Gerente",
    cleaner: "Limpieza",
    other: "Otro",
};

// Traducciones del rol para redactar mensajes
const ROLE_LABELS = {
    admin: "Administrador",
    employee: "Empleado",
    customer: "Cliente",
};

/**
 * Averigua quién está realizando la acción a partir de la petición.
 *
 * El middleware attachUser deja en req.user los datos del token (id y rol),
 * pero el token no trae el nombre, así que lo buscamos en la base de datos.
 *
 * Si no hay usuario identificado significa que la petición vino sin sesión:
 * en ese caso lo tratamos como un pedido hecho por un cliente en línea.
 */
const resolveActor = async (req) => {
    const actorFallback = {
        id: null,
        role: "system",
        name: "Cliente en línea",
        image: null,
    };

    if (!req || !req.user || !req.user.id) return actorFallback;

    try {
        const model = MODELS_BY_ROLE[req.user.role];
        if (!model) return actorFallback;

        const user = await model.findById(req.user.id).select("personalInfo");
        if (!user) return actorFallback;

        const name = `${user.personalInfo?.name || ""} ${user.personalInfo?.lastname || ""}`.trim();

        return {
            id: user._id,
            role: req.user.role,
            name: name || ROLE_LABELS[req.user.role] || "Usuario",
            image: user.personalInfo?.image || null,
        };
    } catch (error) {
        console.error("notificationUtils.resolveActor:", error);
        return actorFallback;
    }
};

/**
 * Registra un movimiento del sistema como notificación.
 *
 * Pensado para llamarse justo después de guardar en la base de datos, dentro
 * de los controladores. NUNCA lanza un error: si algo falla al notificar, se
 * escribe en consola y la operación de negocio sigue su curso normal, porque
 * no tiene sentido que un pedido falle solo porque no se pudo avisar de él.
 *
 * "message" puede ser un texto fijo o una función que recibe al actor ya
 * identificado, útil para redactar frases como "Juan Pérez creó una orden..."
 * sin tener que buscar al usuario dos veces.
 *
 * "actor" se puede pasar ya armado para los casos en que la persona todavía no
 * tiene sesión iniciada (por ejemplo, alguien que acaba de aceptar su invitación
 * y se registra: el actor es esa misma persona recién creada).
 */
const createNotification = async ({
    req,
    category,
    action,
    title,
    message,
    icon = "bell",
    severity = "info",
    entity = {},
    actor: providedActor = null,
}) => {
    try {
        // Respetamos los interruptores de Ajustes: si el admin apagó esta
        // categoría, el movimiento simplemente no se registra.
        const settings = await settingsUtils.getOrCreateSettings();
        if (settings.notifications?.[category] === false) return null;

        const actor = providedActor || (await resolveActor(req));

        const finalMessage = typeof message === "function" ? message(actor) : message;

        const newNotification = new NotificationModel({
            category,
            action,
            title,
            message: finalMessage,
            icon,
            severity,
            actor,
            entity: {
                model: entity.model || null,
                id: entity.id || null,
                label: entity.label || null,
            },
            audience: AUDIENCE_BY_CATEGORY[category] || ["admin"],
        });

        await newNotification.save();

        // Aviso instantáneo a la campana del panel. El destinatario es el
        // mismo "audience" que acabamos de calcular, así que nadie recibe por
        // socket algo que no vería al consultar el historial.
        emitToRoles(newNotification.audience, SOCKET_EVENTS.NOTIFICATION_CREATED, {
            notification: newNotification.toObject(),
        });

        return newNotification;
    } catch (error) {
        console.error("notificationUtils.createNotification:", error);
        return null;
    }
};

export default {
    resolveActor,
    createNotification,
    AUDIENCE_BY_CATEGORY,
    EMPLOYEE_TYPE_LABELS,
    ROLE_LABELS,
};
