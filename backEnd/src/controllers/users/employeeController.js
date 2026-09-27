// Importamos el modelo y las utilidades para consultar y validar la información de empleados
import bcryptjs from "bcryptjs";
import EmployeeModel from "../../models/users/employeeModel.js";
import crudUtils from "../../utils/users/crudUtils.js";
import validationUtils from "../../utils/auth/validationsUsersUtils.js";
import invitationValidationsUtils from "../../utils/auth/invitationValidationsUtils.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import cloudinaryUtils from "../../utils/cloudinaryUtils.js";
import emailUtils from "../../utils/auth/emailUtils.js";
import { config } from "../../../config.js";
import { isValidPermission } from "../../constants/permissions.js";
import { ensureAccessCodeIfNeeded } from "../../utils/users/accessCodeUtils.js";
import {
  validateEmployeePhone, normalizeEmployeePhone, validateIsss, validateAfpInstitution,
  validateBankAccount, validateLegalSchedule,
} from "../../utils/users/employeeFieldValidations.js";

const employeeController = {};

// Obtiene la lista de todos los empleados
employeeController.getEmployees = async (req, res) => {
    try {
        const employees = await crudUtils.searchDocuments(EmployeeModel, req.query);
        return res.status(200).json(employees);
    } catch (error) {
        console.error("employeeController.getEmployees:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo obtener la lista de empleados." });
    }
};

