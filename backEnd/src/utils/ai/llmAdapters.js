// Traductores entre el formato de Gemini y el de OpenAI (que usan Groq y
// OpenRouter). Patrón adaptador: el resto del backend SIEMPRE habla en
// formato Gemini (system_instruction, contents con parts, functionDeclarations)
// y recibe respuestas con forma de Gemini ({ candidates: [{ content }] }).
// Así ningún controlador, ni el historial guardado de Panchita, se entera de
// qué proveedor contestó.

// --- Herramientas ---

// Gemini acepta tipos en mayúsculas ("OBJECT", "STRING"); el JSON Schema de
// OpenAI los quiere en minúsculas.
const toJsonSchema = (schema) => {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(toJsonSchema);
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "type" && typeof value === "string") out.type = value.toLowerCase();
        else if (key === "nullable") continue; // no existe en JSON Schema estándar
        else out[key] = toJsonSchema(value);
    }
    return out;
};

export const toOpenAITools = (geminiTools = []) =>
    geminiTools
        .flatMap((tool) => tool.functionDeclarations || [])
        .map((declaration) => ({
            type: "function",
            function: {
                name: declaration.name,
                description: declaration.description || "",
                parameters: toJsonSchema(declaration.parameters) || { type: "object", properties: {} },
            },
        }));

// --- Mensajes ---

const textOf = (parts = []) => parts.map((part) => part.text).filter((text) => typeof text === "string").join("\n");

/**
 * Historial de Gemini -> mensajes de OpenAI.
 *
 * Gemini no numera las llamadas a funciones; OpenAI sí (tool_call_id) y exige
 * que cada respuesta de herramienta diga a qué llamada contesta. Se les da un
 * id al convertir y se emparejan por nombre, en orden.
 */
export const toOpenAIMessages = (body) => {
    const messages = [];
    const systemText = textOf(body.system_instruction?.parts);
    if (systemText) messages.push({ role: "system", content: systemText });

    const pendingIds = new Map(); // nombre de función -> ids sin respuesta
    let callCounter = 0;

    for (const content of body.contents || []) {
        const parts = content.parts || [];

        if (content.role === "model") {
            const calls = parts.filter((part) => part.functionCall);
            const text = textOf(parts);
            const message = { role: "assistant", content: text || null };
            if (calls.length) {
                message.tool_calls = calls.map(({ functionCall }) => {
                    callCounter += 1;
                    const id = `call_${callCounter}`;
                    if (!pendingIds.has(functionCall.name)) pendingIds.set(functionCall.name, []);
                    pendingIds.get(functionCall.name).push(id);
                    return { id, type: "function", function: { name: functionCall.name, arguments: JSON.stringify(functionCall.args || {}) } };
                });
            }
            if (message.content !== null || message.tool_calls) messages.push(message);
            continue;
        }

        // Turno del usuario: puede traer texto, imágenes o respuestas de herramientas
        for (const part of parts) {
            if (!part.functionResponse) continue;
            const { name, response } = part.functionResponse;
            const id = pendingIds.get(name)?.shift() || `call_${(callCounter += 1)}`;
            messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(response ?? {}) });
        }
        const text = textOf(parts);
        const hasImage = parts.some((part) => part.inline_data || part.inlineData);
        if (text || hasImage) {
            // Los modelos de respaldo no ven imágenes: se avisa en el texto para
            // que respondan con lo que sí saben en vez de inventar.
            const note = hasImage ? "\n[El usuario adjuntó una imagen, pero en este momento no se puede ver.]" : "";
            messages.push({ role: "user", content: `${text}${note}`.trim() });
        }
    }

    return messages;
};

// --- Respuesta ---

// Respuesta de OpenAI -> forma de Gemini. Las llamadas a funciones van
// primero: quien lee parts[0] (handleChatWithTools) las encuentra igual que
// con Gemini.
export const toGeminiResponse = (openAIData) => {
    const message = openAIData?.choices?.[0]?.message;
    if (!message) return null;

    const parts = [];
    for (const call of message.tool_calls || []) {
        let args = {};
        try {
            args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
            args = {};
        }
        parts.push({ functionCall: { name: call.function?.name, args } });
    }
    if (typeof message.content === "string" && message.content.trim()) parts.push({ text: message.content });
    if (parts.length === 0) return null;

    return { candidates: [{ content: { role: "model", parts } }] };
};

// Un historial que contestó otro proveedor trae llamadas a funciones sin la
// "thoughtSignature" que Gemini agrega a las suyas. Los modelos Gemini que la
// exigen aceptan este valor documentado para saltar esa validación; sin él,
// rechazarían el historial al volver a Gemini en el siguiente mensaje.
export const withThoughtSignatures = (body) => ({
    ...body,
    contents: (body.contents || []).map((content) =>
        content.role !== "model"
            ? content
            : {
                ...content,
                parts: (content.parts || []).map((part) =>
                    part.functionCall && !part.thoughtSignature
                        ? { ...part, thoughtSignature: "skip_thought_signature_validator" }
                        : part),
            }),
});

export default { toOpenAITools, toOpenAIMessages, toGeminiResponse, withThoughtSignatures };
