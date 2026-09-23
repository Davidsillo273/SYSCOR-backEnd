import { Router } from "express";
import orderController from "../../controllers/orders/orderController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requirePermission } from "../../middlewares/auth/permissionMiddleware.js";

const router = Router();

/**
 * @swagger
 * /orders:
 *   post:
 *     summary: Crea un pedido (local o en línea)
 *     description: Empleado, admin o cliente. Los pedidos "local" los crea un mesero/admin (requiere mesa ocupada); los "online" los crea el propio cliente (requiere cliente, y dirección de entrega si isDelivery es true). Los items se validan contra combos/extras/bebidas reales y su precio se congela en el pedido.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderType, items]
 *             properties:
 *               orderType: { type: string, enum: [local, online], example: "local" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [itemType, itemId]
 *                   properties:
 *                     itemType: { type: string, enum: [combo, extra, drink], example: "combo" }
 *                     itemId: { type: string, example: "665f1a2b3c4d5e6f7a8b9c0d" }
 *                     quantity: { type: integer, example: 2 }
 *                     notes: { type: string, example: "Sin cebolla" }
 *               table: { type: string, description: "Requerido si orderType=local", example: "665f1a2b3c4d5e6f7a8b9c00" }
 *               localCustomerName: { type: string, description: "Solo pedidos local", example: "Cliente mesa 5" }
 *               paymentMethod: { type: string, description: "local: card|cash; online: cash|card_on_delivery|online", example: "cash" }
 *               customer: { type: string, description: "Requerido si orderType=online", example: "665f1a2b3c4d5e6f7a8b9c01" }
 *               isDelivery: { type: boolean, description: "Solo pedidos online", example: false }
 *               deliveryAddress: { type: string, description: "Requerido si isDelivery=true", example: "Col. Escalón, Calle 5, #123" }
 *               contact: { type: object, description: "Se precarga del cliente si no se envía", properties: { name: { type: string }, lastname: { type: string }, email: { type: string } } }
 *               receivedBy: { type: object, properties: { name: { type: string }, lastname: { type: string } } }
 *               scheduledFor: { type: string, format: date-time, example: "2026-08-17T18:00:00.000Z" }
 *     responses:
 *       201:
 *         description: Pedido creado (incluye table/waiter/customer populados).
 *       400:
 *         description: orderType inválido, datos obligatorios faltantes, mesa no ocupada, método de pago inválido o itemType inválido.
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       404:
 *         description: Mesa o producto no encontrado.
 *       500:
 *         description: Error interno del servidor.
 *   get:
 *     summary: Lista pedidos
 *     description: Empleado o admin. Antes de listar, marca automáticamente como "atrasado" los pedidos "preparing" con más de 1 hora sin pasar a "ready". Incluye PII del cliente vía populate.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: table
 *         schema: { type: string }
 *         description: Filtra por ID de mesa.
 *       - in: query
 *         name: waiter
 *         schema: { type: string }
 *         description: Filtra por ID de mesero.
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, preparing, ready, delivered, cancelled, atrasado] }
 *       - in: query
 *         name: orderType
 *         schema: { type: string, enum: [local, online] }
 *       - in: query
 *         name: scheduled
 *         schema: { type: string, enum: ["true"] }
 *         description: Si es "true", solo pedidos con scheduledFor definido.
 *     responses:
 *       200:
 *         description: Arreglo de pedidos con table/waiter/customer populados.
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       500:
 *         description: Error interno del servidor.
 */
router.post("/", validateAuthCookie(["employee", "admin", "customer"]), orderController.createOrder);
// Listado general de pedidos (con PII del cliente vía populate, filtrable
// por mesa/mesero/estado): es una vista de trabajo del personal, no hay
// escenario donde un cliente liste pedidos ajenos.
router.get("/", validateAuthCookie(["employee", "admin"]), orderController.getOrders);

/**
 * @swagger
 * /orders/mine:
 *   get:
 *     summary: Pedidos del cliente con sesión
 *     description: Solo cliente. Devuelve sus pedidos (en línea y locales ligados a su cuenta), del más reciente al más antiguo. El cliente se toma del token.
 *     tags: [Pedidos]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: orderType
 *         schema: { type: string, enum: [local, online] }
 *         description: Filtra por tipo de pedido.
 *     responses:
 *       200:
 *         description: Arreglo de pedidos del cliente (table populada con su número).
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       500:
 *         description: Error interno del servidor.
 */
router.get("/mine", validateAuthCookie(["customer"]), orderController.getMyOrders);

