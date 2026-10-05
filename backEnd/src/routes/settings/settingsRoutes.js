import express from "express";
import settingsController from "../../controllers/settings/settingsController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

// Todo el personal puede leer la configuración (el panel la necesita para
// saber, por ejemplo, cuál es el umbral de stock bajo)
/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Obtiene la configuración general del sistema
 *     description: Admin o empleado. Si todavía no existe el documento de ajustes, se crea con los valores por defecto.
 *     tags: [Configuración]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Documento de configuración (operation.lowStockThresholds, operation.autoRefreshDashboard, operation.dashboardRefreshSeconds, notifications por categoría y kitchen con el estado del Sistema de Cocina).
 *       401:
 *         description: No autenticado.
 *       500:
 *         description: Error interno del servidor.
 */
router.get("/", validateAuthCookie(["admin", "employee"]), settingsController.getSettings);

// Pero solo el administrador puede modificarla
/**
 * @swagger
 * /settings:
 *   patch:
 *     summary: Actualiza la configuración general del sistema
 *     description: Solo admin. Acepta cambios parciales; lo que no venga en el body se queda como estaba.
 *     tags: [Configuración]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               operation:
 *                 type: object
 *                 properties:
 *                   lowStockThresholds:
 *                     type: object
 *                     properties:
 *                       drinks: { type: number, example: 10 }
 *                       saucers: { type: number, example: 10 }
 *                       extras: { type: number, example: 10 }
 *                       combos: { type: number, example: 10 }
 *                   autoRefreshDashboard: { type: boolean, example: true }
 *                   dashboardRefreshSeconds: { type: number, example: 30, minimum: 10 }
 *               notifications:
 *                 type: object
 *                 properties:
 *                   orders: { type: boolean, example: true }
 *                   staff: { type: boolean, example: true }
 *                   inventory: { type: boolean, example: true }
 *                   tables: { type: boolean, example: true }
 *                   menu: { type: boolean, example: true }
 *                   clients: { type: boolean, example: true }
 *               kitchen:
 *                 type: object
 *                 description: Tiempos de alerta del Sistema de Cocina (KDS); se emiten por socket como kitchen:status_changed. Encenderlo/apagarlo es en /kitchen/devices/pair y /kitchen/disable.
 *                 properties:
 *                   warningMinutes: { type: integer, example: 10, minimum: 1, maximum: 180 }
 *                   maxMinutes: { type: integer, example: 15, minimum: 1, maximum: 180 }
 *     responses:
 *       200:
 *         description: Configuración actualizada correctamente; devuelve el documento actualizado.
 *       400:
 *         description: Umbral de stock bajo, intervalo de actualización del dashboard o tiempos de alerta de cocina inválidos.
 *       401:
 *         description: No autenticado o rol distinto de admin.
 *       500:
 *         description: Error interno del servidor.
 */
router.patch("/", validateAuthCookie(["admin"]), settingsController.updateSettings);

export default router;
