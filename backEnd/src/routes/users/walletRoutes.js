import express from "express";
import walletController from "../../controllers/users/walletController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /wallet/mine:
 *   get:
 *     summary: Saldo a favor del cliente con su historial
 *     description: Cliente. Devuelve el saldo actual, sus últimos movimientos y los reembolsos a tarjeta (pendientes o hechos).
 *     tags: [Clientes - Saldo]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: "{ balance, movements: [{ type, amount, description, orderId, createdAt }], cardRefunds: [...] }"
 *       403:
 *         description: Sin sesión.
 */
router.get("/mine", validateAuthCookie(["customer"]), walletController.getMyWallet);

export default router;
