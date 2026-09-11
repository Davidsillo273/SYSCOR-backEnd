// Escaneo del DUI al invitar a un empleado.
//
// Cubre dos caminos para conseguir las fotos del documento:
//
//   1. Subida directa: el admin elige los archivos (o toma la foto, si está
//      en el celular). Es el caso simple.
//
//   2. Captura desde el teléfono: el admin está en una computadora, que rara
//      vez tiene una cámara útil para fotografiar un documento. La PC crea
//      una sesión temporal y muestra su QR; el teléfono lo escanea, abre una
//      página pública mínima, sube las dos fotos, y la PC las recibe al
//      instante por Socket.IO.
//
// En ambos casos, leer el documento (OCR) es un paso aparte: primero se
// tienen las imágenes, después se extraen los datos y el admin los revisa.
import crypto from "crypto";
import DuiCaptureSession from "../../models/users/duiCaptureSessionModel.js";
import { cloudinary } from "../../utils/cloudinaryConfig.js";
import { extractDuiData } from "../../utils/users/duiScanUtils.js";
import { emitToUser, SOCKET_EVENTS } from "../../config/socket.js";
import { config } from "../../../config.js";

const duiScanController = {};

// Carpeta aparte de las fotos del menú: son documentos de identidad, y
// conviene poder distinguirlos (y aplicarles otra política) en Cloudinary.
const DUI_FOLDER = "TaqueriaElCorralSyscor/dui";

