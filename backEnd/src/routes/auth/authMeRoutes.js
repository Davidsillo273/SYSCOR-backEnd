import { Router } from "express";
import authMeController from "../../controllers/auth/authMeController.js";
import realtimeAuthController from "../../controllers/auth/realtimeAuthController.js";
import {validateAuthCookie} from "../../middlewares/auth/authMiddleware.js"; 

const router = Router();

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Obtiene los datos del usuario con sesión activa
 *     description: Admin, empleado o cliente. Devuelve quién es el usuario dueño de la cookie de sesión actual (id, rol y datos de perfil).
 *     tags: [Auth - Común]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Datos del usuario autenticado (id, role, type si es empleado, email, name, lastname, image, y para empleados también personalInfo/workInfo/permissions).
 *       400:
 *         description: El rol de la sesión no es válido.
 *       401:
 *         description: No hay sesión activa o el usuario de la cookie ya no existe.
 *       500:
 *         description: Error interno del servidor.
 */
router.get("/me", validateAuthCookie(["admin", "employee", "customer"]), authMeController.getMe);

/**
 * @swagger
 * /auth/socket-ticket:
 *   get:
 *     summary: Ticket de 2 minutos para conectar el tiempo real (Socket.IO) desde las apps móviles
 *     tags: [Auth - Común]
 * /auth/push-token:
 *   post:
 *     summary: Registra el teléfono del empleado para notificaciones push ({ token })
 *     tags: [Auth - Común]
 *   delete:
 *     summary: Quita el teléfono del empleado de las notificaciones push ({ token })
 *     tags: [Auth - Común]
 */
router.get("/socket-ticket", validateAuthCookie(["admin", "employee", "customer"]), realtimeAuthController.getSocketTicket);
router
    .route("/push-token")
    .post(validateAuthCookie(["employee"]), realtimeAuthController.registerPushToken)
    .delete(validateAuthCookie(["employee"]), realtimeAuthController.removePushToken);

export default router;