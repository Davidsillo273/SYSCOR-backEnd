import express from "express";
import reservationController from "../../controllers/tables/reservationController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

// Reservas de mesa de la app de clientes (ver reservationController).
const router = express.Router();

/**
 * @swagger
 * /reservations/availability:
 *   get:
 *     summary: Revisa si hay mesa para una hora
 *     description: Cliente. Antes de pagar un pedido "Comer en el local", indica si hay alguna mesa libre donde quepan las personas a esa hora.
 *     tags: [Reservas]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: reservedFor
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: partySize
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: "available, floors (plantas con lugar), maxCapacity y message."
 *       400:
 *         description: Hora o número de personas no válidos.
 */
router.get("/availability", validateAuthCookie(["customer"]), reservationController.getAvailability);

/**
 * @swagger
 * /reservations/check-in:
 *   post:
 *     summary: Marca la llegada del cliente
 *     description: Cliente. Recibe el texto del QR de la mesa. Si es la mesa de su reserva y es su hora, la mesa pasa a "ocupada".
 *     tags: [Reservas]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, example: "syscor-mesa:Ab12Cd34Ef56" }
 *     responses:
 *       200:
 *         description: Reserva con estado checked_in.
 *       400:
 *         description: Código no válido, no es su mesa o no es su hora.
 *       409:
 *         description: La mesa sigue ocupada.
 */
router.post("/check-in", validateAuthCookie(["customer"]), reservationController.checkIn);

/**
 * @swagger
 * /reservations/by-order/{orderId}:
 *   get:
 *     summary: Reserva de un pedido
 *     tags: [Reservas]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: La reserva.
 *       404:
 *         description: El pedido no tiene reserva.
 */
router.get("/by-order/:orderId", validateAuthCookie(["customer"]), reservationController.getByOrder);

/**
 * @swagger
 * /reservations/{id}/options:
 *   get:
 *     summary: Mesas para elegir en el croquis
 *     description: Cliente. Todas las mesas por planta con su posición en el croquis, cuáles se pueden elegir y la que sugiere Panchita.
 *     tags: [Reservas]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "reservation, floors[] y floorsWithRoom."
 */
router.get("/:id/options", validateAuthCookie(["customer"]), reservationController.getOptions);

/**
 * @swagger
 * /reservations/{id}/assign:
 *   post:
 *     summary: Asigna la mesa a la reserva
 *     tags: [Reservas]
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
 *             required: [tableId]
 *             properties:
 *               tableId: { type: string }
 *     responses:
 *       200:
 *         description: Reserva con su mesa.
 *       409:
 *         description: Otra persona tomó la mesa.
 */
router.post("/:id/assign", validateAuthCookie(["customer"]), reservationController.assignTable);

export default router;
