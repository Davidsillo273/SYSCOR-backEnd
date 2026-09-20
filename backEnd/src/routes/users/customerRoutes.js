import express from "express";
import customerController from "../../controllers/users/customerController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requirePermission } from "../../middlewares/auth/permissionMiddleware.js";
import ownsResourceOrIsAdmin from "../../middlewares/auth/ownershipMiddleware.js";
import upload from "../../utils/cloudinaryConfig.js";

const router = express.Router();

// Listar todos los clientes (PII): admin siempre, o un empleado con el
// permiso de pantalla "clients" asignado explícitamente.
/**
 * @swagger
 * /users/customers:
 *   get:
 *     summary: Lista los clientes registrados
 *     description: Solo admin. Soporta filtros de búsqueda vía query string (mismos criterios que crudUtils.searchDocuments).
 *     tags: [Usuarios - Clientes]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Arreglo de clientes.
 *       401:
 *         description: No autenticado o rol distinto de admin.
 *       500:
 *         description: Error interno del servidor.
 */
router.route("/").get(validateAuthCookie(["admin", "employee"]), requirePermission("clients"), customerController.getCustomers);
router
    .route("/:id")
    // El propio cliente puede editar su perfil, o un admin editar el de cualquiera
    /**
     * @swagger
     * /users/customers/{id}:
     *   patch:
     *     summary: Actualiza los datos de un cliente
     *     description: Admin (cualquier cliente) o el propio cliente (solo su perfil, verificado por ownership). Permite actualizar nombre y/o apellido.
     *     tags: [Usuarios - Clientes]
     *     security:
     *       - cookieAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *         description: ID del cliente a actualizar.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name: { type: string, example: "Juan" }
     *               lastname: { type: string, example: "Pérez" }
     *     responses:
     *       200:
     *         description: Cliente actualizado; devuelve el documento actualizado (sin password).
     *       400:
     *         description: Nombre o apellido inválidos.
     *       401:
     *         description: No autenticado.
     *       403:
     *         description: Un cliente intentó modificar el perfil de otra persona.
     *       404:
     *         description: No se encontró el cliente solicitado.
     *       500:
     *         description: Error interno del servidor.
     */
    .patch(validateAuthCookie(["admin", "customer"]), ownsResourceOrIsAdmin, upload.single("image"), customerController.updateCustomer)

// Historial de pedidos del cliente, para su ficha en el panel. Mismo permiso
// que ver la lista de clientes: quien puede ver la pantalla ve el detalle.
/**
 * @swagger
 * /users/customers/{id}/orders:
 *   get:
 *     summary: Historial de pedidos de un cliente
 *     description: Últimos 50 pedidos en línea del cliente, más un resumen (total gastado, pedidos entregados). Requiere el permiso "clients".
 *     tags: [Usuarios - Clientes]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Historial y resumen del cliente.
 *       403:
 *         description: Sin el permiso "clients".
 */
router.route("/:id/orders").get(
    validateAuthCookie(["admin", "employee"]),
    requirePermission("clients"),
    customerController.getCustomerOrders
);

// Dar de baja/alta a un cliente. Va detrás de su propio permiso de acción
// ("clients_manage_status"), igual que pasa con los empleados: ver la
// pantalla de clientes no debería bastar para cerrarle el acceso a alguien.
/**
 * @swagger
 * /users/customers/{id}/status:
 *   patch:
 *     summary: Activa o desactiva la cuenta de un cliente
 *     description: >
 *       Un cliente desactivado no puede iniciar sesión, pero conserva su
 *       historial de pedidos. Requiere el permiso "clients_manage_status".
 *     tags: [Usuarios - Clientes]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, example: "inactive" }
 *     responses:
 *       200:
 *         description: Estado actualizado.
 *       403:
 *         description: Sin el permiso "clients_manage_status".
 *       404:
 *         description: Cliente no encontrado.
 */
router.route("/:id/status").patch(
    validateAuthCookie(["admin", "employee"]),
    requirePermission("clients_manage_status"),
    customerController.toggleStatus
);

// Libreta de direcciones del cliente. Es su propio dato, así que la regla es
// la misma que para editar su perfil: el dueño de la cuenta o un admin
// (ownsResourceOrIsAdmin). La app móvil las usa para el delivery y para
// mostrar la predeterminada en el encabezado del menú.
/**
 * @swagger
 * /users/customers/{id}/addresses:
 *   get:
 *     summary: Lista las direcciones del cliente
 *     description: El propio cliente o un admin. Devuelve la libreta completa y cuál es la predeterminada.
 *     tags: [Usuarios - Clientes]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ addresses, defaultAddress }"
 *       403:
 *         description: Se intentó ver la libreta de otra persona.
 *       404:
 *         description: Cliente no encontrado.
 *   post:
 *     summary: Agrega una dirección
 *     description: El propio cliente o un admin. La primera dirección que se agrega queda como predeterminada automáticamente.
 *     tags: [Usuarios - Clientes]
 *     security: [{ cookieAuth: [] }]
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
 *             required: [tag, details]
 *             properties:
 *               tag: { type: string, example: "Casa" }
 *               details: { type: string, example: "Col. Zacamil, pasaje 5, casa 12" }
 *               isDefault: { type: boolean, example: true }
 *     responses:
 *       200:
 *         description: Libreta actualizada.
 *       400:
 *         description: Nombre o dirección inválidos.
 */
router
    .route("/:id/addresses")
    .get(validateAuthCookie(["admin", "customer"]), ownsResourceOrIsAdmin, customerController.getAddresses)
    .post(validateAuthCookie(["admin", "customer"]), ownsResourceOrIsAdmin, customerController.addAddress);

/**
 * @swagger
 * /users/customers/{id}/addresses/{index}:
 *   put:
 *     summary: Edita una dirección
 *     description: El propio cliente o un admin. Las direcciones se identifican por su posición en la lista, tal como vienen en el GET.
 *     tags: [Usuarios - Clientes]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: index
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tag, details]
 *             properties:
 *               tag: { type: string }
 *               details: { type: string }
 *               isDefault: { type: boolean }
 *     responses:
 *       200:
 *         description: Libreta actualizada.
 *       404:
 *         description: La dirección ya no existe.
 *   delete:
 *     summary: Elimina una dirección
 *     description: El propio cliente o un admin. Si se borra la predeterminada, la primera de las que quedan toma su lugar.
 *     tags: [Usuarios - Clientes]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: index
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Libreta actualizada.
 *       404:
 *         description: La dirección ya no existe.
 */
router
    .route("/:id/addresses/:index")
    .put(validateAuthCookie(["admin", "customer"]), ownsResourceOrIsAdmin, customerController.updateAddress)
    .delete(validateAuthCookie(["admin", "customer"]), ownsResourceOrIsAdmin, customerController.deleteAddress);

/**
 * @swagger
 * /users/customers/{id}/addresses/{index}/default:
 *   patch:
 *     summary: Marca una dirección como predeterminada
 *     description: El propio cliente o un admin. Deja esa como la de entrega y le quita la marca a las demás.
 *     tags: [Usuarios - Clientes]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: index
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Libreta actualizada.
 *       404:
 *         description: La dirección ya no existe.
 */
router
    .route("/:id/addresses/:index/default")
    .patch(validateAuthCookie(["admin", "customer"]), ownsResourceOrIsAdmin, customerController.setDefaultAddress);

export default router;
