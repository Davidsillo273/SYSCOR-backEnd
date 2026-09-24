import express from "express";
import checkoutController from "../../controllers/orders/checkoutController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /payments/checkout:
 *   post:
 *     summary: Inicia el pago en línea de un pedido (Wompi 3DS)
 *     description: >
 *       Solo clientes. Recalcula precios con la base de datos, crea el cobro 3DS y
 *       devuelve `paymentUrl` para completar la verificación. El pedido se crea
 *       hasta que Wompi confirma el pago.
 *     tags: [Pagos]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items: { type: array, items: { type: object } }
 *               isDelivery: { type: boolean }
 *               deliveryAddress: { type: string }
 *               card:
 *                 type: object
 *                 description: "{ savedCardIndex, cvv } o { cardHolder, cardNumber, expiryMonth, expiryYear, cvv }"
 *               saveCard: { type: boolean }
 *     responses:
 *       201:
 *         description: "{ id, status, amount, paymentUrl, returnUrlPrefix }"
 *       400:
 *         description: Carrito, dirección o tarjeta inválidos.
 *       502:
 *         description: Wompi no aceptó el cobro.
 */
router.post("/checkout", validateAuthCookie(["customer"]), checkoutController.createCheckout);

/**
 * @swagger
 * /payments/checkout/{id}:
 *   get:
 *     summary: Estado de un pago en línea
 *     description: Solo el cliente dueño. Consulta a Wompi si sigue pendiente y crea el pedido si ya se aprobó.
 *     tags: [Pagos]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ id, status: pending|approved|rejected|error, amount, orderId, message }"
 */
router.get("/checkout/:id", validateAuthCookie(["customer"]), checkoutController.getCheckout);

/**
 * @swagger
 * /payments/checkout/{id}/cancel:
 *   post:
 *     summary: El cliente abandonó la verificación 3DS
 *     description: Si Wompi no lo aprobó, queda rechazado. Si sí lo aprobó, se crea el pedido igual.
 *     tags: [Pagos]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Estado final del pago.
 */
router.post("/checkout/:id/cancel", validateAuthCookie(["customer"]), checkoutController.cancelCheckout);

// Públicas: las llama Wompi (o el navegador del cliente al volver del 3DS).
// No confían en lo que reciben: solo usan el id para consultar a Wompi.
router.get("/wompi/return", checkoutController.wompiReturn);
router.post("/wompi/webhook", checkoutController.wompiWebhook);

export default router;
