import express from "express";
import saucersController from "../../controllers/menu/saucersController.js";
import upload from "../../utils/cloudinaryConfig.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /menu/saucers:
 *   get:
 *     summary: Obtiene todos los platillos
 *     description: Solo admin. Devuelve todos los platillos del menú sin importar su estado.
 *     tags: [Menú - Platillos]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: Arreglo de platillos.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 *   post:
 *     summary: Crea un nuevo platillo
 *     description: Solo admin. Crea un platillo del menú (con receta de ingredientes de inventario) e imagen opcional. Si es de categoría "Tacos", requiere cantidad.
 *     tags: [Menú - Platillos]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [name, category, price]
 *             properties:
 *               name: { type: string, example: "Taco al pastor" }
 *               category: { type: string, example: "Tacos" }
 *               price: { type: number, example: 1.25 }
 *               status: { type: string, example: "Activo" }
 *               description: { type: string, example: "Taco de cerdo marinado con piña" }
 *               subcategory: { type: string, example: "Res" }
 *               quantity: { type: string, example: "1", description: "Requerido solo si category es 'Tacos'" }
 *               recipe: { type: string, example: "[{\"inventoryId\":\"64f...\",\"quantity\":100,\"unit\":\"g\"}]", description: "JSON stringificado" }
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: "Platillo creado. Devuelve { title, message }."
 *       400:
 *         description: Datos inválidos (nombre, categoría, precio, cantidad de tacos, receta o estado).
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 */
router
  .route("/")
  .get(validateAuthCookie(["admin"]), saucersController.getAllSaucers)
  .post(validateAuthCookie(["admin"]), upload.single("image"), saucersController.insertSaucer);

  /**
   * @swagger
   * /menu/saucers/active:
   *   get:
   *     summary: Obtiene los platillos activos
   *     description: Cliente o admin. Devuelve solo los platillos con estado "Activo".
   *     tags: [Menú - Platillos]
   *     security: [{ cookieAuth: [] }]
   *     responses:
   *       200:
   *         description: Arreglo de platillos activos.
   *       401:
   *         description: No autenticado o rol no autorizado.
   *       500:
   *         description: Error interno del servidor.
   */
  router.get("/active", validateAuthCookie(["customer", "admin", "employee"]), saucersController.getActiveSaucers);

  // Ranking de platillos más vendidos
  /**
   * @swagger
   * /menu/saucers/best-sellers:
   *   get:
   *     summary: Ranking de platillos más vendidos
   *     description: Solo admin. Cuenta las unidades vendidas dentro de combos en los carritos registrados (carrito -> combo -> platillo).
   *     tags: [Menú - Platillos]
   *     security: [{ cookieAuth: [] }]
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema: { type: integer, default: 5 }
   *         description: Cantidad máxima de platillos a devolver.
   *     responses:
   *       200:
   *         description: "Arreglo de platillos con su cantidad total vendida (totalSold), ordenado descendente."
   *       401:
   *         description: No autenticado o rol no autorizado.
   *       500:
   *         description: Error interno del servidor.
   */
  router.get("/best-sellers", validateAuthCookie(["admin"]), saucersController.getBestSellers);

  // Revisa si ya existe un platillo con ese nombre (sugerencia, no bloqueo)
  /**
   * @swagger
   * /menu/saucers/check-name:
   *   get:
   *     summary: Revisa si ya existe un platillo con ese nombre
   *     description: Solo admin. Búsqueda insensible a mayúsculas; es solo una sugerencia, no bloquea la creación.
   *     tags: [Menú - Platillos]
   *     security: [{ cookieAuth: [] }]
   *     parameters:
   *       - in: query
   *         name: name
   *         required: true
   *         schema: { type: string }
   *         example: "Taco al pastor"
   *     responses:
   *       200:
   *         description: "Resultado de la búsqueda, con 'existing' igual al platillo encontrado o null."
   *       401:
   *         description: No autenticado o rol no autorizado.
   *       500:
   *         description: Error interno del servidor.
   */
  router.get("/check-name", validateAuthCookie(["admin"]), saucersController.checkName);

/**
 * @swagger
 * /menu/saucers/{id}:
 *   patch:
 *     summary: Actualiza un platillo existente
 *     description: Solo admin. Actualiza nombre, categoría, precio, estado, receta y/o imagen. Si el estado deja de ser "Activo", deshabilita en cascada los combos que dependan de este platillo.
 *     tags: [Menú - Platillos]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [name, category, price, status]
 *             properties:
 *               name: { type: string, example: "Taco al pastor" }
 *               category: { type: string, example: "Tacos" }
 *               price: { type: number, example: 1.5 }
 *               status: { type: string, example: "Activo" }
 *               description: { type: string, example: "Taco de cerdo marinado con piña" }
 *               subcategory: { type: string, example: "Res" }
 *               quantity: { type: string, example: "1" }
 *               recipe: { type: string, example: "[{\"inventoryId\":\"64f...\",\"quantity\":100,\"unit\":\"g\"}]" }
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: "Platillo actualizado. Devuelve { title, message }."
 *       400:
 *         description: Datos inválidos (nombre, categoría, precio, cantidad de tacos, receta o estado).
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 *   delete:
 *     summary: Elimina un platillo
 *     description: Solo admin. Elimina el platillo del menú y borra su imagen asociada de Cloudinary (si existe).
 *     tags: [Menú - Platillos]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Platillo eliminado correctamente.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       404:
 *         description: No se encontró el platillo solicitado.
 *       500:
 *         description: Error interno del servidor.
 */
router
  .route("/:id")
  .patch(validateAuthCookie(["admin"]), upload.single("image"), saucersController.updateSaucer)
  .delete(validateAuthCookie(["admin"]), saucersController.deleteSaucer);

export default router;
