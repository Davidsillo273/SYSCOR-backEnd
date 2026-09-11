// Lectura del DUI salvadoreño con Gemini Vision.
//
// Se usa al invitar a un empleado: en vez de que el admin teclee el nombre,
// el número de documento, la fecha de nacimiento y la dirección (que es
// donde más se equivoca uno), se fotografían las dos caras del documento y
// el sistema propone esos campos ya llenos. El admin SIEMPRE los revisa y
// puede corregirlos antes de enviar la invitación: esto acelera la captura,
// no la reemplaza.
//
// Mismas reglas que el resto de los utils de IA del proyecto: si no hay API
// key, si Gemini tarda o responde algo inesperado, se devuelve null y el
// admin simplemente llena los campos a mano. Nunca se lanza un error que
// tumbe el flujo.
import { config } from "../../../config.js";

const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Lo que se le pide extraer. Se describe el documento con detalle porque el
// DUI tiene los datos repartidos entre las dos caras y con etiquetas
// propias ("DOMICILIO" en el reverso, no "dirección").
const EXTRACTION_PROMPT = `Eres un asistente que lee Documentos Únicos de Identidad (DUI) de El Salvador.

Te doy las fotos de un DUI: la primera imagen es el ANVERSO (frente) y la segunda el REVERSO (atrás).

Extrae EXACTAMENTE estos campos y devuélvelos como JSON:

{
  "duiNumber": "el número de DUI con el formato 00000000-0 (ocho dígitos, guion, un dígito verificador)",
  "names": "los NOMBRES de la persona, tal como aparecen",
  "lastNames": "los APELLIDOS de la persona, tal como aparecen",
  "birthDate": "fecha de nacimiento en formato AAAA-MM-DD",
  "gender": "uno de: masculino, femenino",
  "maritalStatus": "uno de: soltero, casado, divorciado, viudo, acompanado",
  "address": "el DOMICILIO / dirección de residencia completa (está en el REVERSO del documento)"
}

Reglas importantes:
- Si un campo no se alcanza a leer con seguridad, ponlo en null. NO inventes datos.
- El número de DUI SIEMPRE lleva guion antes del último dígito.
- En el DUI salvadoreño el sexo aparece como "M"/"F" o "MASCULINO"/"FEMENINO": normalízalo a "masculino" o "femenino".
- El estado familiar puede decir "SOLTERO(A)", "CASADO(A)", etc.: normalízalo a minúsculas y sin paréntesis.
- "acompanado" se escribe sin ñ, tal cual.
- Los nombres y apellidos van en su capitalización normal (ej. "Juan Carlos", no "JUAN CARLOS").
- La fecha de nacimiento en el documento suele estar como DD-MM-AAAA: conviértela a AAAA-MM-DD.
- Devuelve SOLO el JSON, sin explicaciones.`;

// Los valores que el modelo de empleado acepta. Si Gemini devuelve algo
// fuera de esta lista (por una lectura dudosa), se descarta ese campo en
// vez de guardar basura que después rompa la validación de Mongoose.
const VALID_GENDERS = ["masculino", "femenino"];
const VALID_MARITAL_STATUS = ["soltero", "casado", "divorciado", "viudo", "acompanado"];

// El DUI es 8 dígitos + guion + 1 dígito. Se acepta también sin guion (por
// si el modelo lo omite) y se normaliza al formato con guion.
const normalizeDui = (value) => {
  if (typeof value !== "string") return null;

  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9) return null;

  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
};

// Solo se aceptan fechas que existan de verdad y sean razonables para una
// persona que va a trabajar: nada de fechas futuras ni de hace 120 años.
const normalizeBirthDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const nowYear = new Date().getFullYear();
  if (year < nowYear - 100 || year > nowYear) return null;

  return value;
};

const pickFromList = (value, list) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return list.includes(normalized) ? normalized : null;
};

const cleanText = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Lee las dos caras del DUI y devuelve los campos que se pudieron extraer.
 *
 * @param {Object} images
 * @param {{mimeType: string, data: string}} images.front  Anverso en base64
 * @param {{mimeType: string, data: string}} images.back   Reverso en base64
 * @returns {Promise<Object|null>} Campos extraídos (los ilegibles vienen en
 *   null), o null si la IA no estaba disponible.
 */
export const extractDuiData = async ({ front, back }) => {
  const apiKey = config.gemini.apiKey;
  if (!apiKey) {
    console.warn("duiScanUtils: GEMINI_API_KEY no configurada, no se puede escanear el DUI.");
    return null;
  }

  if (!front?.data) {
    console.warn("duiScanUtils: falta la imagen del anverso.");
    return null;
  }

  // El reverso es opcional a nivel técnico (el anverso ya trae casi todo),
  // pero sin él no se puede leer el domicilio.
  const imageParts = [
    { inline_data: { mime_type: front.mimeType || "image/jpeg", data: front.data } },
    ...(back?.data
      ? [{ inline_data: { mime_type: back.mimeType || "image/jpeg", data: back.data } }]
      : []),
  ];

  try {
    const response = await fetch(`${GEMINI_ENDPOINT(config.gemini.model)}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: EXTRACTION_PROMPT }, ...imageParts] }],
        generationConfig: {
          responseMimeType: "application/json",
          // Temperatura baja: acá no se quiere creatividad, se quiere que
          // transcriba lo que ve en el documento.
          temperature: 0.1,
        },
      }),
      // Leer dos imágenes tarda más que un prompt de texto suelto.
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error("duiScanUtils: respuesta no OK de Gemini", response.status, errorBody);
      return null;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      console.error("duiScanUtils: Gemini no devolvió JSON válido");
      return null;
    }

    // Se normaliza TODO antes de devolverlo: lo que no pase la validación
    // queda en null y el admin lo llena a mano, que es justo para lo que
    // existe la pantalla de revisión.
    return {
      duiNumber: normalizeDui(raw.duiNumber),
      names: cleanText(raw.names),
      lastNames: cleanText(raw.lastNames),
      birthDate: normalizeBirthDate(raw.birthDate),
      gender: pickFromList(raw.gender, VALID_GENDERS),
      maritalStatus: pickFromList(raw.maritalStatus, VALID_MARITAL_STATUS),
      address: cleanText(raw.address),
    };
  } catch (error) {
    console.error("duiScanUtils.extractDuiData:", error.message);
    return null;
  }
};

export default { extractDuiData };
