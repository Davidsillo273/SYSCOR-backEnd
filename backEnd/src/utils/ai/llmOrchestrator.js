// Orquestador de IA con respaldo en cascada.
//
// Antes, si Gemini se quedaba sin cuota (429), tardaba o fallaba, Panchita
// y el asistente del panel se quedaban sin responder. Ahora cada petición se
// intenta, en orden:
//
//   1. Google Gemini   (el de siempre)
//   2. Groq            (Llama 3.3 70B, latencia muy baja)
//   3. OpenRouter      (un modelo gratuito ":free")
//
// Todos reciben y devuelven el MISMO formato (el de Gemini, ver llmAdapters):
// quien llama no sabe ni le importa qué proveedor contestó.
//
// Reglas, igual que el cliente de Gemini que reemplaza:
//   - Nunca lanza un error hacia el controlador: si los tres fallan devuelve
//     null y cada pantalla responde con su propio mensaje amable.
//   - Un proveedor sin API key se salta en silencio.
//   - Un proveedor que respondió 429 se salta durante su "enfriamiento" (lo
//     que diga Retry-After, o 60 s): no tiene caso hacer esperar a cada
//     petición contra un límite que ya se sabe agotado.
import { config } from "../../../config.js";
import { toOpenAITools, toOpenAIMessages, toGeminiResponse, withThoughtSignatures } from "./llmAdapters.js";

const DEFAULT_COOLDOWN_MS = 60 * 1000;
const MAX_COOLDOWN_MS = 10 * 60 * 1000;

// Error con el código HTTP, para decidir si el proveedor se "enfría"
class ProviderError extends Error {
    constructor(message, { status = null, retryAfterMs = null } = {}) {
        super(message);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

const retryAfterMs = (response) => {
    const header = response.headers.get("retry-after");
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

const failFromResponse = async (name, response) => {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`${name} respondió ${response.status}${detail ? `: ${detail}` : ""}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response),
    });
};

// --- Proveedores ---

const gemini = {
    name: "Gemini",
    isConfigured: () => Boolean(config.gemini.apiKey),
    async generate(body, { timeoutMs }) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(withThoughtSignatures(body)),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) await failFromResponse("Gemini", response);
        const data = await response.json();
        if (!data?.candidates?.[0]?.content?.parts?.length) throw new ProviderError("Gemini respondió vacío");
        return data;
    },
};

// Groq y OpenRouter hablan el protocolo de OpenAI: misma función, otra URL.
const openAICompatible = ({ name, url, getKey, getModel, extraHeaders = {} }) => ({
    name,
    isConfigured: () => Boolean(getKey()),
    async generate(body, { timeoutMs, json }) {
        const tools = toOpenAITools(body.tools);
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getKey()}`, ...extraHeaders },
            body: JSON.stringify({
                model: getModel(),
                messages: toOpenAIMessages(body),
                temperature: body.generationConfig?.temperature ?? 0.4,
                ...(tools.length ? { tools, tool_choice: "auto" } : {}),
                // Las sugerencias del panel piden JSON puro (callGemini)
                ...(json ? { response_format: { type: "json_object" } } : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) await failFromResponse(name, response);
        const data = toGeminiResponse(await response.json());
        if (!data) throw new ProviderError(`${name} respondió vacío`);
        return data;
    },
});

const groq = openAICompatible({
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    getKey: () => config.groq.apiKey,
    getModel: () => config.groq.model,
});

const openRouter = openAICompatible({
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    getKey: () => config.openrouter.apiKey,
    getModel: () => config.openrouter.model,
    // OpenRouter pide identificar la app (aparece en su panel de uso)
    extraHeaders: { "HTTP-Referer": "https://syscor.app", "X-Title": "SYSCOR - Taquería El Corral" },
});

export const PROVIDERS = [gemini, groq, openRouter];

// --- Enfriamiento por límite de peticiones ---
const coolingUntil = new Map();

const isCooling = (provider) => (coolingUntil.get(provider.name) || 0) > Date.now();

const coolDown = (provider, error) => {
    if (error.status !== 429) return;
    const ms = Math.min(error.retryAfterMs ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
    coolingUntil.set(provider.name, Date.now() + ms);
};

/**
 * Pide una respuesta a la IA, en cascada.
 *
 * @param {object} body Petición en formato Gemini (system_instruction,
 *   contents, tools, generationConfig).
 * @param {{ timeoutMs?: number, json?: boolean, providers?: object[] }} options
 *   timeoutMs por proveedor; json = se espera JSON puro en la respuesta.
 * @returns {Promise<object|null>} Respuesta con forma de Gemini
 *   ({ candidates: [{ content }] }, más `provider` con quién contestó), o
 *   null si ninguno pudo.
 */
export const generateContent = async (body, { timeoutMs = 15000, json = false, providers = PROVIDERS } = {}) => {
    const available = providers.filter((provider) => provider.isConfigured());
    if (available.length === 0) {
        console.warn("llmOrchestrator: no hay ninguna API key de IA configurada (GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY).");
        return null;
    }

    // Si todos están enfriándose, se intenta igual con todos: el límite pudo
    // haberse liberado antes de lo previsto.
    const candidates = available.some((provider) => !isCooling(provider))
        ? available.filter((provider) => !isCooling(provider))
        : available;

    for (let index = 0; index < candidates.length; index += 1) {
        const provider = candidates[index];
        const next = candidates[index + 1];
        try {
            const data = await provider.generate(body, { timeoutMs, json });
            return { ...data, provider: provider.name };
        } catch (error) {
            coolDown(provider, error);
            const reason = error.name === "TimeoutError" ? `no respondió en ${timeoutMs / 1000} s`
                : error.status === 429 ? "llegó a su límite de peticiones (429)"
                    : error.message;
            console.warn(`llmOrchestrator: ${provider.name} falló (${reason}).${next ? ` Cambiando a ${next.name}.` : " No quedan más proveedores."}`);
        }
    }

    console.warn("llmOrchestrator: ningún proveedor de IA respondió; se usa la respuesta de respaldo.");
    return null;
};

// Solo para pruebas
export const resetCooldowns = () => coolingUntil.clear();

export default { generateContent, PROVIDERS, resetCooldowns };
