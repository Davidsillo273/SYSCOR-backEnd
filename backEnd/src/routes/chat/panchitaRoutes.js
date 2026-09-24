import express from "express";
import panchitaController from "../../controllers/chat/panchitaController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

// Chef Panchita en la app de clientes. Todo lo del cliente va detrás de su
// sesión y se consulta siempre con su propio id; la cola de reclamos es del admin.

/**
 * @swagger
 * /panchita/chat:
 *   get:
 *     summary: Conversación guardada del cliente con Panchita
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: "{ messages: [{ role, text, cards, createdAt }] }"
 *   post:
 *     summary: Envía un mensaje a Panchita
 *     description: >
 *       El historial se guarda en el servidor. Panchita puede consultar pedidos,
 *       estimar la entrega, levantar reclamos (los decide claimPolicy), escribirle
 *       al repartidor y armar "lo de siempre".
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message: { type: string, example: "Me faltó una horchata" }
 *     responses:
 *       200:
 *         description: "{ reply, cards }"
 *   delete:
 *     summary: Reinicia la conversación
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: Conversación vacía.
 */
router
    .route("/chat")
    .get(validateAuthCookie(["customer"]), panchitaController.getConversation)
    .post(validateAuthCookie(["customer"]), panchitaController.chat)
    .delete(validateAuthCookie(["customer"]), panchitaController.resetConversation);

/**
 * @swagger
 * /panchita/overview:
 *   get:
 *     summary: Seguimiento del cliente
 *     description: Pedidos en curso con su estimación (cocina, tráfico, clima), avisos, saldo a favor, reclamos y mensajes sugeridos para el repartidor.
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: "{ activeOrders, alerts, wallet, claims }"
 */
router.get("/overview", validateAuthCookie(["customer"]), panchitaController.getOverview);

/**
 * @swagger
 * /panchita/usual:
 *   get:
 *     summary: 'Lo de siempre del cliente, listo para el carrito'
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: "{ usual: { label, items, unavailable, total } | null }"
 */
router.get("/usual", validateAuthCookie(["customer"]), panchitaController.getUsual);

/**
 * @swagger
 * /panchita/orders/{id}/driver-messages:
 *   post:
 *     summary: Mensaje del cliente para el repartidor
 *     description: Solo pedidos a domicilio en curso del propio cliente. Máximo 10 por pedido.
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
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
 *               text: { type: string, example: "Déjalo en la recepción, por favor." }
 *               preset: { type: boolean }
 *     responses:
 *       201:
 *         description: Enviado.
 *       400:
 *         description: El pedido no es a domicilio, ya terminó o el mensaje no es válido.
 */
router.post("/orders/:id/driver-messages", validateAuthCookie(["customer"]), panchitaController.postDriverMessage);

/**
 * @swagger
 * /panchita/claims:
 *   post:
 *     summary: Reporta un problema con un pedido (cliente)
 *     description: Se decide con reglas fijas. Aprobado al instante como saldo, o pendiente de reembolso a tarjeta, o en revisión.
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               orderId: { type: string }
 *               type: { type: string, enum: [missing_item, wrong_item, quality, late, other] }
 *               items: { type: array, items: { type: object, properties: { name: { type: string }, quantity: { type: integer } } } }
 *               description: { type: string }
 *               resolution: { type: string, enum: [credit, card_refund] }
 *     responses:
 *       201:
 *         description: "{ claim, created }"
 *   get:
 *     summary: Cola de reclamos (admin)
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [approved, pending_refund, refunded, in_review, rejected] }
 *     responses:
 *       200:
 *         description: Reclamos con cliente y pedido.
 */
router
    .route("/claims")
    .post(validateAuthCookie(["customer"]), panchitaController.postClaim)
    .get(validateAuthCookie(["admin"]), panchitaController.listClaims);

/**
 * @swagger
 * /panchita/claims/{id}:
 *   patch:
 *     summary: Resuelve un reclamo (admin)
 *     description: "approve_credit (abona saldo), approve_card (queda para reembolsar a tarjeta), mark_refunded (ya se reembolsó en Wompi) o reject."
 *     tags: [Panchita]
 *     security: [{ cookieAuth: [] }]
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
 *               action: { type: string, enum: [approve_credit, approve_card, mark_refunded, reject] }
 *               amount: { type: number }
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Reclamo actualizado.
 */
router.patch("/claims/:id", validateAuthCookie(["admin"]), panchitaController.resolveClaim);

export default router;
