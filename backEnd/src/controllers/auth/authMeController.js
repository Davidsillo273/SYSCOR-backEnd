import AdminModel from "../../models/users/adminModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import { normalizePhones } from "../../utils/users/customerContactUtils.js";

const authMeController = {};

const MODELS_BY_ROLE = {
  admin: AdminModel,
  employee: EmployeeModel,
  customer: CustomerModel,
};

// Campos a excluir siempre, sin importar el rol
const EXCLUDED_FIELDS = "-loginInfo.password -loginInfo.loginAttempts -loginInfo.timeOut -__v";

// Le dice al frontend quién es el usuario que tiene la sesión activa ahora mismo
authMeController.getMe = async (req, res) => {
  try {
    const { id, role } = req.user;

    const model = MODELS_BY_ROLE[role];
    if (!model) {
      return res.status(400).json({ title: "Rol desconocido", message: "El rol del usuario no es válido." });
    }

    const user = await model.findById(id).select(EXCLUDED_FIELDS);

    if (!user) {
      return res.status(401).json({ title: "Sesión inválida", message: "Tu sesión ya no es válida. Inicia sesión nuevamente." });
    }

    return res.status(200).json({
      id: user._id,
      role,
      type: role === "employee" ? user.personalInfo?.type : undefined,
      email: user.loginInfo?.email,
      name: user.personalInfo?.name,
      lastname: user.personalInfo?.lastname,
      image: user.personalInfo?.image || null,
      // Info completa, solo para empleados (es su propio perfil, no hay problema en mostrarla)
      personalInfo: role === "employee" ? user.personalInfo : undefined,
      workInfo: role === "employee" ? user.workInfo : undefined,
      permissions: role === "employee" ? user.permissions : undefined,
      // Datos de contacto del cliente, para "Mi perfil" en la app
      birthdate: role === "customer" ? user.personalInfo?.birthdate || null : undefined,
      phones: role === "customer" ? normalizePhones(user.personalInfo?.phones) : undefined,
      // Saldo a favor (reclamos resueltos por Panchita), usable al pagar
      walletBalance: role === "customer" ? user.wallet?.balance || 0 : undefined,
    });
  } catch (error) {
    console.error("authMeController.getMe:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno al obtener tu sesión." });
  }
};

export default authMeController;
