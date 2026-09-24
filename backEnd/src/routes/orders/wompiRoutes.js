import express from "express";
import wompiController from "../../controllers/orders/wompiController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /orders/wompi/token:
 *   post:
 *     summary: Genera un token de acceso a Wompi
 *     description: Solo admin (pruebas). Con este token se puede leer la configuración del comercio en Wompi, incluido su client secret, así que nunca se entrega a clientes. La app de clientes paga con /payments/checkout.
 *     tags: ["Pagos (Wompi)"]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Token de acceso de Wompi (respuesta reenviada tal cual la entrega Wompi).
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       500:
 *         description: Error interno del servidor, o Wompi rechazó la solicitud (se reenvía el status/mensaje de Wompi).
 */
// Solo admin: el token de Wompi da acceso a la cuenta del comercio.
router.route("/token").post(validateAuthCookie(["admin"]), wompiController.generateToken);

/**
 * @swagger
 * /orders/wompi/payment-test:
 *   post:
 *     summary: Procesa un pago con tarjeta a través de Wompi
 *     description: Solo admin (pruebas). Envía el cobro a Wompi usando el token de tarjeta y, si es exitoso, marca el carrito indicado como "paid". La app de clientes paga con /payments/checkout.
 *     tags: ["Pagos (Wompi)"]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, cardToken, cartId]
 *             properties:
 *               token: { type: string, description: "Token de acceso de Wompi (obtenido en /orders/wompi/token)", example: "eyJhbGciOiJSUzI1NiIs..." }
 *               cardToken: { type: string, description: "Token de la tarjeta generado en el frontend", example: "tok_test_1234567890" }
 *               cartId: { type: string, example: "665f1a2b3c4d5e6f7a8b9c40" }
 *     responses:
 *       200:
 *         description: Pago exitoso; el carrito queda marcado como "paid" (incluye la respuesta de la transacción de Wompi).
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       404:
 *         description: Carrito no encontrado.
 *       500:
 *         description: Error interno del servidor, o Wompi rechazó la transacción (se reenvía el status/mensaje de Wompi).
 */
router.route("/payment-test").post(validateAuthCookie(["admin"]), wompiController.paymentTest);

export default router;