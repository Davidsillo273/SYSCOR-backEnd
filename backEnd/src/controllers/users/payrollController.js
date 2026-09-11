// Planilla (RRHH): arma el detalle de pago de cada empleado para un período.
//
// El cálculo de los descuentos de ley NO vive aquí: es payrollUtils quien lo
// hace, y es la única fuente de verdad del sistema (la usa también el alta de
// empleados para guardar AFP/ISSS/renta en su ficha). Este controlador solo
// decide QUIÉN entra en la planilla del período y suma los totales.
import EmployeeModel from "../../models/users/employeeModel.js";
import { calculatePayrollDeductions } from "../../utils/users/payrollUtils.js";

const payrollController = {};

// Puestos traducidos, mismo vocabulario que ya usa notificationUtils para
// redactar los avisos del sistema.
const EMPLOYEE_TYPE_LABELS = {
    kitchen: "Cocina",
    waiter: "Mesero",
    cashier: "Cajero",
    manager: "Gerente",
    cleaner: "Limpieza",
    other: "Otro",
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Convierte "2026-09" (mes) en el rango de fechas que cubre ese período.
 *
 * Se usa para decidir qué empleados entran en la planilla: alguien que fue
 * contratado DESPUÉS de que terminó el mes no debería aparecer en la planilla
 * de ese mes.
 */
const resolvePeriod = (periodParam) => {
    // Sin período explícito, se asume el mes en curso.
    const now = new Date();
    const raw = typeof periodParam === "string" && /^\d{4}-\d{2}$/.test(periodParam)
        ? periodParam
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const [year, month] = raw.split("-").map(Number);

    // month - 1 porque en JavaScript los meses van de 0 a 11.
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    // El día 0 del mes siguiente es el último día de este mes.
    const end = new Date(year, month, 0, 23, 59, 59, 999);

    return { period: raw, start, end };
};

/**
 * Devuelve la planilla del período: una fila por empleado con su salario
 * bruto, sus descuentos de ley y lo que se le debe pagar.
 *
 * Query params:
 *   - period: "AAAA-MM" (por defecto, el mes en curso)
 *   - status: filtra por estado laboral. Por defecto solo "active", porque
 *     una planilla lista a quien se le paga; pasar "all" incluye a todos.
 */
payrollController.getPayroll = async (req, res) => {
    try {
        const { period, start, end } = resolvePeriod(req.query.period);
        const statusFilter = req.query.status || "active";

        const filter = {};
        if (statusFilter !== "all") {
            filter["workInfo.status"] = statusFilter;
        }

        // Quien fue dado de alta después de terminar el período no pertenece a
        // esa planilla. Los empleados viejos no traen createdAt (documentos
        // anteriores a que el modelo tuviera timestamps), y a esos se les
        // incluye igual: es más seguro mostrarlos de más que ocultarlos.
        filter.$or = [
            { createdAt: { $lte: end } },
            { createdAt: { $exists: false } },
        ];

        const employees = await EmployeeModel.find(filter)
            .select("personalInfo workInfo createdAt")
            .sort({ "personalInfo.name": 1 });

        const rows = employees.map((employee) => {
            const work = employee.workInfo || {};
            const salary = Number(work.salary) || 0;
            const additionalPay = Number(work.additionalPay) || 0;

            // Los descuentos de ley se calculan SOBRE EL SALARIO BASE, no
            // sobre el salario más los bonos: AFP e ISSS se cotizan sobre el
            // salario, y meter aquí un bono puntual cambiaría el descuento de
            // un mes a otro. El bono se suma después, ya libre de descuentos.
            const deductions = calculatePayrollDeductions(salary);

            return {
                employeeId: employee._id,
                name: `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim() || "Sin nombre",
                image: employee.personalInfo?.image || null,
                type: employee.personalInfo?.type || "other",
                typeLabel: EMPLOYEE_TYPE_LABELS[employee.personalInfo?.type] || "Otro",
                status: work.status || "active",
                grossSalary: deductions.grossSalary,
                additionalPay: round2(additionalPay),
                afp: deductions.afp,
                isss: deductions.isss,
                isr: deductions.isr,
                totalDeductions: round2(deductions.afp + deductions.isss + deductions.isr),
                // Lo que efectivamente se le entrega: el neto de ley más los bonos.
                netSalary: round2(deductions.netSalary + additionalPay),
            };
        });

        // Totales del período, para el encabezado de la pantalla y el PDF.
        const totals = rows.reduce(
            (acc, row) => ({
                grossSalary: round2(acc.grossSalary + row.grossSalary),
                additionalPay: round2(acc.additionalPay + row.additionalPay),
                afp: round2(acc.afp + row.afp),
                isss: round2(acc.isss + row.isss),
                isr: round2(acc.isr + row.isr),
                totalDeductions: round2(acc.totalDeductions + row.totalDeductions),
                netSalary: round2(acc.netSalary + row.netSalary),
            }),
            { grossSalary: 0, additionalPay: 0, afp: 0, isss: 0, isr: 0, totalDeductions: 0, netSalary: 0 }
        );

        return res.status(200).json({
            period,
            periodStart: start,
            periodEnd: end,
            employeeCount: rows.length,
            rows,
            totals,
        });
    } catch (error) {
        console.error("payrollController.getPayroll:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo calcular la planilla." });
    }
};

export default payrollController;
