import express from "express";
import notificationsController from "../../controllers/notifications/notificationsController.js";
import employeeNotificationsController from "../../controllers/notifications/employeeNotificationsController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

// Todas las rutas exigen sesión: las notificaciones son información interna del negocio

/**
 * @swagger
 * /notifications/mine:
 *   get:
 *     summary: Bandeja personal del empleado (app de empleados)
 *     description: Avisos dirigidos a este empleado (paquete asignado, comanda lista...), los más nuevos primero, de 30 en 30. `before` (fecha ISO) pide la página siguiente. Incluye el total de no leídas.
 *     tags: [Notificaciones]
 *     security:
 *       - cookieAuth: []
 * /notifications/mine/read-all:
 *   patch:
 *     summary: Marca como leída toda la bandeja personal del empleado
 *     tags: [Notificaciones]
 * /notifications/mine/{id}/read:
 *   patch:
 *     summary: Marca como leído un aviso de la bandeja personal del empleado
 *     tags: [Notificaciones]
 */
router.get("/mine", validateAuthCookie(["employee"]), employeeNotificationsController.getMine);
router.patch("/mine/read-all", validateAuthCookie(["employee"]), employeeNotificationsController.markAllRead);
router.patch("/mine/:id/read", validateAuthCookie(["employee"]), employeeNotificationsController.markRead);

// Listar las notificaciones del usuario y su contador de no leídas
/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Lista las notificaciones visibles para el usuario y su contador de no leídas
 *     description: Admin o empleado. Devuelve solo notificaciones de los últimos 3 días, filtradas por el rol del usuario (audience) y, opcionalmente, por categoría. Paginado.
 *     tags: [Notificaciones]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: category
 *         required: false
 *         schema: { type: string }
 *         description: "Filtra por área (ej. orders, staff, inventory, tables, menu, clients, settings)."
 *       - in: query
 *         name: page
 *         required: false
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 10, maximum: 50 }
 *     responses:
 *       200:
 *         description: "{ notifications, unreadCount, page, limit, total, totalPages }"
 *       401:
 *         description: No autenticado.
 *       500:
 *         description: Error interno del servidor.
 */
router.get("/", validateAuthCookie(["admin", "employee"]), notificationsController.getNotifications);

// Marcar todas como leídas (va antes de "/:id/read" por claridad de lectura)
/**
 * @swagger
 * /notifications/read-all:
 *   patch:
 *     summary: Marca todas las notificaciones visibles del usuario como leídas
 *     description: Admin o empleado. Solo modifica las notificaciones de su propio rol (audience) que aún no había leído.
 *     tags: [Notificaciones]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "Notificaciones marcadas como leídas; incluye modified con la cantidad afectada."
 *       401:
 *         description: No autenticado.
 *       500:
 *         description: Error interno del servidor.
 */
router.patch("/read-all", validateAuthCookie(["admin", "employee"]), notificationsController.markAllAsRead);

// Marcar una notificación puntual como leída
/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Marca una notificación puntual como leída
 *     description: Admin o empleado. Idempotente (marcarla dos veces no duplica el registro).
 *     tags: [Notificaciones]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID de la notificación.
 *     responses:
 *       200:
 *         description: Notificación marcada como leída; devuelve el documento actualizado.
 *       401:
 *         description: No autenticado.
 *       404:
 *         description: No se encontró la notificación solicitada.
 *       500:
 *         description: Error interno del servidor.
 */
router.patch("/:id/read", validateAuthCookie(["admin", "employee"]), notificationsController.markAsRead);

// Borrar una notificación: solo el administrador
/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     summary: Elimina definitivamente una notificación
 *     description: Solo admin.
 *     tags: [Notificaciones]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID de la notificación.
 *     responses:
 *       200:
 *         description: Notificación eliminada correctamente.
 *       401:
 *         description: No autenticado o rol distinto de admin.
 *       404:
 *         description: No se encontró la notificación solicitada.
 *       500:
 *         description: Error interno del servidor.
 */
router.delete("/:id", validateAuthCookie(["admin"]), notificationsController.deleteNotification);

export default router;
