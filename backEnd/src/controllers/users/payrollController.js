// Planilla (RRHH): arma el detalle de pago de cada empleado para un período.
//
// El cálculo de los descuentos de ley NO vive aquí: es payrollUtils quien lo
// hace, y es la única fuente de verdad del sistema (la usa también el alta de
// empleados para guardar AFP/ISSS/renta en su ficha). Este controlador solo
// decide QUIÉN entra en la planilla del período, le suma el bono vigente y
// calcula los totales.
import EmployeeModel from "../../models/users/employeeModel.js";
import { calculatePayrollDeductions } from "../../utils/users/payrollUtils.js";

const payrollController = {};

// Puestos traducidos, mismo vocabulario que ya usa notificationUtils para
// redactar los avisos del sistema.
const EMPLOYEE_TYPE_LABELS = {
    kitchen: "Cocina",
    waiter: "Mesero",
    cashier: "Cajero",
    delivery: "Repartidor",
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
 * Bono que le corresponde al empleado en el período.
 *
 * El bono ("additionalPay") se pacta por un plazo (15 días, 1, 2 o 3 meses)
 * que termina en additionalPayEndsAt. Entra en la planilla de cada período en
 * el que estuvo vigente: si ya había vencido antes de que empezara el mes, no
 * se paga. Los bonos viejos sin fecha de fin se toman como vigentes.
 */
const resolveBonus = (work, start) => {
    const amount = round2(Number(work.additionalPay) || 0);
    if (amount <= 0) return { bonus: 0, bonusEndsAt: null };

    const endsAt = work.additionalPayEndsAt ? new Date(work.additionalPayEndsAt) : null;
    if (endsAt && endsAt < start) return { bonus: 0, bonusEndsAt: endsAt };

    return { bonus: amount, bonusEndsAt: endsAt };
};

/**
 * Fila de planilla de UN empleado: salario y sus descuentos de ley, el bono
 * del período y el total que se le paga.
 *
 * Los descuentos de ley (AFP, ISSS, ISR) se calculan SOLO sobre el salario
 * base. El bono se suma después, íntegro: es un pago discrecional del dueño,
 * no salario cotizable (ver el comentario en
 * payrollUtils.calculatePayrollDeductions).
 */
const buildPayrollRow = (employee, start) => {
    const work = employee.workInfo || {};
    const deductions = calculatePayrollDeductions(Number(work.salary) || 0);
    const { bonus, bonusEndsAt } = resolveBonus(work, start);

    return {
        employeeId: employee._id,
        name: `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim() || "Sin nombre",
        image: employee.personalInfo?.image || null,
        type: employee.personalInfo?.type || "other",
        typeLabel: EMPLOYEE_TYPE_LABELS[employee.personalInfo?.type] || "Otro",
        status: work.status || "active",
        grossSalary: deductions.grossSalary,
        bonus,
        bonusEndsAt,
        // Todo lo devengado en el período: salario + bono.
        totalEarnings: round2(deductions.grossSalary + bonus),
        afp: deductions.afp,
        isss: deductions.isss,
        isr: deductions.isr,
        // Base sobre la que se calculó el ISR, útil para la boleta
        // individual (explica de dónde sale la retención).
        taxableBase: deductions.taxableBase,
        totalDeductions: round2(deductions.afp + deductions.isss + deductions.isr),
        // Salario menos descuentos de ley, sin el bono.
        netSalary: deductions.netSalary,
        // Lo que de verdad se le desembolsa: salario neto + bono.
        netPay: round2(deductions.netSalary + bonus),
    };
};

/**
 * Devuelve la planilla del período: una fila por empleado con su salario
 * bruto, sus descuentos de ley, su bono y el total a pagar.
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

        const rows = employees.map((employee) => buildPayrollRow(employee, start));

        // Totales del período, para el encabezado de la pantalla y el PDF.
        const totals = rows.reduce(
            (acc, row) => ({
                grossSalary: round2(acc.grossSalary + row.grossSalary),
                bonus: round2(acc.bonus + row.bonus),
                totalEarnings: round2(acc.totalEarnings + row.totalEarnings),
                afp: round2(acc.afp + row.afp),
                isss: round2(acc.isss + row.isss),
                isr: round2(acc.isr + row.isr),
                totalDeductions: round2(acc.totalDeductions + row.totalDeductions),
                netSalary: round2(acc.netSalary + row.netSalary),
                netPay: round2(acc.netPay + row.netPay),
            }),
            { grossSalary: 0, bonus: 0, totalEarnings: 0, afp: 0, isss: 0, isr: 0, totalDeductions: 0, netSalary: 0, netPay: 0 }
        );
        // Solo cuentan quienes de verdad tienen bono vigente este período.
        totals.employeesWithBonus = rows.filter((r) => r.bonus > 0).length;

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
 * Es la misma fila de la planilla (buildPayrollRow), pero devuelta con el
 * detalle que necesita una constancia individual: datos de identificación
 * del empleado, desglose de lo devengado contra lo deducido, y el total a
 * pagar. Se usa para entregarle al empleado su comprobante de pago.
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
        const row = buildPayrollRow(employee, start);

        return res.status(200).json({
            period,
            periodStart: start,
            periodEnd: end,
            employee: {
                id: employee._id,
                name: row.name,
                image: row.image,
                type: row.type,
                typeLabel: row.typeLabel,
                duiNit: employee.personalInfo?.duiNit || null,
                phone: employee.personalInfo?.phone || null,
                email: employee.loginInfo?.email || null,
                status: row.status,
                // El horario se incluye porque una constancia de trabajo suele
                // necesitarlo (ej. para un trámite bancario).
                schedule: work.scheduleStart && work.scheduleEnd
                    ? `${work.scheduleStart} - ${work.scheduleEnd}`
                    : null,
                workDays: work.workDays || [],
                hiredAt: employee.createdAt || null,
            },
            // Lo que se le reconoce en el período: salario y bono vigente.
            earnings: {
                salary: row.grossSalary,
                bonus: row.bonus,
                bonusEndsAt: row.bonusEndsAt,
                total: row.totalEarnings,
            },
            // Lo que se le descuenta (solo sobre el salario), con la base que
            // originó la retención.
            deductions: {
                afp: row.afp,
                isss: row.isss,
                isr: row.isr,
                taxableBase: row.taxableBase,
                total: row.totalDeductions,
            },
            netSalary: row.netSalary,
            netPay: row.netPay,
        });
    } catch (error) {
        console.error("payrollController.getEmployeePayslip:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo generar la boleta de pago." });
    }
};

export default payrollController;
