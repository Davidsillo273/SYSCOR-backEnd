import jsonwebtoken from "jsonwebtoken";
import { config } from "../../../config.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { rejectKitchenDevice } from "./kitchenDeviceMiddleware.js";

// Este middleware NO bloquea a nadie: solo intenta averiguar quién está haciendo la petición.
// Si viene una cookie válida, deja los datos del usuario en req.user; si no viene o está dañada,
// simplemente deja pasar la petición sin req.user.
//
// Sirve para las rutas públicas (mesas, inventario, carritos, menú), donde queremos poder
// registrar en las notificaciones QUIÉN hizo el movimiento, pero sin exigir sesión para operar.
export const attachUser = (req, res, next) => {
    try {
        const { authCookie } = req.cookies;

        // Sin cookie no hay nada que averiguar, seguimos de largo
        if (!authCookie) return next();

        req.user = jsonwebtoken.verify(authCookie, config.jwt.secret);
    } catch (error) {
        // Un token vencido o inválido aquí no es un error: solo significa que
        // no sabemos quién es. La petición continúa como anónima.
        req.user = undefined;
    }

    return next();
};

// Este middleware actúa como un guardia de seguridad. Verifica si el usuario tiene permiso para acceder a cierta ruta.
// 'allowedTypes' es una lista de los roles que tienen permitido pasar (por ejemplo: admin, empleado, cliente).
export const validateAuthCookie = (allowedTypes = []) => {
    return async (req, res, next) => {
        try {
            // Una pantalla de cocina (token de dispositivo, ver
            // kitchenDeviceMiddleware) nunca entra a rutas de usuarios: solo a
            // las de routes/kitchen. Se corta aquí, antes de mirar la cookie,
            // para que ni una cookie de admin del mismo navegador la deje pasar.
            if (req.kitchenDevice) return rejectKitchenDevice(res);

            // Extraemos la galleta (cookie) llamada 'authCookie' que nos envía el usuario.
            // Aquí es donde está guardado el token que confirma quién inició sesión.
            const { authCookie } = req.cookies;

            // Si el usuario no nos envió la cookie, no lo dejamos pasar.
            if (!authCookie) {
                return res.status(403).json({ title: "Sesión requerida", message: "No se encontró una sesión activa. Inicia sesión para continuar." });
            }

            // Desciframos la información que está adentro del token usando nuestra llave secreta.
            const decoded = jsonwebtoken.verify(authCookie, config.jwt.secret);

            // Revisamos si el rol del usuario (que viene dentro del token) está en la lista de permitidos.
            if (!allowedTypes.includes(decoded.role)) {
                return res.status(401).json({ title: "Acceso denegado", message: "No tenés permiso para acceder a este recurso." });
            }

            // Los empleados tienen reglas de permisos más complejas (pueden cambiar si el jefe lo decide).
            // Por eso, solo si es empleado, hacemos una verificación extra en la base de datos.
            if (decoded.role === "employee") {
                // Buscamos al empleado en la base de datos para ver su estado actual y la versión de sus permisos
                const employee = await EmployeeModel.findById(decoded.id).select("tokenVersion workInfo.status");

                // Si por alguna razón el empleado ya no existe (fue borrado)
                if (!employee) {
                    return res.status(401).json({ title: "Cuenta no encontrada", message: "Esta cuenta ya no existe. Inicia sesión nuevamente." });
                }

                // Si el empleado está suspendido o inactivo, no lo dejamos continuar
                if (employee.workInfo.status !== "active") {
                    return res.status(403).json({ title: "Cuenta inactiva", message: "Tu cuenta no está activa. Contacta a un administrador." });
                }

                // Si la versión de los permisos en el token es diferente a la de la base de datos,
                // significa que un administrador le cambió los permisos recientemente.
                // Le pedimos que inicie sesión otra vez para actualizar su token.
                if (decoded.tokenVersion !== employee.tokenVersion) {
                    return res.status(401).json({ title: "Permisos actualizados", message: "Tus permisos cambiaron recientemente. Inicia sesión nuevamente." });
                }
            }

            // Guardamos la información del usuario descifrada en la petición (req.user).
            // De esta forma, las siguientes partes del código pueden saber quién está haciendo la petición.
            req.user = decoded;

            // Todo está bien, dejamos que la petición continúe su camino
            next();

        } catch (error) {
            // Si el token ya caducó (pasó el tiempo límite)
            if (error.name === "TokenExpiredError") {
                return res.status(401).json({ title: "Sesión expirada", message: "Tu sesión venció. Inicia sesión nuevamente." });
            }
            // Si el token fue modificado, está dañado o es inventado
            if (error.name === "JsonWebTokenError") {
                return res.status(401).json({ title: "Sesión inválida", message: "El token de sesión no es válido." });
            }

            // Si ocurre cualquier otro error inesperado, lo registramos y devolvemos error 500
            console.error("validateAuthCookie error:", error);
            return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno al validar tu sesión." });
        }
    };
};
