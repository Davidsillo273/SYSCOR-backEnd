import express from "express";
import guestCustomerController from "../../../controllers/auth/customers/guestCustomerController.js";
import { authRateLimiter } from "../../../middlewares/security/rateLimitMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /auth/customers/guest:
 *   post:
 *     summary: Comprar sin registrarse (crea una cuenta de invitado y su sesión)
 *     description: Solo pide nombre y apellidos. Deja la misma cookie de sesión que el login de clientes.
 *     tags: [Auth - Clientes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               lastname: { type: string }
 *     responses:
 *       201: { description: Sesión de invitado creada }
 *       400: { description: Nombre o apellidos inválidos }
 */
// Mismo límite que el login: evita que se creen cuentas en masa.
router.route("/").post(authRateLimiter, guestCustomerController.createGuest);

export default router;
