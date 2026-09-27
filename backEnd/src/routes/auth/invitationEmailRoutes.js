import { Router } from "express";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import invitationEmailController from "../../controllers/auth/invitationEmailController.js";

const router = Router();

/**
 * @swagger
 * /api/auth/invitations/check-email:
 *   get:
 *     tags: [Invitaciones]
 *     summary: Comprueba si ya existe una cuenta del tipo que se invita con un correo
 *     description: >
 *       Lo usa "Invitar staff" mientras el admin escribe el correo. Busca solo
 *       en el tipo de usuario que se está invitando (empleados o
 *       administradores), igual que la validación del envío.
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema: { type: string, example: "maria@correo.com" }
 *       - in: query
 *         name: role
 *         required: true
 *         schema: { type: string, enum: [admin, employee] }
 *     responses:
 *       200:
 *         description: "Resultado: { email, role, exists, name }"
 *       400:
 *         description: Correo vacío o inválido, o tipo de usuario distinto de admin/employee.
 *       401:
 *         description: No autenticado o rol distinto de admin.
 *       500:
 *         description: Error interno del servidor.
 */
// Solo un admin (el único que puede invitar) puede consultar si un correo existe.
router.get("/check-email", validateAuthCookie(["admin"]), invitationEmailController.checkEmail);

export default router;
