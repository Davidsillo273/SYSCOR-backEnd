import { Router } from "express";
import orderChatController from "../../controllers/orders/orderChatController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = Router();

// Cliente dueño del pedido o repartidor asignado; el controlador valida cuál
// de los dos es (ver orderChatUtils.loadChatOrder).
router.use(validateAuthCookie(["customer", "employee"]));

/**
 * @swagger
 * /orders/chat/{orderId}:
 *   get:
 *     summary: Conversación del pedido entre cliente y repartidor (la marca como leída)
 *     tags: [Orders]
 *   post:
 *     summary: Envía un mensaje al otro lado del chat ({ text, preset? })
 *     tags: [Orders]
 */
router.get("/:orderId", orderChatController.getConversation);
router.post("/:orderId", orderChatController.postMessage);

export default router;
