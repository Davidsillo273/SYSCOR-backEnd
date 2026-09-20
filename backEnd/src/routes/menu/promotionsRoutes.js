import express from "express";
import promotionsController from "../../controllers/menu/promotionsController.js";
import upload from "../../utils/cloudinaryConfig.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

/**
 * @swagger
 * /menu/promotions:
 *   get:
 *     summary: Obtiene todas las promociones
 *     description: Solo admin. Devuelve todas las promociones (activas, pausadas y expiradas). Antes de responder marca como "expirada" toda promoción activa cuya vigencia ya terminó.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: Arreglo de promociones con sus productos ya poblados.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 *   post:
 *     summary: Crea una promoción temporal
 *     description: Solo admin. Combina productos que ya existen en el menú (platillos, bebidas, combos y extras) a un precio especial y con una vigencia de máximo 3 días. El precio original (lo que costaría comprar lo mismo suelto) lo calcula el backend, no se recibe del cliente.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [name, description, items, price, endsAt]
 *             properties:
 *               name: { type: string, example: "Martes de pastor" }
 *               description: { type: string, example: "4 tacos al pastor + 1 burrito + refresco" }
 *               price: { type: number, example: 7.5 }
 *               startsAt: { type: string, format: date-time, description: "Opcional. Si no se manda, arranca en este momento." }
 *               endsAt: { type: string, format: date-time, description: "Obligatorio. Como máximo 3 días después de startsAt." }
 *               aiSuggested: { type: string, example: "false", description: "true si la combinación salió de una sugerencia de la IA" }
 *               items: { type: string, example: "[{\"itemType\":\"saucer\",\"refId\":\"64f...\",\"quantity\":4,\"removedIngredients\":[\"Cebolla\"]}]", description: "JSON stringificado" }
 *               image: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: "Promoción creada. Devuelve { title, message, newPromotion }."
 *       400:
 *         description: Datos inválidos (nombre, descripción, productos, precio o vigencia mayor a 3 días).
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 */
router
  .route("/")
  .get(validateAuthCookie(["admin"]), promotionsController.getAllPromotions)
  .post(validateAuthCookie(["admin"]), upload.single("image"), promotionsController.insertPromotion);

/**
 * @swagger
 * /menu/promotions/today:
 *   get:
 *     summary: Promociones vigentes en este momento
 *     description: Cliente, empleado o admin. Es lo que alimenta la sección "Promociones de hoy" de la app. Devuelve solo las promociones activas cuya ventana de vigencia incluye el momento actual, ordenadas por la que termina primero.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200:
 *         description: Arreglo de promociones vigentes, con isLive y discountPercent calculados.
 *       401:
 *         description: No autenticado o rol no autorizado.
 *       500:
 *         description: Error interno del servidor.
 */
router.get(
  "/today",
  validateAuthCookie(["customer", "employee", "admin"]),
  promotionsController.getTodayPromotions
);

/**
 * @swagger
 * /menu/promotions/check-name:
 *   get:
 *     summary: Verifica si ya existe una promoción con ese nombre
 *     description: Solo admin. No bloquea nada, solo avisa para que el admin decida si edita la existente o crea otra igual.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ existing: promoción | null }"
 *       401:
 *         description: No autenticado o rol no autorizado.
 */
router.get("/check-name", validateAuthCookie(["admin"]), promotionsController.checkName);

/**
 * @swagger
 * /menu/promotions/preview:
 *   post:
 *     summary: Calcula el ahorro de un armado antes de guardarlo
 *     description: Solo admin. Dado un conjunto de productos (y opcionalmente el precio promocional), devuelve cuánto costarían por separado, el ahorro y el porcentaje de descuento. Sirve para que el modal muestre el "antes/ahora" en vivo mientras el admin arma la promoción.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     itemType: { type: string, enum: [saucer, drink, combo, extra] }
 *                     refId: { type: string }
 *                     quantity: { type: number }
 *               price: { type: number, example: 7.5 }
 *     responses:
 *       200:
 *         description: "{ originalPrice, price, savings, discountPercent, maxDays }"
 *       400:
 *         description: La lista de productos está vacía o mal formada.
 *       401:
 *         description: No autenticado o rol no autorizado.
 */
router.post("/preview", validateAuthCookie(["admin"]), promotionsController.previewPricing);

/**
 * @swagger
 * /menu/promotions/{id}/status:
 *   patch:
 *     summary: Pausa o reactiva una promoción
 *     description: Solo admin. Atajo para apagar una promoción sin borrarla (ej. se acabó el producto) y volver a encenderla. No se puede reactivar una promoción cuya vigencia ya venció.
 *     tags: [Menú - Promociones]
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
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [activa, pausada, expirada] }
 *     responses:
 *       200:
 *         description: Estado actualizado.
 *       400:
 *         description: Estado inválido o la promoción ya venció.
 *       404:
 *         description: Promoción no encontrada.
 */
router.patch("/:id/status", validateAuthCookie(["admin"]), promotionsController.setStatus);

/**
 * @swagger
 * /menu/promotions/{id}:
 *   get:
 *     summary: Obtiene una promoción por su ID
 *     description: Cliente, empleado o admin. Trae la promoción con todos sus productos poblados.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: La promoción solicitada.
 *       404:
 *         description: Promoción no encontrada.
 *   put:
 *     summary: Actualiza una promoción
 *     description: Solo admin. Permite cambiar la composición, el precio, los ingredientes, la vigencia (siempre dentro del máximo de 3 días) y la imagen.
 *     tags: [Menú - Promociones]
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
 *             required: [name, description, items, price, endsAt]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               price: { type: number }
 *               startsAt: { type: string, format: date-time }
 *               endsAt: { type: string, format: date-time }
 *               status: { type: string, enum: [activa, pausada, expirada] }
 *               items: { type: string, description: "JSON stringificado" }
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Promoción actualizada.
 *       400:
 *         description: Datos inválidos.
 *       404:
 *         description: Promoción no encontrada.
 *   delete:
 *     summary: Elimina una promoción
 *     description: Solo admin. Borra la promoción y su imagen en Cloudinary. Los productos del menú que incluía no se tocan.
 *     tags: [Menú - Promociones]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Promoción eliminada.
 *       404:
 *         description: Promoción no encontrada.
 */
router
  .route("/:id")
  .get(validateAuthCookie(["customer", "employee", "admin"]), promotionsController.getPromotionById)
  .put(validateAuthCookie(["admin"]), upload.single("image"), promotionsController.updatePromotion)
  .delete(validateAuthCookie(["admin"]), promotionsController.deletePromotion);

export default router;
