import express from "express";
import kitchenController from "../../controllers/kitchen/kitchenController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requireKitchenDevice } from "../../middlewares/auth/kitchenDeviceMiddleware.js";

// Sistema de Cocina (KDS). Dos tipos de ruta:
//   - /kitchen/devices*, /kitchen/disable: solo administrador (cookie).
//   - /kitchen/status, /kitchen/orders*, /kitchen/menu: solo pantallas de
//     cocina emparejadas (Authorization: Bearer <token de dispositivo>).
const router = express.Router();

// ---------------- Administrador ----------------

/**
 * @swagger
 * /kitchen/devices:
 *   get:
 *     summary: Lista las pantallas de cocina emparejadas y el estado del sistema
 *     description: Solo admin.
 *     tags: [Cocina]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "{ kitchen, devices: [{ deviceId, shortId, label, active, pairedBy, pairedAt, revokedAt, lastSeenAt }] }"
 *       403:
 *         description: Sin sesión, o la petición viene de una pantalla de cocina.
 */
router.get("/devices", validateAuthCookie(["admin"]), kitchenController.listDevices);

/**
 * @swagger
 * /kitchen/devices/pair:
 *   post:
 *     summary: Empareja una pantalla de cocina con el código que muestra su lobby
 *     description: >
 *       Solo admin. Habilita el sistema de cocina si estaba apagado, genera el token de dispositivo
 *       (rol KITCHEN_DEVICE, permisos orders:read y orders:update_status) y se lo entrega por socket
 *       (namespace /kitchen, evento kitchen:device_paired) únicamente a la pantalla que mostró ese código.
 *     tags: [Cocina]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               code: { type: string, example: "482913" }
 *     responses:
 *       200:
 *         description: Pantalla emparejada.
 *       404:
 *         description: Código inexistente o vencido.
 *       409:
 *         description: La pantalla se desconectó antes de recibir el token.
 */
router.post("/devices/pair", validateAuthCookie(["admin"]), kitchenController.pairDevice);

/**
 * @swagger
 * /kitchen/devices/{deviceId}:
 *   delete:
 *     summary: Desvincula una pantalla de cocina (kill switch individual)
 *     description: Solo admin. Su token deja de valer al instante y la pantalla vuelve al lobby.
 *     tags: [Cocina]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Pantalla desvinculada.
 *       404:
 *         description: La pantalla no estaba emparejada.
 */
router.delete("/devices/:deviceId", validateAuthCookie(["admin"]), kitchenController.unpairDevice);

/**
 * @swagger
 * /kitchen/disable:
 *   post:
 *     summary: Deshabilita el sistema de cocina (kill switch general)
 *     description: Solo admin. Revoca los tokens de todas las pantallas y las devuelve al lobby.
 *     tags: [Cocina]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Sistema deshabilitado.
 */
router.post("/disable", validateAuthCookie(["admin"]), kitchenController.disableKitchen);

// ---------------- Pantalla de cocina ----------------

/**
 * @swagger
 * /kitchen/status:
 *   get:
 *     summary: Estado del sistema de cocina para la pantalla
 *     description: Solo pantallas de cocina (Bearer, permiso orders:read).
 *     tags: [Cocina]
 *     security:
 *       - kitchenDeviceAuth: []
 *     responses:
 *       200:
 *         description: "{ deviceId, kitchen: { enabled, warningMinutes, maxMinutes } }"
 *       401:
 *         description: Token vencido, revocado o con la cocina deshabilitada (la pantalla vuelve al lobby).
 */
router.get("/status", requireKitchenDevice("orders:read"), kitchenController.getStatus);

/**
 * @swagger
 * /kitchen/orders:
 *   get:
 *     summary: Comandas de cocina (activas y listas recientes)
 *     description: Solo pantallas de cocina (permiso orders:read). Sin totales, pagos ni datos de contacto.
 *     tags: [Cocina]
 *     security:
 *       - kitchenDeviceAuth: []
 *     responses:
 *       200:
 *         description: "{ orders: [...] }"
 *       401:
 *         description: Token de dispositivo inválido o revocado.
 */
router.get("/orders", requireKitchenDevice("orders:read"), kitchenController.getOrders);

/**
 * @swagger
 * /kitchen/menu:
 *   get:
 *     summary: Categorías y recetas del menú para preparar las comandas
 *     description: Solo pantallas de cocina (permiso orders:read). Sin precios ni existencias.
 *     tags: [Cocina]
 *     security:
 *       - kitchenDeviceAuth: []
 *     responses:
 *       200:
 *         description: "{ saucers, combos, drinks, extras }"
 */
router.get("/menu", requireKitchenDevice("orders:read"), kitchenController.getMenu);

/**
 * @swagger
 * /kitchen/orders/{id}/status:
 *   patch:
 *     summary: Pasa una comanda a "En cocina" (preparing) o a "Lista" (ready)
 *     description: Solo pantallas de cocina (permiso orders:update_status). Cualquier otro estado responde 403.
 *     tags: [Cocina]
 *     security:
 *       - kitchenDeviceAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [preparing, ready] }
 *     responses:
 *       200:
 *         description: Comanda actualizada.
 *       403:
 *         description: Estado no permitido para una pantalla de cocina.
 *       409:
 *         description: Esperando al mesero, cliente agregando productos o comanda ya cerrada.
 */
router.patch("/orders/:id/status", requireKitchenDevice("orders:update_status"), kitchenController.updateOrderStatus);

export default router;
