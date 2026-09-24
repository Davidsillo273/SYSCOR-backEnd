import { config } from "../../../config.js";

// Google Maps Platform para la estimación de entregas de Panchita:
//   - Geocoding: la dirección de entrega (texto libre) a coordenadas.
//   - Routes: duración del viaje con el tráfico de este momento.
//   - Weather: si está lloviendo en el destino.
//
// Todas devuelven null si no hay clave o si Google falla: la estimación nunca
// debe tumbar la pantalla del pedido, solo pierde precisión.
const key = () => config.google?.mapsApiKey;
export const hasGoogleKey = () => !!key();

const getJson = async (url, options = {}) => {
    try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            console.error("googleMapsUtils:", response.status, JSON.stringify(data).slice(0, 300));
            return null;
        }
        return data;
    } catch (error) {
        console.error("googleMapsUtils:", error.message);
        return null;
    }
};

export const geocodeAddress = async (address) => {
    if (!key() || !address) return null;
    const params = new URLSearchParams({
        address,
        region: "sv",
        components: "country:SV",
        language: "es",
        key: key(),
    });
    const data = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    const location = data?.results?.[0]?.geometry?.location;
    return location ? { latitude: location.lat, longitude: location.lng } : null;
};

// "123s" -> 123
const seconds = (value) => Number(String(value || "0").replace("s", "")) || 0;

// { minutes, minutesWithoutTraffic, meters } del local al destino, con tráfico.
export const routeWithTraffic = async (origin, destination) => {
    if (!key() || !origin || !destination) return null;
    const data = await getJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key(),
            "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
        },
        body: JSON.stringify({
            origin: { location: { latLng: origin } },
            destination: { location: { latLng: destination } },
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE",
            languageCode: "es",
            units: "METRIC",
        }),
    });
    const route = data?.routes?.[0];
    if (!route) return null;
    return {
        minutes: Math.ceil(seconds(route.duration) / 60),
        minutesWithoutTraffic: Math.ceil(seconds(route.staticDuration || route.duration) / 60),
        meters: Number(route.distanceMeters) || 0,
    };
};

const RAIN_TYPES = ["RAIN", "LIGHT_RAIN", "HEAVY_RAIN", "RAIN_SHOWERS", "LIGHT_RAIN_SHOWERS",
    "HEAVY_RAIN_SHOWERS", "SCATTERED_SHOWERS", "THUNDERSTORM", "THUNDERSHOWER", "LIGHT_THUNDERSTORM_RAIN",
    "SCATTERED_THUNDERSTORMS", "HEAVY_THUNDERSTORM", "RAIN_PERIODICALLY_HEAVY", "CHANCE_OF_SHOWERS"];

// { raining, heavy, description, precipitationChance } en ese punto, ahora.
export const currentWeather = async ({ latitude, longitude }) => {
    if (!key()) return null;
    const params = new URLSearchParams({
        key: key(),
        "location.latitude": String(latitude),
        "location.longitude": String(longitude),
        languageCode: "es",
    });
    const data = await getJson(`https://weather.googleapis.com/v1/currentConditions:lookup?${params}`);
    if (!data?.weatherCondition) return null;
    const type = data.weatherCondition.type || "";
    return {
        raining: RAIN_TYPES.includes(type),
        heavy: /HEAVY|THUNDER/.test(type),
        description: data.weatherCondition.description?.text || null,
        precipitationChance: Number(data.precipitation?.probability?.percent) || 0,
    };
};

export default { hasGoogleKey, geocodeAddress, routeWithTraffic, currentWeather };
