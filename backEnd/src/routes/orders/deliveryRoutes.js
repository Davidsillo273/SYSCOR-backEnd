import { Router } from "express";
import deliveryController from "../../controllers/orders/deliveryController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requireEmployeeType } from "../../middlewares/auth/permissionMiddleware.js";
import upload from "../../utils/cloudinaryConfig.js";

const router = Router();

// Solo empleados con puesto "delivery" (repartidores del restaurante).
router.use(validateAuthCookie(["employee"]), requireEmployeeType(["delivery"]));

// Pedidos a domicilio listos en cocina que esperan salir
router.get("/queue", deliveryController.getQueue);

// Entrega en camino del repartidor con sesión
router.get("/mine", deliveryController.getMine);

// Historial de entregas completadas del repartidor con sesión
router.get("/history", deliveryController.getHistory);

// Salir con un pedido de la cola
router.patch("/:id/start", deliveryController.start);

// Confirmar que la entrega fue completada (foto opcional en el campo "proof")
router.patch("/:id/confirm", upload.single("proof"), deliveryController.confirm);

export default router;
