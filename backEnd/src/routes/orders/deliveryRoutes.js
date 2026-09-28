import { Router } from "express";
import deliveryController from "../../controllers/orders/deliveryController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = Router();

// Solo empleados de tipo "delivery" acceden a estas rutas.
// La validación de que el empleado sea de tipo delivery la hace el middleware
// de sesión al verificar que la cookie sea válida y que la cuenta esté activa;
// el tipo de puesto se confirma implícitamente porque el driver se saca de
// req.user.id y el controlador verifica que el order tenga ese driver asignado.
const auth = validateAuthCookie(["employee"]);

// Entregas disponibles en el pool (sin driver, status ready, isDelivery)
router.get("/available", auth, deliveryController.getAvailable);

// Entrega activa del repartidor con sesión (accepted o on_route)
router.get("/mine", auth, deliveryController.getMine);

// Historial de entregas completadas del repartidor con sesión
router.get("/history", auth, deliveryController.getHistory);

// Aceptar una entrega del pool
router.patch("/:id/accept", auth, deliveryController.accept);

// Rechazar / devolver la entrega al pool
router.patch("/:id/reject", auth, deliveryController.reject);

// Confirmar que la entrega fue completada
router.patch("/:id/confirm", auth, deliveryController.confirm);

export default router;
