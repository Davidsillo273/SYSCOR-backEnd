// Asistente de IA general de SYSCOR: a diferencia del viejo chat de
// platillos (saucerChatController.js, ahora reemplazado), este controller
// tiene una herramienta por cada función importante del sistema (ver
// assistantTools.js) y respeta el mismo modelo de permisos que el resto de
// la app — un admin puede pedirle cualquier cosa, un empleado solo lo que su
// ficha ya le permite hacer manualmente.
import { handleChatWithTools, sendFunctionResult } from "../../utils/chat/geminiUtils.js";
import { ASSISTANT_TOOLS, resolveToolPermission } from "./assistantTools.js";
import { cloudinary } from "../../utils/cloudinaryConfig.js";

const FALLBACK_REPLY = "El asistente no está disponible en este momento. Intenta de nuevo en unos minutos, o usa las pantallas del sistema directamente.";

const SYSTEM_PROMPT = `Eres Chef Panchita, la asistente de IA de SYSCOR, el sistema de gestión de
Taquería El Corral en El Salvador. Si te preguntan quién eres, te presentas
como Chef Panchita. Ayudas al administrador (o a un empleado con
permisos) a operar CUALQUIER parte del sistema: menú (platillos, bebidas,
extras, combos), inventario, mesas, pedidos, empleados, clientes y ventas.

Tienes herramientas para consultar información real (nunca inventes datos:
si te preguntan algo que requiere datos del sistema, usa la herramienta de
consulta correspondiente antes de responder) y para ejecutar acciones
concretas (crear un platillo, ajustar stock, cambiar el estado de una mesa
o de un pedido, dar de alta/baja a un empleado, cambiar precios).

Si el usuario pide un cálculo (totales, promedios, comparaciones), usa las
herramientas de consulta para traer los datos reales y haz tú el cálculo
sobre esos números, mostrando el resultado con claridad.

Si te falta un dato obligatorio para ejecutar una acción, puedes preguntarlo
en el chat de forma conversacional, PERO si el usuario ya te dio la mayoría
de los datos y solo falta uno o dos, igual llama a la función con lo que
tengas: el sistema le mostrará al usuario un formulario corto solo con lo
que falta, no hace falta que insistas preguntando todo en texto.

Si el usuario adjunta una imagen, descríbela u ordena reconocer lo que
podría representar en el sistema (ej. una foto de un platillo, una etiqueta
de un insumo dañado) y ayuda con base en lo que se ve.

No inventes nombres, precios ni cantidades que no te hayan dado o que no
hayas confirmado con una herramienta. Responde siempre en español, de forma
breve y directa (esto es un chat, no un correo).`;

const buildContextHint = (context) => {
  if (!context) return "";
  return `\n\nContexto: el usuario está viendo actualmente la pantalla de "${context}" del sistema. Si su mensaje es ambiguo, asume que se refiere a esa pantalla.`;
};

const toolDeclarations = () => Object.values(ASSISTANT_TOOLS).map((t) => t.declaration);

// Revisa si el usuario (admin o empleado) puede ejecutar esta herramienta,
// con la misma lógica que requirePermission: admin siempre pasa, empleado
// necesita tener el permiso en su propio arreglo.
const canUseTool = (req, toolName, args) => {
  const permission = resolveToolPermission(toolName, args);
  if (permission === undefined) return false; // herramienta desconocida
  if (permission === null) return true; // sin restricción específica
  if (req.user?.role === "admin") return true;
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  return permissions.includes(permission);
};

// Revisa qué campos obligatorios de la herramienta todavía no vinieron (o
// vinieron vacíos) en lo que Gemini extrajo del mensaje.
const getMissingFields = (tool, args = {}) => {
  const required = tool.declaration.parameters?.required || [];
  return required.filter((field) => args[field] === undefined || args[field] === null || args[field] === "");
};

// Sube al Cloudinary de la app las imágenes que el admin adjuntó, solo si el
// chat terminó en una acción real (para no llenar la nube de fotos de
// preguntas sueltas). Nunca lanza: si falla, simplemente no se guarda la URL.
const persistAttachments = async (attachments = []) => {
  const urls = [];
  for (const att of attachments) {
    if (!att?.mimeType?.startsWith("image/") || !att?.data) continue;
    try {
      const result = await cloudinary.uploader.upload(`data:${att.mimeType};base64,${att.data}`, {
        folder: "TaqueriaElCorralSyscor/chat",
      });
      urls.push(result.secure_url);
    } catch (error) {
      console.error("assistantChatController.persistAttachments:", error.message);
    }
  }
  return urls;
};

const assistantChatController = {};

