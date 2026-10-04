import express from "express";
import tablesController from "../../controllers/tables/tablesController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /tables:
 *   get:
 *     summary: Obtiene todas las mesas
 *     description: Empleado o admin. Devuelve todas las mesas registradas en el restaurante.
 *     tags: [Mesas]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: Arreglo de mesas.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 *   post:
 *     summary: Crea una nueva mesa
 *     description: Empleado o admin. Registra una nueva mesa en el sistema.
 *     tags: [Mesas]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [number]
 *             properties:
 *               number: { type: number, example: 5 }
 *               status: { type: string, example: "libre", description: "'libre', 'ocupada' o 'reservada'" }
 *     responses:
 *       201:
 *         description: Mesa agregada correctamente.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 */
router
  .route("/")
  // Consistente con el resto del archivo: meseros/cajeros también necesitan
  // ver el estado de las mesas para poder atenderlas, no solo el admin.
  .get(validateAuthCookie(["employee", "admin"]), tablesController.getTables)
  .post(validateAuthCookie(["employee", "admin"]), tablesController.insertTable);

/**
 * @swagger
 * /tables/status-all:
 *   put:
 *     summary: Actualiza el estado de todas las mesas a la vez
 *     description: Empleado o admin. Pone el mismo estado a todas las mesas (por ejemplo, al abrir el local). Si el nuevo estado es "libre", cancela los pedidos activos (pending/preparing/ready) de las mesas que cambiaron de estado.
 *     tags: [Mesas]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, example: "libre", description: "'libre', 'ocupada' o 'reservada'" }
 *     responses:
 *       200:
 *         description: "Mesas actualizadas. Devuelve title, message y data.updated con la cantidad de mesas modificadas."
 *       400:
 *         description: Estado no válido.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 */
router.put("/status-all", validateAuthCookie(["employee", "admin"]), tablesController.bulkUpdateStatus);

/**
 * @swagger
 * /tables/{id}:
 *   put:
 *     summary: Actualiza una mesa
 *     description: Empleado o admin. Actualiza el número y/o estado de una mesa. Si pasa a "libre", cancela los pedidos activos (pending/preparing/ready) de esa mesa.
 *     tags: [Mesas]
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
 *             properties:
 *               number: { type: number, example: 5 }
 *               status: { type: string, example: "ocupada", description: "'libre', 'ocupada' o 'reservada'" }
 *     responses:
 *       200:
 *         description: "Mesa actualizada. Devuelve title, message y data con la mesa actualizada."
 *       400:
 *         description: Estado no válido.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       404:
 *         description: Mesa no encontrada.
 *       500:
 *         description: Error interno del servidor.
 *   delete:
 *     summary: Elimina una mesa
 *     description: Solo admin. Elimina una mesa existente por su ID.
 *     tags: [Mesas]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Mesa eliminada correctamente.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       404:
 *         description: No se encontró la mesa solicitada.
 *       500:
 *         description: Error interno del servidor.
 */
router
  .route("/:id")
  .put(validateAuthCookie(["employee", "admin"]), tablesController.updateTable)
  .delete(validateAuthCookie(["admin"]), tablesController.deleteTable);

export default router;