// Sube un archivo que llegó por multer en memoria. Devuelve { url, publicId }
// o null si falló, sin lanzar: quien llama decide qué responder.
const uploadToCloudinary = async (file) => {
  if (!file?.buffer) return null;

  try {
    const result = await cloudinary.uploader.upload(
      `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
      { folder: DUI_FOLDER }
    );
    return { url: result.secure_url, publicId: result.public_id };
  } catch (error) {
    console.error("duiScanController.uploadToCloudinary:", error.message);
    return null;
  }
};

/**
 * Lee las dos caras del DUI y devuelve los campos extraídos.
 *
 * Recibe las imágenes como archivos (multipart) en "front" y "back", las
 * guarda en Cloudinary y le pasa el contenido a Gemini. Devuelve tanto los
 * datos leídos como las URLs, porque la invitación va a necesitar ambas
 * cosas: los campos para el formulario y las fotos para el expediente.
 */
duiScanController.scanDui = async (req, res) => {
  try {
    const front = req.files?.front?.[0];
    const back = req.files?.back?.[0];

    if (!front) {
      return res.status(400).json({
        title: "Falta la foto del DUI",
        message: "Se necesita al menos la foto del frente del documento.",
      });
    }

    // Se sube primero: aunque la lectura falle, las fotos ya quedan
    // guardadas y el admin puede seguir llenando los campos a mano.
    const [frontUpload, backUpload] = await Promise.all([
      uploadToCloudinary(front),
      back ? uploadToCloudinary(back) : Promise.resolve(null),
    ]);

    const extracted = await extractDuiData({
      front: { mimeType: front.mimetype, data: front.buffer.toString("base64") },
      back: back ? { mimeType: back.mimetype, data: back.buffer.toString("base64") } : null,
    });

    return res.status(200).json({
      title: extracted ? "DUI escaneado" : "No se pudo leer el DUI",
      message: extracted
        ? "Revisa los datos extraídos y corrige lo que haga falta antes de continuar."
        : "No se pudieron leer los datos automáticamente. Puedes llenarlos a mano.",
      // null cuando la IA no estaba disponible o no entendió el documento:
      // el frontend lo trata como "llenar manualmente", no como un error.
      data: extracted,
      documents: {
        duiFront: frontUpload,
        duiBack: backUpload,
      },
    });
  } catch (error) {
    console.error("duiScanController.scanDui:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo procesar el documento." });
  }
};

/**
 * Abre una sesión para capturar el DUI desde el teléfono.
 *
 * Devuelve el enlace que la PC va a codificar como QR. Ese enlace lleva un
 * token de un solo uso: sirve únicamente para subir las fotos de ESTA
 * sesión, caduca a los 10 minutos y no da acceso a nada más del sistema.
 */
duiScanController.createCaptureSession = async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString("hex");

    await DuiCaptureSession.create({
      token,
      createdBy: req.user.id,
    });

    // La página de captura vive en el frontend y es pública a propósito: el
    // teléfono del admin no tiene por qué tener la sesión iniciada.
    const captureUrl = `${config.frontendUrl.split(",")[0].trim()}/capturar-dui/${token}`;

    return res.status(200).json({
      title: "Sesión de captura creada",
      token,
      captureUrl,
      // Para que la pantalla pueda mostrar una cuenta regresiva coherente
      // con el TTL real de la sesión.
      expiresInSeconds: 600,
    });
  } catch (error) {
    console.error("duiScanController.createCaptureSession:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo iniciar la captura desde el teléfono." });
  }
};

/**
 * Estado de una sesión de captura. La usa la página del teléfono al abrir,
 * para saber si el enlace sigue vigente antes de pedirle fotos a nadie.
 *
 * Pública (sin sesión): el teléfono no está autenticado. Solo revela si el
 * token existe y si ya se usó — ningún dato del admin ni del sistema.
 */
duiScanController.getCaptureSession = async (req, res) => {
  try {
    const session = await DuiCaptureSession.findOne({ token: req.params.token }).select("status createdAt");

    if (!session) {
      return res.status(404).json({
        title: "Enlace vencido",
        message: "Este enlace ya no es válido. Genera un código nuevo desde la computadora.",
      });
    }

    return res.status(200).json({
      status: session.status,
      alreadyUploaded: session.status !== "pending",
    });
  } catch (error) {
    console.error("duiScanController.getCaptureSession:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo verificar el enlace." });
  }
};

/**
 * El teléfono sube las fotos del DUI a una sesión abierta.
 *
 * Pública (sin sesión) por la misma razón: el acceso lo da el token del QR,
 * que solo permite escribir en esa sesión concreta. Al terminar, avisa a la
 * computadora del admin por Socket.IO para que la pantalla avance sola.
 */
duiScanController.uploadCapture = async (req, res) => {
  try {
    const session = await DuiCaptureSession.findOne({ token: req.params.token });

    if (!session) {
      return res.status(404).json({
        title: "Enlace vencido",
        message: "Este enlace ya no es válido. Genera un código nuevo desde la computadora.",
      });
    }

    if (session.status !== "pending") {
      return res.status(409).json({
        title: "Fotos ya enviadas",
        message: "Estas fotos ya se enviaron. Revisa la pantalla de la computadora.",
      });
    }

    const front = req.files?.front?.[0];
    const back = req.files?.back?.[0];

    if (!front) {
      return res.status(400).json({
        title: "Falta la foto del DUI",
        message: "Se necesita al menos la foto del frente del documento.",
      });
    }

    const [frontUpload, backUpload] = await Promise.all([
      uploadToCloudinary(front),
      back ? uploadToCloudinary(back) : Promise.resolve(null),
    ]);

    if (!frontUpload) {
      return res.status(500).json({ title: "Error al subir", message: "No se pudo guardar la foto. Intenta de nuevo." });
    }

    session.front = frontUpload;
    if (backUpload) session.back = backUpload;
    session.status = "uploaded";
    await session.save();

    // La PC está esperando esto: se le manda solo a quien abrió la sesión,
    // no a todo el panel.
    emitToUser(session.createdBy, SOCKET_EVENTS.DUI_CAPTURE_UPLOADED, {
      token: session.token,
      front: frontUpload,
      back: backUpload,
    });

    return res.status(200).json({
      title: "Fotos enviadas",
      message: "Listo. Puedes volver a la computadora para continuar.",
    });
  } catch (error) {
    console.error("duiScanController.uploadCapture:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudieron enviar las fotos." });
  }
};

/**
 * Lee el DUI de una sesión que ya recibió las fotos desde el teléfono.
 *
 * Se separa de uploadCapture a propósito: el teléfono solo sube, y es la
 * computadora del admin (autenticada) la que dispara la lectura y recibe
 * los datos extraídos.
 */
duiScanController.scanFromSession = async (req, res) => {
  try {
    const session = await DuiCaptureSession.findOne({ token: req.params.token });

    if (!session) {
      return res.status(404).json({ title: "Sesión no encontrada", message: "La sesión de captura ya venció." });
    }

    // Solo quien abrió la sesión puede leer sus fotos.
    if (String(session.createdBy) !== String(req.user.id)) {
      return res.status(403).json({ title: "Sesión ajena", message: "Esta sesión de captura pertenece a otro usuario." });
    }

    if (session.status === "pending" || !session.front?.url) {
      return res.status(409).json({ title: "Sin fotos todavía", message: "El teléfono aún no ha enviado las fotos." });
    }

    // Las imágenes ya están en Cloudinary: se descargan para poder
    // mandárselas a Gemini como base64 (no acepta URLs remotas).
    const toBase64 = async (url) => {
      if (!url) return null;
      const response = await fetch(url);
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        mimeType: response.headers.get("content-type") || "image/jpeg",
        data: buffer.toString("base64"),
      };
    };

    const [front, back] = await Promise.all([
      toBase64(session.front?.url),
      toBase64(session.back?.url),
    ]);

    const extracted = front ? await extractDuiData({ front, back }) : null;

    // La sesión ya cumplió su función: se marca para que el token no sirva
    // de nuevo aunque alguien lo reutilice antes de que expire el TTL.
    session.status = "consumed";
    await session.save();

    return res.status(200).json({
      title: extracted ? "DUI escaneado" : "No se pudo leer el DUI",
      message: extracted
        ? "Revisa los datos extraídos y corrige lo que haga falta antes de continuar."
        : "No se pudieron leer los datos automáticamente. Puedes llenarlos a mano.",
      data: extracted,
      documents: {
        duiFront: session.front?.url ? { url: session.front.url, publicId: session.front.publicId } : null,
        duiBack: session.back?.url ? { url: session.back.url, publicId: session.back.publicId } : null,
      },
    });
  } catch (error) {
    console.error("duiScanController.scanFromSession:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo procesar el documento." });
  }
};

/**
 * Sube los documentos sueltos del expediente (comprobante de domicilio y
 * antecedentes penales).
 *
 * Van por aquí y no por /send-invitation porque esa ruta recibe JSON: el
 * flujo es el mismo que el del DUI — primero las imágenes quedan en
 * Cloudinary, después sus URLs viajan dentro de la invitación. Ambos son
 * opcionales; si no se manda ninguno se devuelve un objeto vacío y el
 * empleado quedará marcado como expediente incompleto.
 */
duiScanController.uploadEmployeeDocuments = async (req, res) => {
  try {
    const proof = req.files?.proofOfAddress?.[0];
    const record = req.files?.criminalRecord?.[0];

    const [proofOfAddress, criminalRecord] = await Promise.all([
      uploadToCloudinary(proof),
      uploadToCloudinary(record),
    ]);

    const documents = {};
    if (proofOfAddress) documents.proofOfAddress = proofOfAddress;
    if (criminalRecord) documents.criminalRecord = criminalRecord;

    // Que un archivo llegue y no se pueda guardar sí es un error: si se
    // respondiera 200 el admin creería que el expediente quedó completo.
    if ((proof && !proofOfAddress) || (record && !criminalRecord)) {
      return res.status(502).json({
        title: "Error al guardar",
        message: "No se pudieron guardar los documentos. Intenta de nuevo.",
      });
    }

    return res.status(200).json({
      title: "Documentos guardados",
      message: "Los documentos quedaron listos para adjuntarse al expediente.",
      documents,
    });
  } catch (error) {
    console.error("duiScanController.uploadEmployeeDocuments:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudieron guardar los documentos." });
  }
};

export default duiScanController;