// Actualiza los datos de un empleado (nombre, apellido, teléfono, dirección, tipo de rol, salario o imagen)
employeeController.updateEmployee = async (req, res) => {
    try {
        const {
            name, lastname, phone, address, type, salary, shift, schedule,
            workDays, scheduleStart, scheduleEnd,
            weekendScheduleEnabled, weekendScheduleStart, weekendScheduleEnd,
            status, permissions,
            isssNumber, afpInstitution, bankName, bankAccount,
        } = req.body;
        const updateData = {};
        const validationsToRun = [];

        // La ruta permite tanto a un admin como al propio empleado llegar acá
        // (ver ownershipMiddleware en la ruta). Un empleado editando SU PROPIA
        // ficha no debe poder cambiarse a sí mismo el puesto, salario, estado
        // laboral ni sus permisos: eso son decisiones exclusivas del admin,
        // aunque el endpoint sea el mismo.
        const isSelfEdit = req.user?.role === "employee" && req.user?.id === req.params.id;
        if (isSelfEdit && (type !== undefined || salary !== undefined || status !== undefined || permissions !== undefined)) {
            return res.status(403).json({
                title: "Campos no permitidos",
                message: "No podés modificar tu puesto, salario, estado o permisos. Pedile a un administrador que lo haga.",
            });
        }

        // Mapeo dinámico y validaciones
        if (name !== undefined) {
            validationsToRun.push(() => validationUtils.validateName(name, "El nombre"));
            updateData["personalInfo.name"] = name.trim();
        }
        if (lastname !== undefined) {
            validationsToRun.push(() => validationUtils.validateName(lastname, "El apellido"));
            updateData["personalInfo.lastname"] = lastname.trim();
        }
        if (phone !== undefined) {
            validationsToRun.push(() => validateEmployeePhone(phone));
            updateData["personalInfo.phone"] = normalizeEmployeePhone(phone);
        }
        if (address !== undefined) {
            validationsToRun.push(() => validationUtils.validateAddress(address));
            updateData["personalInfo.address"] = address.trim();
        }
        if (type !== undefined) {
            validationsToRun.push(() => invitationValidationsUtils.validateEmployeeType(type));
            updateData["personalInfo.type"] = type;
        }
        if (salary !== undefined) {
            validationsToRun.push(() => validationUtils.validatePositiveNumber(salary, "El salario"));
            updateData["workInfo.salary"] = Number(salary);
        }
        if (shift !== undefined) {
            validationsToRun.push(() =>
                typeof shift === "string" && shift.trim().length > 0
                    ? { valid: true }
                    : { valid: false, message: "El turno debe ser un texto no vacío." }
            );
            updateData["workInfo.shift"] = typeof shift === "string" ? shift.trim() : shift;
        }
        if (schedule !== undefined) {
            validationsToRun.push(() =>
                typeof schedule === "string" && schedule.trim().length > 0
                    ? { valid: true }
                    : { valid: false, message: "El horario debe ser un texto no vacío." }
            );
            updateData["workInfo.schedule"] = typeof schedule === "string" ? schedule.trim() : schedule;
        }

        // Días de la semana que trabaja (para saber si está en turno "ahora mismo")
        if (workDays !== undefined) {
            updateData["workInfo.workDays"] = Array.isArray(workDays) ? workDays : [];
        }
        if (scheduleStart !== undefined) updateData["workInfo.scheduleStart"] = scheduleStart || null;
        if (scheduleEnd !== undefined) updateData["workInfo.scheduleEnd"] = scheduleEnd || null;
        if (weekendScheduleEnabled !== undefined) {
            updateData["workInfo.weekendScheduleEnabled"] = weekendScheduleEnabled === true || weekendScheduleEnabled === "true";
        }
        if (weekendScheduleStart !== undefined) updateData["workInfo.weekendScheduleStart"] = weekendScheduleStart || null;
        if (weekendScheduleEnd !== undefined) updateData["workInfo.weekendScheduleEnd"] = weekendScheduleEnd || null;

        // Permisos granulares (pantallas y funciones específicas que puede ver/usar)
        let permissionsChanged = false;
        if (permissions !== undefined) {
            if (!Array.isArray(permissions) || permissions.some((p) => !isValidPermission(p))) {
                return res.status(400).json({ title: "Permisos inválidos", message: "Uno o más permisos no existen en el catálogo del sistema." });
            }
            updateData.permissions = permissions;
            permissionsChanged = true;
        }

        // Previsión y banco (la ficha del empleado los edita; antes se
        // mandaban pero no se guardaban)
        if (isssNumber !== undefined) {
            validationsToRun.push(() => validateIsss(isssNumber));
            updateData["workInfo.isssNumber"] = String(isssNumber ?? "").trim() || null;
        }
        if (afpInstitution !== undefined) {
            validationsToRun.push(() => validateAfpInstitution(afpInstitution));
            updateData["workInfo.afpInstitution"] = afpInstitution || null;
        }

        // El horario y el banco se validan contra lo que ya tiene guardado el
        // empleado, porque el cambio puede traer solo una parte (ej. solo la
        // hora de salida, o solo la cuenta).
        const touchesSchedule = [workDays, scheduleStart, scheduleEnd, weekendScheduleEnabled, weekendScheduleStart, weekendScheduleEnd]
            .some((v) => v !== undefined);
        const touchesBank = bankName !== undefined || bankAccount !== undefined;
        if (touchesSchedule || touchesBank) {
            const current = await EmployeeModel.findById(req.params.id).select("workInfo").lean();
            if (!current) return res.status(404).json({ title: "Empleado no encontrado", message: "No se encontró el empleado solicitado." });
            const work = current.workInfo || {};

            if (touchesSchedule) {
                const pick = (incoming, saved) => (incoming !== undefined ? incoming : saved);
                validationsToRun.push(() => validateLegalSchedule({
                    workDays: pick(workDays, work.workDays),
                    scheduleStart: pick(scheduleStart, work.scheduleStart) || null,
                    scheduleEnd: pick(scheduleEnd, work.scheduleEnd) || null,
                    weekendScheduleEnabled: pick(weekendScheduleEnabled, work.weekendScheduleEnabled) === true
                        || pick(weekendScheduleEnabled, work.weekendScheduleEnabled) === "true",
                    weekendScheduleStart: pick(weekendScheduleStart, work.weekendScheduleStart) || null,
                    weekendScheduleEnd: pick(weekendScheduleEnd, work.weekendScheduleEnd) || null,
                }));
            }

            if (touchesBank) {
                const nextBank = bankName !== undefined ? String(bankName ?? "").trim() : work.bankName;
                const nextAccount = bankAccount !== undefined ? String(bankAccount ?? "").trim() : work.bankAccount;
                // Un banco escrito a mano antes de que existiera la lista se
                // puede conservar tal cual.
                validationsToRun.push(() => validateBankAccount(nextBank, nextAccount, work.bankName));
                updateData["workInfo.bankName"] = nextBank || null;
                updateData["workInfo.bankAccount"] = nextAccount || null;
            }
        }

        // Alta/baja del empleado
        if (status !== undefined) {
            validationsToRun.push(() =>
                ['active', 'inactive'].includes(status)
                    ? { valid: true }
                    : { valid: false, message: "El estado debe ser 'active' o 'inactive'." }
            );
            updateData["workInfo.status"] = status;
        }

        // req.file lo agrega multer (la ruta debe tener upload.single("image")).
        // Solo se actualiza la imagen si efectivamente se mandó un archivo
        // nuevo — si no, el campo image existente en la DB no se toca.
        if (req.file) {
            updateData["personalInfo.image"] = req.file.path;
        }

        // Ejecutar todas las validaciones acumuladas
        if (validationsToRun.length > 0) {
            const result = validationUtils.runValidations(validationsToRun);
            if (!result.valid) return res.status(400).json({ title: "Datos inválidos", message: result.message });
        }

        // Si viene una foto nueva, guardamos la URL de la anterior para
        // borrarla de Cloudinary después de que la actualización tenga éxito
        let previousImage = null;
        if (req.file) {
            const currentEmployee = await EmployeeModel.findById(req.params.id).select("personalInfo.image");
            previousImage = currentEmployee?.personalInfo?.image || null;
        }

        const mongoUpdate = { $set: updateData };
        // Si cambian los permisos, se fuerza el cierre de sesión del empleado
        // (el JWT viejo trae los permisos anteriores embebidos)
        if (permissionsChanged) mongoUpdate.$inc = { tokenVersion: 1 };

        const updatedEmployee = await EmployeeModel.findByIdAndUpdate(
            req.params.id,
            mongoUpdate,
            { new: true, runValidators: true }
        ).select("-loginInfo.password");

        if (!updatedEmployee) return res.status(404).json({ title: "Empleado no encontrado", message: "No se encontró el empleado solicitado." });

        // La imagen anterior ya no la usa nadie, la eliminamos de Cloudinary
        if (previousImage) {
            await cloudinaryUtils.deletePreviousImage(previousImage);
        }

        // Primera vez que este empleado tiene algún permiso: le mandamos su
        // código de acceso por correo (no hace nada si ya tenía uno o si
        // permissions sigue vacío)
        if (permissionsChanged) {
            await ensureAccessCodeIfNeeded(EmployeeModel, updatedEmployee);
        }

        const employeeName = `${updatedEmployee.personalInfo?.name || ""} ${updatedEmployee.personalInfo?.lastname || ""}`.trim();

        await notificationUtils.createNotification({
            req,
            category: "staff",
            action: "updated",
            title: "Perfil de empleado actualizado",
            // Si alguien edita su propia ficha lo redactamos distinto, para que se entienda
            message: (actor) =>
                actor.id?.toString() === updatedEmployee._id.toString()
                    ? `${actor.name} actualizó su propio perfil`
                    : `${actor.name} actualizó el perfil de ${employeeName}`,
            icon: "user-pen",
            severity: "info",
            entity: { model: "Employee", id: updatedEmployee._id, label: employeeName },
        });

        return res.status(200).json({ title: "Empleado actualizado", message: "Los datos se actualizaron correctamente.", data: updatedEmployee });
    } catch (error) {
        console.error("employeeController.updateEmployee:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo actualizar el empleado." });
    }
};

