// Importamos los modelos y utilidades necesarios para gestionar empleados, enviar correos y validar datos
import EmployeeModel from "../../../models/users/employeeModel.js";
import emailUtils from "../../../utils/auth/emailUtils.js";
import utils from "../../../utils/auth/validationsUsersUtils.js";
import invitationValidationsUtils from "../../../utils/auth/invitationValidationsUtils.js";
import notificationUtils from "../../../utils/notifications/notificationUtils.js";
import { config } from "../../../../config.js";
import { isValidPermission } from "../../../constants/permissions.js";
import { ensureAccessCodeIfNeeded } from "../../../utils/users/accessCodeUtils.js";
import { calculatePayrollDeductions } from "../../../utils/users/payrollUtils.js";

const inviteEmployeeController = {};

/**
 * Un Admin invita a alguien a unirse como Empleado. A diferencia de la
 * invitación de Admin, acá ya se definen los datos laborales (tipo de
 * puesto, salario, etc.) porque eso lo decide el negocio, no el empleado al
 * registrarse. AFP, ISSS y renta ya no se piden: son descuentos de ley con
 * porcentajes fijos, se calculan automáticamente a partir del salario (ver
 * utils/users/payrollUtils.js).
 */
inviteEmployeeController.sendInvitation = async (req, res) => {
  const {
    email,
    name,
    lastname,
    phone,
    duiNit,
    address,
    type,
    salary,
    additionalPay,
    additionalPayDuration,
    workInsurance,
    workDays,
    scheduleStart,
    scheduleEnd,
    permissions,
    // Datos leídos del DUI (el admin ya los revisó y corrigió)
    birthDate,
    gender,
    maritalStatus,
    // Identificadores de ley: pueden venir vacíos a propósito, ver más abajo
    isssNumber,
    afpInstitution,
    afpNumber,
    bankName,
    bankAccount,
    // Documentos ya subidos a Cloudinary en pasos previos del asistente
    documents,
  } = req.body;

  // Revisamos todos los campos antes de mandar nada: si algo falla, avisamos apenas ese primer error
  const validation = utils.runValidations([
    () => utils.validateEmail(email),
    () => utils.validateName(name, "El nombre"),
    () => utils.validateName(lastname, "El apellido"),
    () => utils.validatePhone(phone),
    () => utils.validateAddress(address),
    () => invitationValidationsUtils.validateEmployeeType(type),
    () => utils.validatePositiveNumber(salary, "El salario"),
    () => (additionalPay !== undefined ? utils.validatePositiveNumber(additionalPay, "El pago adicional") : { valid: true }),
    () =>
      permissions === undefined || (Array.isArray(permissions) && permissions.every(isValidPermission))
        ? { valid: true }
        : { valid: false, message: "Uno o más permisos no existen en el catálogo del sistema." },
  ]);

  if (!validation.valid) {
    return res.status(400).json({ title: "Datos inválidos", message: validation.message });
  }

  const { afp, isss, isr, netSalary } = calculatePayrollDeductions(salary);

  // Un bono se pacta por un tiempo definido, no para siempre. Si el admin
  // indicó una duración, se calcula desde ya la fecha en que deja de
  // corresponder, para no tener que interpretarlo después en cada consulta.
  const resolveAdditionalPayEnd = (duration) => {
    if (!duration || !Number(additionalPay)) return null;

    const end = new Date();
    switch (duration) {
      case "15d": end.setDate(end.getDate() + 15); break;
      case "1m": end.setMonth(end.getMonth() + 1); break;
      case "2m": end.setMonth(end.getMonth() + 2); break;
      case "3m": end.setMonth(end.getMonth() + 3); break;
      default: return null;
    }
    return end;
  };

  const additionalPayEndsAt = resolveAdditionalPayEnd(additionalPayDuration);

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Si ya existe un empleado con ese correo, no tiene sentido invitarlo de nuevo
    const exists = await EmployeeModel.findOne({ "loginInfo.email": normalizedEmail });
    if (exists) {
      return res.status(409).json({ title: "Empleado ya existe", message: "Ya existe un empleado registrado con este correo electrónico." });
    }

    // Guardamos todos los datos dentro de un token firmado: así el empleado
    // no puede alterar su salario ni su puesto cuando complete el registro
    const invitationToken = emailUtils.generateToken(
      {
        email: normalizedEmail,
        role: "employee",
        invited: true,
        invitedBy: req.user?.id || null,
        personalInfo: {
          name: name.trim(),
          lastname: lastname.trim(),
          phone: phone.trim(),
          duiNit: duiNit.trim(),
          address: address.trim(),
          type,
          // Datos del DUI: van en el token para que el empleado no pueda
          // alterarlos al completar su registro, igual que el salario.
          birthDate: birthDate || null,
          gender: gender || null,
          maritalStatus: maritalStatus || null,
        },
        documents: documents || {},
        workInfo: {
          salary: Number(salary),
          AFP: afp,
          isss,
          rent: isr,
          additionalPay: Number(additionalPay) || 0,
          additionalPayDuration: additionalPayDuration || null,
          additionalPayEndsAt,
          workInsurance: workInsurance === true || workInsurance === "true",
          workDays: Array.isArray(workDays) ? workDays : [],
          scheduleStart: scheduleStart || null,
          scheduleEnd: scheduleEnd || null,
          // Pueden quedar vacíos: la ficha del empleado se marcará como
          // incompleta (ver el virtual missingFields del modelo) hasta que
          // alguien los complete.
          isssNumber: isssNumber?.trim() || null,
          afpInstitution: afpInstitution || null,
          afpNumber: afpNumber?.trim() || null,
          bankName: bankName?.trim() || null,
          bankAccount: bankAccount?.trim() || null,
        },
        permissions: Array.isArray(permissions) ? permissions : [],
      },
      "24h"
    );

    const invitationLink = `${config.frontendUrl}/employee/accept-invitation?token=${invitationToken}`;

    // Le mandamos el correo con el enlace antes de confirmar nada al admin
    await emailUtils.sendEmail(
      email,
      "Has sido invitado a SYSCOR",
      emailUtils.htmlInvitationEmail(invitationLink, "Empleado")
    );

    const typeLabel = notificationUtils.EMPLOYEE_TYPE_LABELS[type] || type;

    await notificationUtils.createNotification({
      req,
      category: "staff",
      action: "invited",
      title: "Invitación enviada",
      message: (actor) =>
        `${actor.name} invitó a ${normalizedEmail} a unirse como Empleado (${typeLabel})`,
      icon: "envelope",
      severity: "info",
      entity: { model: "Employee", id: null, label: normalizedEmail },
    });

    return res.status(200).json({
      title: "Invitación enviada",
      message: "La invitación se envió correctamente al correo indicado.",
      payroll: { grossSalary: Number(salary), afp, isss, isr, netSalary },
    });
  } catch (error) {
    console.error("inviteEmployeeController.sendInvitation:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno al enviar la invitación." });
  }
};