/**
 * @swagger
 * /orders/{id}/status:
 *   put:
 *     summary: Cambia el estado de un pedido
 *     description: Empleado o admin. Si el nuevo estado es "delivered" y el pedido no estaba ya entregado, genera automáticamente el registro de facturación correspondiente.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [pending, preparing, ready, delivered, cancelled, atrasado], example: "ready" }
 *     responses:
 *       200:
 *         description: Pedido actualizado (incluye table/waiter/customer populados).
 *       400:
 *         description: Estado inválido.
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       404:
 *         description: Pedido no encontrado.
 *       500:
 *         description: Error interno del servidor.
 */
router.put("/:id/status", validateAuthCookie(["employee", "admin"]), orderController.updateOrderStatus);

/**
 * @swagger
 * /orders/{id}/payment-status:
 *   put:
 *     summary: Cambia el estado de pago de un pedido
 *     description: Empleado o admin. Útil para marcar como "paid" un pago contraentrega una vez cobrado.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentStatus]
 *             properties:
 *               paymentStatus: { type: string, enum: [pending, paid], example: "paid" }
 *     responses:
 *       200:
 *         description: Pedido actualizado (incluye table/waiter/customer populados).
 *       400:
 *         description: paymentStatus inválido (debe ser 'pending' o 'paid').
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       404:
 *         description: Pedido no encontrado.
 *       500:
 *         description: Error interno del servidor.
 */
router.put("/:id/payment-status", validateAuthCookie(["employee", "admin"]), orderController.updatePaymentStatus);

/**
 * @swagger
 * /orders/{id}/cancel:
 *   put:
 *     summary: Cancela un pedido
 *     description: Empleado o admin (además requiere el permiso "orders_cancel"). No borra el pedido, solo lo marca como "cancelled". Exige la contraseña de un administrador como confirmación.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [adminPassword]
 *             properties:
 *               adminPassword: { type: string, example: "ClaveAdmin#123" }
 *     responses:
 *       200:
 *         description: Pedido cancelado (incluye table/waiter/customer populados).
 *       400:
 *         description: No se envió la contraseña de administrador.
 *       401:
 *         description: No autenticado, rol sin permiso, o contraseña de administrador incorrecta.
 *       403:
 *         description: Rol sin el permiso "orders_cancel".
 *       404:
 *         description: Pedido no encontrado.
 *       500:
 *         description: Error interno del servidor.
 */
router.put("/:id/cancel", validateAuthCookie(["employee", "admin"]), requirePermission("orders_cancel"), orderController.cancelOrder);

/**
 * @swagger
 * /orders/{id}:
 *   delete:
 *     summary: Elimina un pedido
 *     description: Solo admin. Borra el pedido permanentemente (a diferencia de cancelar, que solo cambia el estado).
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Pedido eliminado.
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       404:
 *         description: Pedido no encontrado.
 *       500:
 *         description: Error interno del servidor.
 */
router.delete("/:id", validateAuthCookie(["admin"]), orderController.deleteOrder);

/**
 * @swagger
 * /orders/waiter/dashboard:
 *   get:
 *     summary: Tablero del mesero (mesas + pedidos activos)
 *     description: Solo empleado. Devuelve todas las mesas junto con los pedidos locales activos (pending, preparing, ready, atrasado) del mesero autenticado, agrupados por mesa.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Arreglo de mesas, cada una con su lista de pedidos activos resumidos.
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       500:
 *         description: Error interno del servidor.
 */
router.get('/waiter/dashboard', validateAuthCookie(["employee"]), orderController.getWaiterDashboard);

/**
 * @swagger
 * /orders/leaderboard/customers:
 *   get:
 *     summary: Ranking de clientes destacados
 *     description: Solo admin. Basado en pedidos en línea entregados. Devuelve los clientes más activos (últimos 7 días), los que más han gastado (histórico) y los pedidos de mayor monto de la semana en curso.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "Objeto con mostActive, topSpenders y priciestWeek (cada uno con datos del cliente y montos)."
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       500:
 *         description: Error interno del servidor.
 */
router.get('/leaderboard/customers', validateAuthCookie(["admin"]), orderController.getCustomerLeaderboard);

/**
 * @swagger
 * /orders/leaderboard/employees:
 *   get:
 *     summary: Ranking de empleados destacados
 *     description: Solo admin. Basado en pedidos locales entregados, filtrable por periodo. Devuelve los meseros con más ventas.
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, enum: [day, week, month], default: week }
 *     responses:
 *       200:
 *         description: "Objeto con period y topEmployees (empleado, orderCount, totalSales)."
 *       401:
 *         description: No autenticado o rol sin permiso.
 *       500:
 *         description: Error interno del servidor.
 */
router.get('/leaderboard/employees', validateAuthCookie(["admin"]), orderController.getEmployeeLeaderboard);

export default router;