// El admin dispara esto desde la ficha del empleado: nunca escribe la nueva
// contraseña él mismo, solo manda un enlace al correo del empleado para que
// sea el propio empleado quien la defina.
employeeController.sendPasswordResetInvitation = async (req, res) => {
    try {
        const employee = await EmployeeModel.findById(req.params.id).select("personalInfo loginInfo.email");
        if (!employee) return res.status(404).json({ title: "Empleado no encontrado", message: "No se encontró el empleado solicitado." });

        const token = emailUtils.generateToken({ employeeId: employee._id.toString(), purpose: "employeePasswordReset" }, "24h");
        const link = `${config.frontendUrl}/employee-password-reset?token=${token}`;

        await emailUtils.sendEmail(
            employee.loginInfo.email,
            "Cambio de contraseña solicitado - SYSCOR",
            emailUtils.htmlPasswordResetInvitationEmail(link)
        );

        const employeeName = `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim();
        await notificationUtils.createNotification({
            req,
            category: "staff",
            action: "updated",
            title: "Invitación de cambio de contraseña enviada",
            message: (actor) => `${actor.name} solicitó un cambio de contraseña para ${employeeName}`,
            icon: "key",
            severity: "info",
            entity: { model: "Employee", id: employee._id, label: employeeName },
        });

        return res.status(200).json({ title: "Invitación enviada", message: "Se envió un correo al empleado para que defina su nueva contraseña." });
    } catch (error) {
        console.error("employeeController.sendPasswordResetInvitation:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo enviar la invitación de cambio de contraseña." });
    }
};

// El empleado llega aquí desde el enlace del correo (sin sesión iniciada) y
// define su propia contraseña nueva.
employeeController.resetPasswordWithToken = async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ title: "Datos inválidos", message: "Falta el token o la nueva contraseña." });
        }

        const passwordCheck = validationUtils.validatePassword(newPassword);
        if (!passwordCheck.valid) {
            return res.status(400).json({ title: "Contraseña inválida", message: passwordCheck.message });
        }

        let decoded;
        try {
            decoded = emailUtils.verifyToken(token);
        } catch {
            return res.status(401).json({ title: "Enlace vencido", message: "El enlace ya no es válido, solicita uno nuevo." });
        }

        if (decoded.purpose !== "employeePasswordReset") {
            return res.status(401).json({ title: "Enlace inválido", message: "Este enlace no corresponde a un cambio de contraseña." });
        }

        const hashedPassword = await bcryptjs.hash(newPassword, 10);
        const updated = await EmployeeModel.findByIdAndUpdate(
            decoded.employeeId,
            { $set: { "loginInfo.password": hashedPassword, "loginInfo.loginAttempts": 0, "loginInfo.timeOut": null } },
            { new: true }
        );

        if (!updated) return res.status(404).json({ title: "Empleado no encontrado", message: "No se encontró el empleado solicitado." });

        return res.status(200).json({ title: "Contraseña actualizada", message: "Tu contraseña se cambió correctamente." });
    } catch (error) {
        console.error("employeeController.resetPasswordWithToken:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo cambiar la contraseña." });
    }
};

export default employeeController;
