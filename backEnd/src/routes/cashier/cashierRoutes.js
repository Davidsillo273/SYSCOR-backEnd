import express from "express";
import cashierController from "../../controllers/cashier/cashierController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requireCashierDevice } from "../../middlewares/auth/cashierDeviceMiddleware.js";

// Sistema de Caja (POS). Tres tipos de ruta:
//   - Administrador (cookie): emparejar cajas, abrir/cerrar turnos, desvincular, apagar.
//   - Empleados (cookie): saber si la caja está abierta (app de meseros).
//   - Pantalla de caja (Authorization: Bearer <token de caja>): cobrar.
const router = express.Router();

// ---------------- Administrador ----------------

/**
 * @swagger
 * /cashier/admin/overview:
 *   get:
 *     summary: Estado del sistema de caja, cajas, turnos abiertos y últimos cortes
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "{ cashier, devices, openSessions, recentSessions, cashiers }"
 */
router.get("/admin/overview", validateAuthCookie(["admin"]), cashierController.getOverview);

/**
 * @swagger
 * /cashier/devices/pair:
 *   post:
 *     summary: Empareja una caja con su código y abre el turno
 *     description: Habilita el sistema de caja si estaba apagado, entrega el token por socket (namespace /cashier) solo a la caja que mostró el código y abre el turno con el cajero y el fondo inicial.
 *     tags: [Caja]
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
 *               cashierId: { type: string }
 *               openingFloat: { type: number, example: 50 }
 *     responses:
 *       200: { description: Caja emparejada y turno abierto. }
 *       400: { description: Cajero o fondo inválidos. }
 *       404: { description: Código inexistente o vencido. }
 */
router.post("/devices/pair", validateAuthCookie(["admin"]), cashierController.pairDevice);

/**
 * @swagger
 * /cashier/devices/{deviceId}:
 *   delete:
 *     summary: Desvincula una caja (cierra su turno sin arqueo)
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Caja desvinculada. }
 */
router.delete("/devices/:deviceId", validateAuthCookie(["admin"]), cashierController.unpairDevice);

/**
 * @swagger
 * /cashier/sessions:
 *   post:
 *     summary: Abre un turno en una caja ya emparejada
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               deviceId: { type: string }
 *               cashierId: { type: string }
 *               openingFloat: { type: number }
 *     responses:
 *       200: { description: Turno abierto. }
 *       409: { description: La caja ya tiene un turno abierto o el sistema está apagado. }
 */
router.post("/sessions", validateAuthCookie(["admin"]), cashierController.openShift);

/**
 * @swagger
 * /cashier/sessions/{id}:
 *   get:
 *     summary: Corte de un turno con sus comprobantes
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ session, receipts, issuer }" }
 */
router.get("/sessions/:id", validateAuthCookie(["admin"]), cashierController.getSessionReport);

/**
 * @swagger
 * /cashier/sessions/{id}/close:
 *   post:
 *     summary: El administrador cierra un turno (con o sin arqueo)
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Turno cerrado. }
 */
router.post("/sessions/:id/close", validateAuthCookie(["admin"]), cashierController.adminCloseShift);

/**
 * @swagger
 * /cashier/disable:
 *   post:
 *     summary: Deshabilita el sistema de caja (cierra turnos y revoca todas las cajas)
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200: { description: Sistema deshabilitado. }
 */
router.post("/disable", validateAuthCookie(["admin"]), cashierController.disableCashier);

/**
 * @swagger
 * /cashier/public-status:
 *   get:
 *     summary: ¿Está la caja cobrando? (app de meseros)
 *     tags: [Caja]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200: { description: "{ cashier: { enabled, open } }" }
 */
router.get("/public-status", validateAuthCookie(["admin", "employee"]), cashierController.getPublicStatus);

// ---------------- Pantalla de caja ----------------

/**
 * @swagger
 * /cashier/status:
 *   get:
 *     summary: Estado de esta caja y su turno abierto (si hay)
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       200: { description: "{ device, session, issuer, ivaRate }" }
 *       401: { description: Token vencido, revocado o sistema apagado. }
 */
router.get("/status", requireCashierDevice("cashier:read"), cashierController.getStatus);

/**
 * @swagger
 * /cashier/pending:
 *   get:
 *     summary: Mesas y pedidos para recoger (ya listos en cocina) por cobrar, y pedidos pagados por entregar
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       200: { description: "{ tables, pickups, toDeliver }" }
 */
router.get("/pending", requireCashierDevice("cashier:read"), cashierController.getPending);

/**
 * @swagger
 * /cashier/menu:
 *   get:
 *     summary: Productos con precio para la venta de mostrador
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       200: { description: "{ saucers, combos, drinks, promotions, extras }" }
 */
router.get("/menu", requireCashierDevice("cashier:read"), cashierController.getMenu);

/**
 * @swagger
 * /cashier/charges:
 *   post:
 *     summary: Cobra una mesa, un pedido para recoger o una venta de mostrador
 *     description: Simulado (sin pasarela ni Hacienda). Deja los pedidos pagados y emite una Factura o un Crédito Fiscal con correlativo, número de control y código de generación.
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       201: { description: "{ receipt, issuer }" }
 *       400: { description: Datos del cobro, del cliente o del pago inválidos. }
 *       409: { description: Caja sin turno abierto, mesa con tiempo en espera o cobro duplicado. }
 */
router.post("/charges", requireCashierDevice("cashier:charge"), cashierController.charge);

/**
 * @swagger
 * /cashier/orders/{id}/deliver:
 *   post:
 *     summary: Entrega un pedido ya pagado y listo (para recoger o de mostrador)
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Pedido entregado. }
 *       409: { description: Todavía no está listo. }
 */
router.post("/orders/:id/deliver", requireCashierDevice("cashier:charge"), cashierController.deliverOrder);

/**
 * @swagger
 * /cashier/receipts:
 *   get:
 *     summary: Comprobantes del turno abierto
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       200: { description: "{ receipts, issuer }" }
 */
router.get("/receipts", requireCashierDevice("cashier:read"), cashierController.getReceipts);

/**
 * @swagger
 * /cashier/receipts/{id}:
 *   get:
 *     summary: Un comprobante de esta caja (para reimprimir)
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ receipt, issuer }" }
 */
router.get("/receipts/:id", requireCashierDevice("cashier:read"), cashierController.getReceipt);

/**
 * @swagger
 * /cashier/movements:
 *   post:
 *     summary: Entrada o salida de efectivo que no es venta
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       201: { description: Movimiento registrado. }
 */
router.post("/movements", requireCashierDevice("cashier:shift"), cashierController.addMovement);

/**
 * @swagger
 * /cashier/session/close:
 *   post:
 *     summary: Arqueo y cierre del turno (corte Z)
 *     tags: [Caja]
 *     security:
 *       - cashierDeviceAuth: []
 *     responses:
 *       200: { description: "{ session, issuer }" }
 */
router.post("/session/close", requireCashierDevice("cashier:shift"), cashierController.closeOwnShift);

export default router;
