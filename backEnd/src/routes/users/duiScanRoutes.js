import express from "express";
import duiScanController from "../../controllers/users/duiScanController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requirePermission } from "../../middlewares/auth/permissionMiddleware.js";
import { uploadToMemory } from "../../utils/cloudinaryConfig.js";

const router = express.Router();

// Las dos caras del documento llegan como campos separados para saber cuál
// es cuál sin depender del orden en que el navegador las mande.
const duiUpload = uploadToMemory.fields([
  { name: "front", maxCount: 1 },
  { name: "back", maxCount: 1 },
]);

// Escanear el DUI es parte de invitar a alguien, así que va detrás del mismo
// permiso que esa pantalla.
const guard = [validateAuthCookie(["admin", "employee"]), requirePermission("invite_staff")];

/**
 * @swagger
 * /users/dui-scan:
 *   post:
 *     summary: Lee un DUI y extrae los datos del empleado
 *     description: >
 *       Recibe las fotos del anverso y reverso del DUI, las guarda en
 *       Cloudinary y usa IA con visión (Groq) para extraer nombre, apellidos,
 *       número de documento, fecha de nacimiento, sexo, estado familiar y
 *       domicilio. Los campos que no se puedan leer vuelven en null para que
 *       el admin los complete a mano. Requiere el permiso "invite_staff".
 *     tags: [Usuarios - Empleados]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [front]
 *             properties:
 *               front: { type: string, format: binary, description: Anverso del DUI }
 *               back: { type: string, format: binary, description: Reverso del DUI }
 *     responses:
 *       200: { description: Datos extraídos (o null si no se pudo leer) y URLs de las fotos. }
 *       400: { description: Falta la foto del anverso. }
 *       403: { description: Sin el permiso "invite_staff". }
 */
router.route("/").post(...guard, duiUpload, duiScanController.scanDui);

/**
 * @swagger
 * /users/dui-scan/session:
 *   post:
 *     summary: Abre una sesión para capturar el DUI desde el teléfono
 *     description: >
 *       Devuelve un enlace de un solo uso (válido 10 minutos) que la
 *       computadora muestra como código QR. El teléfono que lo escanee podrá
 *       subir las fotos a esa sesión y solo a esa. Requiere "invite_staff".
 *     tags: [Usuarios - Empleados]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200: { description: Token y URL de captura. }
 *       403: { description: Sin el permiso "invite_staff". }
 */
router.route("/session").post(...guard, duiScanController.createCaptureSession);

/**
 * @swagger
 * /users/dui-scan/session/{token}/scan:
 *   post:
 *     summary: Lee el DUI de una sesión que ya recibió las fotos
 *     description: Solo el admin que abrió la sesión puede leerla. Requiere "invite_staff".
 *     tags: [Usuarios - Empleados]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Datos extraídos y URLs de las fotos. }
 *       403: { description: La sesión pertenece a otro usuario. }
 *       409: { description: El teléfono todavía no envió las fotos. }
 */
router.route("/session/:token/scan").post(...guard, duiScanController.scanFromSession);

/**
 * @swagger
 * /users/dui-scan/session/{token}:
 *   get:
 *     summary: Estado de una sesión de captura del DUI
 *     description: Solo quien abrió la sesión. La computadora la consulta cada pocos segundos como respaldo del aviso por socket; devuelve si el teléfono ya subió las fotos y sus URLs.
 *     tags: [Escaneo DUI]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ status: pending|uploaded|consumed, front, back }"
 *       403:
 *         description: La sesión es de otro usuario.
 *       404:
 *         description: La sesión venció.
 */
router.route("/session/:token").get(...guard, duiScanController.getSessionStatus);

// --- Rutas públicas: las usa el TELÉFONO, que no tiene sesión iniciada ---
//
// El control de acceso lo da el token del QR: es aleatorio, de un solo uso,
// caduca en 10 minutos y solo permite escribir en esa sesión. No expone
// ningún dato del sistema ni del admin.
/**
 * @swagger
 * /users/dui-scan/capture/{token}:
 *   get:
 *     summary: Estado de una sesión de captura (pública)
 *     description: La abre el teléfono al escanear el QR, para saber si el enlace sigue vigente.
 *     tags: [Usuarios - Empleados]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Estado de la sesión. }
 *       404: { description: Enlace vencido o inexistente. }
 *   post:
 *     summary: Sube las fotos del DUI desde el teléfono (pública)
 *     description: >
 *       Sube el anverso y reverso a la sesión indicada por el token y avisa
 *       en vivo a la computadora del admin. Solo funciona una vez por sesión.
 *     tags: [Usuarios - Empleados]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [front]
 *             properties:
 *               front: { type: string, format: binary }
 *               back: { type: string, format: binary }
 *     responses:
 *       200: { description: Fotos recibidas. }
 *       404: { description: Enlace vencido. }
 *       409: { description: Las fotos ya se habían enviado. }
 */
router.route("/capture/:token")
  .get(duiScanController.getCaptureSession)
  .post(duiUpload, duiScanController.uploadCapture);

export default router;
