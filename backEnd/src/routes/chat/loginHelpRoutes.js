import express from "express";
import loginHelpController from "../../controllers/chat/loginHelpController.js";

const router = express.Router();

/**
 * @swagger
 * /chat/login-help:
 *   post:
 *     summary: Resuelve dudas sobre cómo iniciar sesión
 *     description: >
 *       Endpoint PÚBLICO (quien pregunta todavía no tiene sesión). El
 *       asistente solo explica el acceso al sistema: no tiene herramientas,
 *       no consulta la base de datos y no confirma si una cuenta existe.
 *     tags: [Chat]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 maxLength: 500
 *                 description: Duda del usuario sobre el inicio de sesión.
 *               history:
 *                 type: array
 *                 description: Turnos previos de la conversación (solo se usan los últimos).
 *                 items: { type: object }
 *     responses:
 *       200: { description: Respuesta del asistente. }
 *       400: { description: Mensaje vacío o demasiado largo. }
 */
router.post("/login-help", loginHelpController.ask);

export default router;
