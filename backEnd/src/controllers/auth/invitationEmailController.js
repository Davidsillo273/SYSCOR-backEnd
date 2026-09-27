// Comprueba, mientras el admin escribe el correo en "Invitar staff", si ya
// existe una cuenta con ese correo DEL TIPO que se está invitando: al invitar
// un empleado se busca solo entre empleados, y al invitar un admin, solo
// entre administradores. Es la misma regla que aplica el envío de la
// invitación (sendInvitation rechaza con 409 solo si el correo ya existe en
// ese mismo tipo), así que el aviso y el envío nunca se contradicen.
//
// Solo lo puede usar un admin (ver invitationEmailRoutes).
import AdminModel from "../../models/users/adminModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";

const invitationEmailController = {};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tipos que se pueden invitar desde el panel.
const MODELS_BY_ROLE = {
  admin: AdminModel,
  employee: EmployeeModel,
};

invitationEmailController.checkEmail = async (req, res) => {
  const email = String(req.query.email || "").toLowerCase().trim();
  const role = String(req.query.role || "");
  const Model = MODELS_BY_ROLE[role];

  if (!Model) {
    return res.status(400).json({ title: "Tipo inválido", message: "Indica si se invita a un administrador o a un empleado." });
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ title: "Correo inválido", message: "Escribe un correo electrónico válido." });
  }

  try {
    const found = await Model.findOne({ "loginInfo.email": email })
      .select("personalInfo.name personalInfo.lastname")
      .lean();

    const name = found
      ? `${found.personalInfo?.name || ""} ${found.personalInfo?.lastname || ""}`.trim() || null
      : null;

    return res.status(200).json({ email, role, exists: !!found, name });
  } catch (error) {
    console.error("invitationEmailController.checkEmail:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo comprobar el correo." });
  }
};

export default invitationEmailController;
