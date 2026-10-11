import jsonwebtoken from "jsonwebtoken";
import { config } from "../../../config.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { isPushToken } from "../../utils/notifications/pushUtils.js";

// Apoyos de sesión para las apps móviles.
const realtimeAuthController = {};

// GET /auth/socket-ticket
// En el teléfono la cookie de sesión la guarda el motor nativo y no siempre
// viaja en el handshake del WebSocket. La app pide aquí (con la cookie, por
// la API) un ticket de 2 minutos y lo manda en `auth.token` al conectarse.
// Lleva lo mismo que la cookie, así que no da más acceso del que ya tiene.
realtimeAuthController.getSocketTicket = (req, res) => {
  const { id, role, permissions, tokenVersion } = req.user;
  const token = jsonwebtoken.sign(
    { id, role, permissions: permissions || [], tokenVersion: tokenVersion || 0, purpose: "socket" },
    config.jwt.secret,
    { expiresIn: "2m" },
  );
  return res.json({ token });
};

const MAX_PUSH_TOKENS = 5;

// POST /auth/push-token  { token } — la app de empleados registra el teléfono
// para recibir avisos (paquete asignado, mensajes del cliente).
realtimeAuthController.registerPushToken = async (req, res) => {
  try {
    const token = req.body?.token;
    if (!isPushToken(token)) return res.status(400).json({ message: "Token de notificaciones inválido." });
    const employee = await EmployeeModel.findById(req.user.id).select("pushTokens");
    if (!employee) return res.status(404).json({ message: "Empleado no encontrado." });
    const tokens = (employee.pushTokens || []).filter((t) => t !== token);
    tokens.push(token);
    employee.pushTokens = tokens.slice(-MAX_PUSH_TOKENS);
    await employee.save();
    return res.json({ message: "Notificaciones activadas." });
  } catch (error) {
    console.error("registerPushToken:", error);
    return res.status(500).json({ message: "No se pudo registrar el teléfono." });
  }
};

// DELETE /auth/push-token  { token } — al cerrar sesión.
realtimeAuthController.removePushToken = async (req, res) => {
  try {
    const token = req.body?.token;
    if (token) await EmployeeModel.updateOne({ _id: req.user.id }, { $pull: { pushTokens: token } });
    return res.json({ message: "Notificaciones desactivadas." });
  } catch (error) {
    console.error("removePushToken:", error);
    return res.status(500).json({ message: "No se pudo quitar el teléfono." });
  }
};

export default realtimeAuthController;
