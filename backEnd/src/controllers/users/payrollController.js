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
    delivery: "Repartidor",
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

            // Los descuentos de ley se calculan SOLO sobre el salario base.
            // El bono ("additionalPay") ya no entra aquí: es un pago
            // discrecional que vive aparte, en la Planilla de bonos (ver
            // getBonusPayroll más abajo), justo para no arrastrar renta u
            // otros descuentos a un empleado solo por una gratificación
            // puntual del dueño.
            const deductions = calculatePayrollDeductions(salary);

            return {
                employeeId: employee._id,
                name: `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim() || "Sin nombre",
                image: employee.personalInfo?.image || null,
                type: employee.personalInfo?.type || "other",
                typeLabel: EMPLOYEE_TYPE_LABELS[employee.personalInfo?.type] || "Otro",
                status: work.status || "active",
                grossSalary: deductions.grossSalary,
                afp: deductions.afp,
                isss: deductions.isss,
                isr: deductions.isr,
                // Base sobre la que se calculó el ISR, útil para la boleta
                // individual (explica de dónde sale la retención).
                taxableBase: deductions.taxableBase,
                totalDeductions: round2(deductions.afp + deductions.isss + deductions.isr),
                netSalary: deductions.netSalary,
            };
        });

        // Totales del período, para el encabezado de la pantalla y el PDF.
        const totals = rows.reduce(
            (acc, row) => ({
                grossSalary: round2(acc.grossSalary + row.grossSalary),
                afp: round2(acc.afp + row.afp),
                isss: round2(acc.isss + row.isss),
                isr: round2(acc.isr + row.isr),
                totalDeductions: round2(acc.totalDeductions + row.totalDeductions),
                netSalary: round2(acc.netSalary + row.netSalary),
            }),
            { grossSalary: 0, afp: 0, isss: 0, isr: 0, totalDeductions: 0, netSalary: 0 }
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

/**
 * Boleta de pago (nómina) de UN empleado para un período.
 *
 * Es el mismo cálculo que la planilla completa, pero devuelto con el detalle
 * que necesita una constancia individual: datos de identificación del
 * empleado, desglose de lo devengado contra lo deducido, y el neto. Se usa
 * para entregarle al empleado su comprobante de pago.
 */
payrollController.getEmployeePayslip = async (req, res) => {
    try {
        const { period, start, end } = resolvePeriod(req.query.period);

        const employee = await EmployeeModel.findById(req.params.id)
            .select("personalInfo workInfo loginInfo.email createdAt");

        if (!employee) {
            return res.status(404).json({ title: "Empleado no encontrado", message: "No se encontró el empleado solicitado." });
        }

        const work = employee.workInfo || {};
        const salary = Number(work.salary) || 0;

        // Esta boleta es la de la Planilla GENERAL: solo salario y sus
        // descuentos de ley. El bono ya no aparece aquí en absoluto — tiene
        // su propia boleta en getEmployeeBonusPayslip, sin AFP/ISSS/ISR.
        const deductions = calculatePayrollDeductions(salary);

        const totalDeductions = round2(deductions.afp + deductions.isss + deductions.isr);

        return res.status(200).json({
            period,
            periodStart: start,
            periodEnd: end,
            employee: {
                id: employee._id,
                name: `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim() || "Sin nombre",
                image: employee.personalInfo?.image || null,
                type: employee.personalInfo?.type || "other",
                typeLabel: EMPLOYEE_TYPE_LABELS[employee.personalInfo?.type] || "Otro",
                duiNit: employee.personalInfo?.duiNit || null,
                phone: employee.personalInfo?.phone || null,
                email: employee.loginInfo?.email || null,
                status: work.status || "active",
                // El horario se incluye porque una constancia de trabajo suele
                // necesitarlo (ej. para un trámite bancario).
                schedule: work.scheduleStart && work.scheduleEnd
                    ? `${work.scheduleStart} - ${work.scheduleEnd}`
                    : null,
                workDays: work.workDays || [],
                hiredAt: employee.createdAt || null,
            },
            // Lo que se le reconoce. Solo salario: el bono se paga y se
            // documenta aparte, en la Planilla de bonos.
            earnings: {
                salary: deductions.grossSalary,
                total: deductions.grossSalary,
            },
            // Lo que se le descuenta, con la base que originó la retención.
            deductions: {
                afp: deductions.afp,
                isss: deductions.isss,
                isr: deductions.isr,
                taxableBase: deductions.taxableBase,
                total: totalDeductions,
            },
            netSalary: deductions.netSalary,
        });
    } catch (error) {
        console.error("payrollController.getEmployeePayslip:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo generar la boleta de pago." });
    }
};

/**
 * Planilla de BONOS del período: nombre completo, puesto, y el bono
 * asignado. A propósito NO lleva AFP/ISSS/ISR — el bono es un pago
 * discrecional del dueño (una gratificación puntual, no una comisión ni una
 * bonificación pactada como parte regular del contrato), así que queda fuera
 * del salario cotizable (ver el comentario en payrollUtils.calculatePayrollDeductions).
 *
 * Mismos query params que getPayroll (period, status), para que ambas
 * planillas del mismo período usen exactamente el mismo filtro de empleados.
 */
payrollController.getBonusPayroll = async (req, res) => {
    try {
        const { period, start, end } = resolvePeriod(req.query.period);
        const statusFilter = req.query.status || "active";

        const filter = {};
        if (statusFilter !== "all") {
            filter["workInfo.status"] = statusFilter;
        }
        filter.$or = [
            { createdAt: { $lte: end } },
            { createdAt: { $exists: false } },
        ];

        const employees = await EmployeeModel.find(filter)
            .select("personalInfo workInfo createdAt")
            .sort({ "personalInfo.name": 1 });

        const rows = employees.map((employee) => ({
            employeeId: employee._id,
            name: `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim() || "Sin nombre",
            image: employee.personalInfo?.image || null,
            type: employee.personalInfo?.type || "other",
            typeLabel: EMPLOYEE_TYPE_LABELS[employee.personalInfo?.type] || "Otro",
            status: employee.workInfo?.status || "active",
            bonus: round2(Number(employee.workInfo?.additionalPay) || 0),
        }));

        const totals = {
            employeeCount: rows.length,
            // Solo cuentan quienes de verdad tienen bono asignado este período.
            employeesWithBonus: rows.filter((r) => r.bonus > 0).length,
            totalBonus: round2(rows.reduce((acc, r) => acc + r.bonus, 0)),
        };

        return res.status(200).json({
            period,
            periodStart: start,
            periodEnd: end,
            rows,
            totals,
        });
    } catch (error) {
        console.error("payrollController.getBonusPayroll:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo calcular la planilla de bonos." });
    }
};

export default payrollController;
