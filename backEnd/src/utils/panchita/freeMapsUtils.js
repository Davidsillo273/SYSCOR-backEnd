import { config } from "../../../config.js";

// Alternativas gratuitas (sin clave ni tarjeta) a Google Maps Platform, para
// cuando no hay GOOGLE_MAPS_API_KEY:
//   - Nominatim (OpenStreetMap): dirección -> coordenadas.
//   - OSRM (OpenStreetMap): tiempo y distancia del camino. NO considera el
//     tráfico en vivo; etaUtils le suma un margen en horas pico.
//   - Open-Meteo: si está lloviendo en el destino.
//
// Son servicios públicos con reglas de uso justo (Nominatim: máximo 1
// consulta por segundo e identificarse con un User-Agent), así que aquí se
// guardan en memoria las direcciones ya resueltas y se espacian las
// consultas. Igual que googleMapsUtils: si algo falla devuelven null, nunca
// tumban la estimación.
const USER_AGENT = `SYSCOR-TaqueriaElCorral/1.0 (${config.appUrl || "backend"})`;

const getJson = async (url) => {
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            console.error("freeMapsUtils:", response.status, url.split("?")[0]);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error("freeMapsUtils:", error.message);
        return null;
    }
};

// ── Nominatim ──
const geocodeCache = new Map();
const MAX_CACHE = 500;
let lastNominatimCall = 0;

const searchNominatim = async (query) => {
    // Máximo 1 consulta por segundo (política de uso de Nominatim).
    const wait = lastNominatimCall + 1100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastNominatimCall = Date.now();

    const params = new URLSearchParams({
        q: `${query}, El Salvador`,
        format: "jsonv2",
        countrycodes: "sv",
        limit: "1",
        "accept-language": "es",
    });
    const data = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
    const hit = Array.isArray(data) ? data[0] : null;
    return hit ? { latitude: Number(hit.lat), longitude: Number(hit.lon) } : null;
};

// OpenStreetMap no conoce pasajes, casas ni polígonos ("Col. Zacamil,
// pasaje 5, casa 12, Mejicanos"). Si la dirección completa no aparece, se
// reintenta sin esas partes ("Colonia Zacamil, Mejicanos") y, por último,
// solo con el municipio. Para estimar el camino basta con la zona.
const DETAIL_WORDS = /\b(pasaje|psje|pje|casa|#|block|blk|pol[ií]gono|senda|lote|apto|apartamento|local|n[uú]mero|no\.)\b/i;

const addressCandidates = (address) => {
    const expanded = address
        .replace(/\bcol\.?\s/gi, "Colonia ")
        .replace(/\bres\.?\s/gi, "Residencial ")
        .replace(/\bbo\.?\s/gi, "Barrio ");
    const parts = expanded.split(",").map((p) => p.trim()).filter(Boolean);
    const general = parts.filter((p) => !DETAIL_WORDS.test(p) && !/\d/.test(p));
    const candidates = [expanded, general.join(", "), general.slice(-1)[0]];
    return [...new Set(candidates.filter(Boolean))];
};

export const geocodeAddress = async (address) => {
    const key = String(address || "").trim().toLowerCase();
    if (!key) return null;
    if (geocodeCache.has(key)) return geocodeCache.get(key);

    let result = null;
    for (const candidate of addressCandidates(String(address).trim())) {
        result = await searchNominatim(candidate);
        if (result) break;
    }

    if (geocodeCache.size >= MAX_CACHE) geocodeCache.delete(geocodeCache.keys().next().value);
    geocodeCache.set(key, result);
    return result;
};

// ── OSRM ── { minutes, meters } en carro, sin tráfico.
export const route = async (origin, destination) => {
    if (!origin || !destination) return null;
    const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const data = await getJson(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`);
    const best = data?.routes?.[0];
    if (!best) return null;
    return { minutes: Math.ceil(Number(best.duration) / 60), meters: Number(best.distance) || 0 };
};

// ── Open-Meteo ── códigos WMO: 51-67 llovizna/lluvia, 80-82 chubascos, 95-99 tormenta.
const WEATHER_TEXT = {
    51: "Llovizna ligera", 53: "Llovizna", 55: "Llovizna intensa",
    61: "Lluvia ligera", 63: "Lluvia", 65: "Lluvia fuerte",
    66: "Lluvia helada", 67: "Lluvia helada fuerte",
    80: "Chubascos", 81: "Chubascos fuertes", 82: "Chubascos muy fuertes",
    95: "Tormenta", 96: "Tormenta con granizo", 99: "Tormenta fuerte con granizo",
};

export const currentWeather = async ({ latitude, longitude }) => {
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "weather_code,precipitation",
        timezone: "America/El_Salvador",
    });
    const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
    const code = Number(data?.current?.weather_code);
    if (!Number.isFinite(code)) return null;
    const precipitation = Number(data?.current?.precipitation) || 0;
    const raining = Boolean(WEATHER_TEXT[code]) || precipitation > 0.2;
    return {
        raining,
        heavy: [65, 67, 81, 82, 95, 96, 99].includes(code) || precipitation >= 4,
        description: WEATHER_TEXT[code] || (raining ? "Está lloviendo" : null),
        precipitationChance: null,
    };
};

export default { geocodeAddress, route, currentWeather };