/**
 * El invitado abre el enlace del correo; este endpoint valida el token y
 * le devuelve al frontend los datos a precargar (nombre, puesto, etc.)
 * sin exponer datos sensibles de planilla como el salario.
 */
inviteEmployeeController.validateInvitation = async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ title: "Token requerido", message: "El token de invitación es requerido." });
  }

  try {
    const decoded = emailUtils.verifyToken(token);

    if (!decoded.invited || decoded.role !== "employee") {
      return res.status(400).json({ title: "Token inválido", message: "El token de invitación no es válido." });
    }

    return res.status(200).json({
      email: decoded.email,
      personalInfo: {
        name: decoded.personalInfo.name,
        lastname: decoded.personalInfo.lastname,
        type: decoded.personalInfo.type,
      },
    });
  } catch (error) {
    // Si el token venció, se lo decimos explícito para que pida uno nuevo
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ title: "Invitación expirada", message: "Esta invitación ya venció. Pide a un administrador que envíe una nueva." });
    }
    console.error("inviteEmployeeController.validateInvitation:", error);
    return res.status(400).json({ title: "Token inválido", message: "El token de invitación no es válido o está dañado." });
  }
};

/**
 * Paso final: el empleado invitado define su contraseña y, opcionalmente,
 * sube su foto de perfil (multipart/form-data, campo "image"). La ruta
 * debe tener upload.single("image") ANTES de este controller — ese
 * middleware ya subió el archivo a Cloudinary y dejó la URL en req.file.path.
 *
 * Todo lo demás (datos personales y laborales) viene del token firmado
 * por el admin, no del body, para que el empleado no pueda alterar su
 * propio salario o tipo de puesto durante el registro.
 *
 * isAuthorized se pone en true automáticamente, porque el hecho de venir
 * de una invitación de un admin YA es la autorización.
 */
