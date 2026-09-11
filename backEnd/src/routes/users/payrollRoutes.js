import express from "express";
import payrollController from "../../controllers/users/payrollController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requirePermission } from "../../middlewares/auth/permissionMiddleware.js";

const router = express.Router();

// La planilla expone salarios de todo el personal, así que va detrás de su
// propio permiso ("payroll"), igual que el resto de pantallas sensibles. Un
// empleado solo la ve si el admin se lo asignó explícitamente.
/**
 * @swagger
 * /users/payroll:
 *   get:
 *     summary: Calcula la planilla de un período
 *     description: >
 *       Devuelve una fila por empleado con su salario base, los descuentos de
 *       ley (AFP, ISSS, ISR) calculados con payrollUtils y el salario neto a
 *       pagar, más los totales del período. Requiere el permiso "payroll".
 *     tags: [Usuarios - Planilla]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         required: false
 *         schema: { type: string, example: "2026-09" }
 *         description: Período en formato AAAA-MM. Por defecto, el mes en curso.
 *       - in: query
 *         name: status
 *         required: false
 *         schema: { type: string, example: "active" }
 *         description: Estado laboral a incluir. Por defecto "active"; "all" incluye a todos.
 *     responses:
 *       200:
 *         description: Planilla calculada del período.
 *       403:
 *         description: Sin el permiso "payroll".
 *       500:
 *         description: Error interno del servidor.
 */
router.route("/").get(
    validateAuthCookie(["admin", "employee"]),
    requirePermission("payroll"),
    payrollController.getPayroll
);

export default router;
