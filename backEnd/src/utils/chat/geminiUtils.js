// Cliente de Gemini para chats con function calling (herramientas). Vive
// aparte de src/utils/ai/geminiUtils.js (que solo hace prompts sueltos de
// "una sola pasada" para sugerencias) porque acá el flujo es distinto:
// hay historial de conversación y Gemini puede pedir ejecutar una función
// en vez de responder texto.
//
// Reglas importantes:
// - Gemini NUNCA toca la base de datos: solo devuelve qué función quiere
//   llamar y con qué argumentos. Quien llama a este archivo (el controller)
//   es responsable de ejecutar la función de verdad y de mandarle el
//   resultado de vuelta con sendFunctionResult.
// - Si ningún proveedor de IA responde (Gemini, Groq ni OpenRouter): se
//   devuelve { type: "error" } o { type: "empty" }, nunca se lanza una
//   excepción que tumbe el endpoint.
//
// Desde que existe el respaldo en cascada, las peticiones no van directo a
// Gemini: pasan por llmOrchestrator, que intenta Gemini, luego Groq y luego
// OpenRouter, y SIEMPRE devuelve la respuesta con forma de Gemini. Todo lo de
// abajo sigue igual; el nombre del archivo se queda por compatibilidad.
import { generateContent } from "../ai/llmOrchestrator.js";

// Respuesta con forma de Gemini, o null si ningún proveedor contestó. Un chat
// con function calling puede tardar un poco más que un prompt suelto.
const callGeminiRaw = (body) => generateContent(body, { timeoutMs: 15000 });

// Uso genérico: un prompt suelto sin historial ni herramientas. Devuelve el
// texto crudo (no JSON parseado) o null si algo falló.
export const askGemini = async (prompt) => {
  const data = await callGeminiRaw({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
};

// Manda el historial acumulado + el mensaje nuevo del usuario + las
// herramientas disponibles + el system prompt. Gemini puede responder con
// texto (sigue conversando/preguntando) o con una function call (ya tiene
// todo lo que necesita para ejecutar la acción).
//
// `tools` es un arreglo de function declarations (name, description, parameters).
// El `history` que devuelve siempre queda listo para la siguiente llamada:
// para una function call, hay que completarlo con sendFunctionResult antes
// de mostrarle algo más al usuario.
export const handleChatWithTools = async ({ history = [], message, tools, systemPrompt, attachments = [] }) => {
  // Las imágenes adjuntas se mandan como "inline_data" (base64) dentro de las
  // mismas `parts` del mensaje del usuario: así Gemini las "ve" en el mismo
  // turno en el que el admin las adjuntó, sin necesitar la Files API.
  const imageParts = attachments
    .filter((a) => a?.mimeType?.startsWith("image/") && a?.data)
    .map((a) => ({ inline_data: { mime_type: a.mimeType, data: a.data } }));

  const contents = [...history, { role: "user", parts: [{ text: message }, ...imageParts] }];

  const data = await callGeminiRaw({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(tools && tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
  });

  if (!data) {
    return { type: "error", history };
  }

  const modelContent = data?.candidates?.[0]?.content;
  const part = modelContent?.parts?.[0];

  if (!modelContent || !part) {
    console.error("geminiUtils(chat).handleChatWithTools: sin texto ni function call", JSON.stringify(data));
    return { type: "empty", history: contents };
  }

  // Importante: guardamos el `modelContent` TAL CUAL lo devolvió Gemini (no lo
  // reconstruimos a mano) porque trae metadata interna (thoughtSignature) que
  // Gemini exige recibir de vuelta sin modificar en el siguiente turno.
  const updatedHistory = [...contents, modelContent];

  if (part.functionCall) {
    return {
      type: "function_call",
      name: part.functionCall.name,
      args: part.functionCall.args || {},
      history: updatedHistory,
    };
  }

  if (part.text) {
    return { type: "text", text: part.text, history: updatedHistory };
  }

  return { type: "empty", history: updatedHistory };
};

// Se usa DESPUÉS de ejecutar la función real (ej. guardar en Mongo). Le manda
// a Gemini el resultado para que redacte la confirmación (o el aviso de
// error) en lenguaje natural, y devuelve el texto final + el historial ya
// completo para la siguiente vuelta del chat.
export const sendFunctionResult = async ({ history, functionName, result, systemPrompt }) => {
  const contents = [
    ...history,
    { role: "user", parts: [{ functionResponse: { name: functionName, response: result } }] },
  ];

  const data = await callGeminiRaw({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
  });

  if (!data) {
    return { type: "error", history: contents };
  }

  const modelContent = data?.candidates?.[0]?.content;
  const text = modelContent?.parts?.[0]?.text;

  if (!modelContent || !text) {
    console.error("geminiUtils(chat).sendFunctionResult: sin texto de cierre", JSON.stringify(data));
    return { type: "empty", history: contents };
  }

  return { type: "text", text, history: [...contents, modelContent] };
};

// Una vuelta "cruda" con historial y herramientas: devuelve el contenido del
// modelo tal cual (texto o una o varias function calls) o null si falló.
// La usa Panchita (app de clientes), que encadena varias herramientas en un
// mismo turno y guarda el historial en el servidor.
export const generateWithTools = async ({ contents, tools = [], systemPrompt }) => {
  const data = await callGeminiRaw({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
  });
  return data?.candidates?.[0]?.content || null;
};

export default { askGemini, handleChatWithTools, sendFunctionResult, generateWithTools };
