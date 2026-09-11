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

// Va ANTES de "/employee/:id" para que Express no confunda "bonuses" con un
// id de empleado.
/**
 * @swagger
 * /users/payroll/bonuses:
 *   get:
 *     summary: Calcula la planilla de bonos de un período
 *     description: >
 *       Devuelve una fila por empleado con su nombre, puesto y el bono
 *       asignado ese período. A propósito NO lleva AFP/ISSS/ISR: el bono es
 *       un pago discrecional del dueño, no salario cotizable. Requiere el
 *       permiso "payroll".
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
 *         description: Planilla de bonos calculada del período.
 *       403:
 *         description: Sin el permiso "payroll".
 *       500:
 *         description: Error interno del servidor.
 */
router.route("/bonuses").get(
    validateAuthCookie(["admin", "employee"]),
    requirePermission("payroll"),
    payrollController.getBonusPayroll
);

/**
 * @swagger
 * /users/payroll/employee/{id}:
 *   get:
 *     summary: Boleta de pago de un empleado
 *     description: >
 *       Devuelve la nómina individual (planilla general) de un empleado para
 *       el período: sus datos, salario, deducciones de ley (AFP, ISSS, ISR) y
 *       el neto a pagar. No incluye bonos (ver /users/payroll/bonuses).
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
