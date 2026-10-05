import { rejectKitchenDevice } from "./kitchenDeviceMiddleware.js";

// Verifica permisos granulares (ej. "menu:create") para rutas que requieren
// algo más específico que solo el rol. Se usa DESPUÉS de validateAuthCookie,
// que ya deja req.user con lo que venía en el JWT (incluye "permissions").
//
// Los admins tienen control total del sistema y no manejan permisos
// granulares como los empleados (ver employeeModel.permissions): por eso
// siempre pasan, sin importar qué permiso se pida.
export const requirePermission = (permission) => {
  return (req, res, next) => {
    // Los permisos de una pantalla de cocina son otros y se revisan en
    // kitchenDeviceMiddleware.requireKitchenDevice: aquí nunca pasan.
    if (req.kitchenDevice) return rejectKitchenDevice(res);

    // Si no hay usuario identificado, ni siquiera llegó autenticado hasta aquí
    if (!req.user) {
      return res.status(403).json({ title: "Sesión requerida", message: "No se encontró una sesión activa." });
    }

    if (req.user.role === "admin") {
      return next();
    }

    // Para empleados revisamos su lista de permisos concretos
    const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (!permissions.includes(permission)) {
      return res.status(403).json({ title: "Permiso insuficiente", message: `No tenés permiso para realizar esta acción (${permission}).` });
    }

    return next();
  };
};

export default { requirePermission };