inviteEmployeeController.acceptInvitation = async (req, res) => {
  const { token, password } = req.body;

  // La contraseña la escribe el empleado en este paso, así que se valida aquí
  const passwordValidation = utils.validatePassword(password);
  if (!passwordValidation.valid) {
    return res.status(400).json({ title: "Contraseña inválida", message: passwordValidation.message });
  }

  try {
    const decoded = emailUtils.verifyToken(token);

    if (!decoded.invited || decoded.role !== "employee") {
      return res.status(400).json({ title: "Token inválido", message: "El token de invitación no es válido." });
    }

    const exists = await EmployeeModel.findOne({ "loginInfo.email": decoded.email });
    if (exists) {
      return res.status(409).json({ title: "Empleado ya existe", message: "Ya existe un empleado registrado con este correo electrónico." });
    }

    const bcryptjs = (await import("bcryptjs")).default;
    const passwordHash = await bcryptjs.hash(password, 10);

    // req.file lo agrega multer (vía upload.single("image") en la ruta).
    // Si la ruta no tiene ese middleware, req.file siempre será undefined
    // y la imagen quedará en null sin lanzar ningún error.
    const imageUrl = req.file ? req.file.path : null;

    const newEmployee = new EmployeeModel({
      personalInfo: {
        name: decoded.personalInfo.name,
        lastname: decoded.personalInfo.lastname,
        duiNit: decoded.personalInfo.duiNit,
        address: decoded.personalInfo.address,
        phone: decoded.personalInfo.phone,
        image: imageUrl,
        type: decoded.personalInfo.type,
        // Datos que salieron del DUI al invitarlo
        birthDate: decoded.personalInfo.birthDate || null,
        gender: decoded.personalInfo.gender || null,
        maritalStatus: decoded.personalInfo.maritalStatus || null,
      },
      // Fotos del DUI y demás documentos recopilados durante la invitación
      documents: decoded.documents || {},
      loginInfo: {
        email: decoded.email,
        password: passwordHash,
        isVerified: true,
        loginAttempts: 0,
        timeOut: null,
      },
      workInfo: {
        salary: decoded.workInfo.salary,
        AFP: decoded.workInfo.AFP,
        isss: decoded.workInfo.isss,
        rent: decoded.workInfo.rent,
        additionalPay: decoded.workInfo.additionalPay,
        additionalPayDuration: decoded.workInfo.additionalPayDuration || null,
        additionalPayEndsAt: decoded.workInfo.additionalPayEndsAt || null,
        workInsurance: decoded.workInfo.workInsurance,
        workDays: decoded.workInfo.workDays || [],
        scheduleStart: decoded.workInfo.scheduleStart || null,
        scheduleEnd: decoded.workInfo.scheduleEnd || null,
        isssNumber: decoded.workInfo.isssNumber || null,
        afpInstitution: decoded.workInfo.afpInstitution || null,
        afpNumber: decoded.workInfo.afpNumber || null,
        bankName: decoded.workInfo.bankName || null,
        bankAccount: decoded.workInfo.bankAccount || null,
        isAuthorized: true,
        status: "active",
      },
      permissions: decoded.permissions || [],
    });

    await newEmployee.save();

    // Ya tiene contraseña propia (recién la definió arriba): si el admin le
    // asignó permisos desde la invitación, este es el momento de mandarle su
    // código de acceso.
    const accessCodeSent = await ensureAccessCodeIfNeeded(EmployeeModel, newEmployee);

    // Quien acepta la invitación todavía no tiene sesión, así que el actor es
    // la propia persona que acaba de registrarse.
    const fullName = `${newEmployee.personalInfo.name} ${newEmployee.personalInfo.lastname}`.trim();
    const typeLabel =
      notificationUtils.EMPLOYEE_TYPE_LABELS[newEmployee.personalInfo.type] ||
      newEmployee.personalInfo.type;

    await notificationUtils.createNotification({
      req,
      category: "staff",
      action: "registered",
      title: "Nuevo empleado",
      message: `Nuevo empleado registrado: ${fullName} (${typeLabel})`,
      icon: "user-tie",
      severity: "success",
      entity: { model: "Employee", id: newEmployee._id, label: fullName },
      actor: {
        id: newEmployee._id,
        role: "employee",
        name: fullName,
        image: newEmployee.personalInfo.image || null,
      },
    });

    return res.status(201).json({
      title: "Cuenta creada",
      message: "La cuenta del empleado se creó correctamente.",
      hasPermissions: (newEmployee.permissions || []).length > 0,
      accessCodeSent,
    });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ title: "Invitación expirada", message: "Esta invitación ya venció. Pide a un administrador que envíe una nueva." });
    }
    console.error("inviteEmployeeController.acceptInvitation:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo crear la cuenta del empleado." });
  }
};

export default inviteEmployeeController;
