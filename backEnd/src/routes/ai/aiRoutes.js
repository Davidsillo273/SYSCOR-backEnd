import express from "express";
import aiController from "../../controllers/ai/aiController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = express.Router();

// Ambas asistencias de IA son solo para el administrador
/**
 * @swagger
 * /ai/suggest-recipe:
 *   post:
 *     summary: Sugiere una receta estándar para un insumo compuesto nuevo
 *     description: Solo admin. La IA (Gemini) propone ingredientes y cantidades a partir del nombre, la cantidad deseada y la unidad; es solo un punto de partida editable, nunca se guarda automáticamente.
 *     tags: [IA]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, quantity, unit]
 *             properties:
 *               name: { type: string, example: "Salsa roja" }
 *               quantity: { type: number, example: 5 }
 *               unit: { type: string, example: "litro" }
 *     responses:
 *       200:
 *         description: "{ ingredients: [{ name, quantity, unit, inventoryId }] }. Devuelve un arreglo vacío si la IA no respondió o falló (no se considera error)."
 *       400:
 *         description: Falta nombre, cantidad o unidad.
 *       401:
 *         description: No autenticado o rol distinto de admin.
 */
router.post("/suggest-recipe", validateAuthCookie(["admin"]), aiController.suggestRecipe);

/**
 * @swagger
 * /ai/stock-forecast:
 *   get:
 *     summary: Proyecta qué insumos se agotarán pronto
 *     description: Solo admin. Combina el inventario actual con los pedidos de los últimos 7 días y le pide a la IA (Gemini) una proyección a 3 días. El resultado se cachea en memoria por el resto del día (usar force=true para forzar recalcular).
 *     tags: [IA]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: force
 *         required: false
 *         schema: { type: string, enum: ["true", "false"] }
 *         description: Si es "true", ignora la caché del día y vuelve a consultar la IA.
 *     responses:
 *       200:
 *         description: "{ alerts: [{ ingredient, currentStock, unit, projectedDaysLeft, recommendation }] }. Devuelve un arreglo vacío si la IA falla (no se considera error)."
 *       401:
 *         description: No autenticado o rol distinto de admin.
 */
router.get("/stock-forecast", validateAuthCookie(["admin"]), aiController.stockForecast);

/**
 * @swagger
 * /ai/suggest-promotion:
 *   post:
 *     summary: Sugiere promociones del día combinando productos del menú
 *     description: Solo admin. La IA (Gemini) recibe el catálogo activo (platillos, bebidas y combos) y propone combinaciones con nombre, descripción, precio promocional y duración. Nunca inventa productos, ya que cualquier ID que devuelva y que no exista en el catálogo se descarta, y el precio suelto se recalcula en el backend. Es solo un punto de partida editable, no se guarda nada.
 *     tags: [IA]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               idea: { type: string, example: "algo para levantar las ventas de los martes" }
 *               maxSuggestions: { type: number, example: 3, description: "Entre 1 y 5. Por defecto 3." }
 *     responses:
 *       200:
 *         description: "{ suggestions: [{ name, description, items, originalPrice, price, discountPercent, durationDays }], maxDays }. Devuelve un arreglo vacío si la IA no respondió o si no hay productos activos (no se considera error)."
 *       401:
 *         description: No autenticado o rol distinto de admin.
 */
router.post("/suggest-promotion", validateAuthCookie(["admin"]), aiController.suggestPromotion);

export default router;
