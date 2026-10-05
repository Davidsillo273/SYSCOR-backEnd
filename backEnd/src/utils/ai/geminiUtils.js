// Cliente mínimo para pedirle una respuesta en JSON a la IA.
//
// Ya no llama a Gemini directo: pasa por llmOrchestrator, que intenta Gemini,
// luego Groq y luego OpenRouter. El nombre del archivo y de la función se
// quedan por compatibilidad con quien los importa.
//
// Reglas de este archivo, importantes:
// - Nunca se usa para convertir unidades ni para descontar inventario: eso
//   siempre pasa por unitsUtils/deductionUtils, que son deterministas.
// - Si ningún proveedor responde (o responde algo raro): se devuelve null y
//   quien llamó sigue funcionando sin la sugerencia. Nunca se lanza un error
//   que rompa el flujo del admin.
import { generateContent } from "./llmOrchestrator.js";

// Algunos modelos de respaldo envuelven el JSON en un bloque de código
const stripCodeFence = (text) => text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

// Le pide a la IA una respuesta en JSON puro para un prompt dado.
// Devuelve el objeto ya parseado, o null si algo falló en el camino.
export const callGemini = async (prompt) => {
    const data = await generateContent(
        {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
        },
        // No dejamos que una llamada colgada bloquee la petición del admin
        { timeoutMs: 10000, json: true },
    );
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    try {
        return JSON.parse(stripCodeFence(text));
    } catch {
        console.error(`geminiUtils.callGemini: ${data.provider} no devolvió JSON válido`);
        return null;
    }
};

export default { callGemini };
