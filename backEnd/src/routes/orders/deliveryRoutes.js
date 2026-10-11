import { Router } from "express";
import deliveryController from "../../controllers/orders/deliveryController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requireEmployeeType } from "../../middlewares/auth/permissionMiddleware.js";
import upload from "../../utils/cloudinaryConfig.js";

const router = Router();

// Solo empleados con puesto "delivery" (repartidores del restaurante).
router.use(validateAuthCookie(["employee"]), requireEmployeeType(["delivery"]));

// Pedidos a domicilio listos en cocina que todavía esperan repartidor
router.get("/queue", deliveryController.getQueue);

// Paquete que Chef Panchita le asignó al repartidor, con sus paradas en orden
router.get("/package", deliveryController.getPackage);

// Salir del local con el paquete asignado (va ANTES de "/:id/start")
router.patch("/package/start", deliveryController.startPackage);

// Interruptor "En turno": solo a quien está en turno le asigna paquetes Panchita
router.get("/availability", deliveryController.getAvailability);
router.patch("/availability", deliveryController.setAvailability);

// Parada que el repartidor tiene que entregar ahora
router.get("/mine", deliveryController.getMine);

// Historial de entregas completadas del repartidor con sesión
router.get("/history", deliveryController.getHistory);

// Respaldo manual: tomar un pedido de la cola sin paquete asignado
router.patch("/:id/start", deliveryController.start);

// Confirmar que la entrega fue completada (foto opcional en el campo "proof")
router.patch("/:id/confirm", upload.single("proof"), deliveryController.confirm);

export default router;
