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
 *       Devuelve una fila por empleado con su salario base, su bono vigente,
 *       los descuentos de ley (AFP, ISSS, ISR, solo sobre el salario) y el
 *       total a pagar, más los totales del período. Requiere el permiso "payroll".
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

/**
 * @swagger
 * /users/payroll/employee/{id}:
 *   get:
 *     summary: Boleta de pago de un empleado
 *     description: >
 *       Devuelve la nómina individual de un empleado para el período: sus
 *       datos, salario, bono vigente, deducciones de ley (AFP, ISSS, ISR) y
 *       el total a pagar.
 *       Requiere el permiso "payroll".
 *     tags: [Usuarios - Planilla]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID del empleado.
 *       - in: query
 *         name: period
 *         required: false
 *         schema: { type: string, example: "2026-09" }
 *         description: Período en formato AAAA-MM. Por defecto, el mes en curso.
 *     responses:
 *       200:
 *         description: Boleta de pago del empleado.
 *       403:
 *         description: Sin el permiso "payroll".
 *       404:
 *         description: Empleado no encontrado.
 */
router.route("/employee/:id").get(
    validateAuthCookie(["admin", "employee"]),
    requirePermission("payroll"),
    payrollController.getEmployeePayslip
);

export default router;