assistantChatController.chat = async (req, res) => {
  // multipart/form-data: "message", "history" (JSON string), "context"
  // (string opcional), "files" (imágenes adjuntas, hasta 4, ver uploadToMemory)
  const message = req.body?.message;
  const context = req.body?.context || null;
  let safeHistory = [];
  try {
    safeHistory = req.body?.history ? JSON.parse(req.body.history) : [];
    if (!Array.isArray(safeHistory)) safeHistory = [];
  } catch {
    safeHistory = [];
  }

  if ((!message || !message.trim()) && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ title: "Mensaje requerido", message: "Escribe un mensaje o adjunta un archivo." });
  }

  const attachments = (req.files || [])
    .filter((f) => f.mimetype.startsWith("image/"))
    .map((f) => ({ mimeType: f.mimetype, data: f.buffer.toString("base64") }));

  const systemPrompt = SYSTEM_PROMPT + buildContextHint(context);

  try {
    const result = await handleChatWithTools({
      history: safeHistory,
      message: message?.trim() || "Adjunto una imagen.",
      tools: toolDeclarations(),
      systemPrompt,
      attachments,
    });

    if (result.type === "error") {
      return res.status(200).json({ reply: FALLBACK_REPLY, history: safeHistory, kind: "text" });
    }

    if (result.type === "text") {
      return res.status(200).json({ reply: result.text, history: result.history, kind: "text" });
    }

    if (result.type === "function_call") {
      const tool = ASSISTANT_TOOLS[result.name];

      if (!tool) {
        return res.status(200).json({
          reply: "Intenté usar una función que no existe. ¿Puedes reformular tu pedido?",
          history: result.history,
          kind: "text",
        });
      }

      if (!canUseTool(req, result.name, result.args)) {
        const followUp = await sendFunctionResult({
          history: result.history,
          functionName: result.name,
          result: { success: false, message: "El usuario no tiene permiso para esta acción. Avísale amablemente que necesita que un administrador se lo habilite." },
          systemPrompt,
        });
        return res.status(200).json({
          reply: followUp.type === "text" ? followUp.text : "No tienes permiso para hacer eso. Pídele a un administrador que te lo habilite.",
          history: followUp.history || result.history,
          kind: "text",
        });
      }

      // ¿Falta algo obligatorio? En vez de seguir preguntando en texto, se le
      // pide al frontend que dibuje un formulario corto solo con lo que falta.
      const missing = getMissingFields(tool, result.args);
      if (missing.length > 0) {
        return res.status(200).json({
          reply: null,
          history: result.history,
          kind: "form",
          form: {
            tool: result.name,
            title: tool.declaration.description,
            knownArgs: result.args,
            fields: tool.formFields.filter((f) => missing.includes(f.name) || f.required),
          },
        });
      }

      const outcome = await tool.run(result.args, req);
      const savedImageUrls = outcome.success ? await persistAttachments(attachments) : [];

      const followUp = await sendFunctionResult({
        history: result.history,
        functionName: result.name,
        result: outcome,
        systemPrompt,
      });

      return res.status(200).json({
        reply: followUp.type === "text" ? followUp.text : (outcome.success ? "Listo, hecho." : outcome.message || "No se pudo completar la acción."),
        history: followUp.history || result.history,
        kind: "action",
        actionSuccess: outcome.success,
        attachedImageUrls: savedImageUrls,
      });
    }

    return res.status(200).json({
      reply: "No entendí bien tu mensaje, ¿podrías reformularlo?",
      history: result.history || safeHistory,
      kind: "text",
    });
  } catch (error) {
    console.error("assistantChatController.chat:", error);
    return res.status(200).json({ reply: FALLBACK_REPLY, history: safeHistory, kind: "text" });
  }
};

// El frontend llama esto cuando el admin llena el formulario que se generó
// por falta de datos: se completa `knownArgs` con lo nuevo y se ejecuta la
// herramienta directamente, sin volver a pasar por Gemini para interpretar
// texto (más confiable que esperar que Gemini re-extraiga los mismos datos).
assistantChatController.submitForm = async (req, res) => {
  const { tool: toolName, args, history } = req.body || {};
  const safeHistory = Array.isArray(history) ? history : [];
  const tool = ASSISTANT_TOOLS[toolName];

  if (!tool) {
    return res.status(400).json({ title: "Herramienta inválida", message: "Esta acción ya no está disponible." });
  }

  if (!canUseTool(req, toolName, args)) {
    return res.status(403).json({ title: "Permiso insuficiente", message: "No tienes permiso para esta acción." });
  }

  const missing = getMissingFields(tool, args || {});
  if (missing.length > 0) {
    return res.status(400).json({ title: "Faltan datos", message: `Falta completar: ${missing.join(", ")}` });
  }

  try {
    const outcome = await tool.run(args, req);
    const systemPrompt = SYSTEM_PROMPT;
    const followUp = await sendFunctionResult({
      history: safeHistory,
      functionName: toolName,
      result: outcome,
      systemPrompt,
    });

    return res.status(200).json({
      reply: followUp.type === "text" ? followUp.text : (outcome.success ? "Listo, hecho." : outcome.message || "No se pudo completar la acción."),
      history: followUp.history || safeHistory,
      kind: "action",
      actionSuccess: outcome.success,
    });
  } catch (error) {
    console.error("assistantChatController.submitForm:", error);
    return res.status(200).json({ reply: FALLBACK_REPLY, history: safeHistory, kind: "text" });
  }
};

export default assistantChatController;
