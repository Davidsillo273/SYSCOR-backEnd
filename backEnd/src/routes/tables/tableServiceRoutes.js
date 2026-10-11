import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import tableServiceController from "../../controllers/tables/tableServiceController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";

const router = Router();

// Las solicitudes de la página de la mesa no llevan sesión: además de la
// espera entre solicitudes de cada mesa, se limita por IP para que nadie
// pruebe códigos o llene de avisos a los meseros.
const publicRequestLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
        res.status(429).json({ title: "Demasiadas solicitudes", message: "Espera unos minutos o llama a un mesero con la mano." }),
});

/**
 * @swagger
 * /table-service/requests/active:
 *   get:
 *     summary: Solicitudes de mesa que le tocan al mesero (sus mesas, las escaladas a todos y las que tomó)
 *     tags: [Servicio de mesa]
 *     security:
 *       - cookieAuth: []
 * /table-service/requests/{id}/acknowledge:
 *   patch:
 *     summary: '"Voy": el mesero toma la solicitud; a los demás se les quita el aviso'
 *     tags: [Servicio de mesa]
 * /table-service/requests/{id}/resolve:
 *   patch:
 *     summary: El mesero marca la solicitud como atendida
 *     tags: [Servicio de mesa]
 */
router.get("/requests/active", validateAuthCookie(["employee"]), tableServiceController.getActiveForWaiter);
router.patch("/requests/:id/acknowledge", validateAuthCookie(["employee"]), tableServiceController.acknowledge);
router.patch("/requests/:id/resolve", validateAuthCookie(["employee"]), tableServiceController.resolve);

/**
 * @swagger
 * /table-service/{token}:
 *   get:
 *     summary: Página de la mesa (pública, por el QR) — mesa, mesero, cuenta abierta y solicitud en curso
 *     tags: [Servicio de mesa]
 * /table-service/{token}/requests:
 *   post:
 *     summary: 'Pedir la cuenta ({ type: "bill", payMethod: "cash"|"card" }) o llamar al mesero ({ type: "waiter", reason: "order_more"|"question"|"tip"|"other" })'
 *     description: Solo con la mesa ocupada, una solicitud abierta a la vez y 45 s entre una y otra.
 *     tags: [Servicio de mesa]
 * /table-service/{token}/requests/{id}:
 *   delete:
 *     summary: El cliente cancela su solicitud (si nadie la ha tomado)
 *     tags: [Servicio de mesa]
 */
router.get("/:token", tableServiceController.getTable);
router.post("/:token/requests", publicRequestLimiter, tableServiceController.createRequest);
router.delete("/:token/requests/:id", publicRequestLimiter, tableServiceController.cancelRequest);

export default router;
