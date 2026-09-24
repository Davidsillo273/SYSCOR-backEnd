// Estimación predictiva de entrega de Panchita.
//
// Suma tres cosas, cada una con su explicación para el cliente:
//   1. Cocina: cuánto falta para que el pedido esté listo, según cuántos
//      pedidos van delante y el tiempo real de preparación de los últimos
//      días (sale de statusHistory: preparing -> ready).
//   2. Tráfico: la ruta del local al domicilio con el tráfico de ahora
//      (Google Routes). Sin clave de Google: la ruta real de OpenStreetMap
//      (OSRM, sin tráfico en vivo) más un margen en horas pico.
//   3. Clima: si llueve en el destino (Google Weather, o Open-Meteo sin
//      clave), el viaje se alarga.
//
// Con eso calcula a qué hora llega, una ventana (±) y el riesgo de retraso
// frente a lo que se le prometió al cliente al pedir.
import Order from "../../models/orders/orderModel.js";
import { BRANCH, localMinutesOfDay } from "../../constants/branch.js";
import google, { hasGoogleKey } from "./googleMapsUtils.js";
import free from "./freeMapsUtils.js";

// Cuántos pedidos prepara la cocina a la vez (aprox.).
const KITCHEN_PARALLEL = 3;
const DEFAULT_PREP_MINUTES = 15;
// Lo que se le promete al cliente al pedir.
const PROMISE_MINUTES = { delivery: 45, pickup: 25 };
// Una estimación se reutiliza este tiempo si el estado no cambió.
const CACHE_MS = 3 * 60 * 1000;
const ACTIVE_STATUSES = ["pending", "preparing", "atrasado"];
const QUEUE_LOOKBACK_MS = 3 * 60 * 60 * 1000;

// Promedio de preparación de los últimos 14 días, cacheado 10 minutos.
let prepCache = { value: null, at: 0 };
const averagePrepMinutes = async () => {
    if (prepCache.value && Date.now() - prepCache.at < 10 * 60 * 1000) return prepCache.value;
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const orders = await Order.find({ createdAt: { $gte: since }, "statusHistory.status": "ready" })
        .select("statusHistory")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

    const durations = orders
        .map((order) => {
            const history = order.statusHistory || [];
            const start = history.find((h) => h.status === "preparing");
            const end = history.find((h) => h.status === "ready");
            if (!start || !end) return null;
            const minutes = (new Date(end.changedAt) - new Date(start.changedAt)) / 60000;
            return minutes > 0 && minutes < 180 ? minutes : null;
        })
        .filter((m) => m !== null);

    const value = durations.length >= 3
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : DEFAULT_PREP_MINUTES;
    prepCache = { value, at: Date.now() };
    return value;
};

const lastChange = (order, status) =>
    [...(order.statusHistory || [])].reverse().find((h) => h.status === status)?.changedAt;

// Minutos que le faltan a cocina para este pedido.
const kitchenEstimate = async (order, avgPrep) => {
    const now = Date.now();
    if (order.status === "ready") {
        return { minutes: 0, ahead: 0, label: "Tu pedido ya está listo en cocina." };
    }

    if (order.status === "preparing" || order.status === "atrasado") {
        const startedAt = new Date(lastChange(order, "preparing") || order.createdAt).getTime();
        const elapsed = (now - startedAt) / 60000;
        const minutes = Math.max(Math.round(avgPrep - elapsed), 3);
        return {
            minutes,
            ahead: 0,
            label: order.status === "atrasado"
                ? "La cocina va más lenta de lo normal con tu pedido."
                : `Ya lo están preparando (suele tomar ${avgPrep} min).`,
        };
    }

    // Pendiente: espera su turno detrás de los pedidos que llegaron antes.
    // Solo cuentan los de las últimas horas: un pedido que alguien olvidó
    // cerrar hace días no está ocupando a la cocina.
    const ahead = await Order.countDocuments({
        _id: { $ne: order._id },
        status: { $in: ACTIVE_STATUSES },
        createdAt: { $lt: order.createdAt, $gte: new Date(Date.now() - QUEUE_LOOKBACK_MS) },
    });
    const queueWait = Math.ceil(ahead / KITCHEN_PARALLEL) * avgPrep;
    return {
        minutes: queueWait + avgPrep,
        ahead,
        label: ahead === 0
            ? "Eres el siguiente en cocina."
            : `Hay ${ahead} pedido${ahead === 1 ? "" : "s"} antes que el tuyo en cocina.`,
    };
};

// Horas pico en El Salvador: almuerzo y salida del trabajo.
const isRushHour = (date = new Date()) => {
    const m = localMinutesOfDay(date);
    return (m >= 11 * 60 + 30 && m <= 13 * 60 + 30) || (m >= 17 * 60 && m <= 19 * 60 + 30);
};

const haversineKm = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
};

// Minutos de viaje, con tráfico y clima. `destination` se reutiliza del caché.
const travelEstimate = async (order, cachedDestination) => {
    const origin = { latitude: BRANCH.latitude, longitude: BRANCH.longitude };
    // Con clave se usa Google; si no hay clave (o Google falla), OpenStreetMap.
    const destination =
        cachedDestination ||
        (hasGoogleKey() ? await google.geocodeAddress(order.deliveryAddress) : null) ||
        (await free.geocodeAddress(order.deliveryAddress));
    const factors = [];

    let minutes;
    let source = "estimado";
    const route = destination && hasGoogleKey() ? await google.routeWithTraffic(origin, destination) : null;
    const freeRoute = destination && !route ? await free.route(origin, destination) : null;

    if (route) {
        source = "google";
        minutes = route.minutes;
        const trafficDelay = route.minutes - route.minutesWithoutTraffic;
        factors.push({
            type: "traffic",
            minutes: route.minutes,
            label: trafficDelay >= 3
                ? `El tráfico suma unos ${trafficDelay} min al camino (${(route.meters / 1000).toFixed(1)} km).`
                : `El camino está fluido: ${(route.meters / 1000).toFixed(1)} km.`,
        });
    } else if (freeRoute) {
        // Ruta real pero sin tráfico en vivo: en horas pico se le suma un margen.
        source = "osrm";
        const rush = isRushHour();
        const extra = rush ? Math.round(freeRoute.minutes * 0.35) + 3 : 0;
        minutes = freeRoute.minutes + extra;
        const km = (freeRoute.meters / 1000).toFixed(1);
        factors.push({
            type: "traffic",
            minutes,
            label: rush
                ? `Son ${km} km y es hora pico: le sumamos unos ${extra} min por el tráfico.`
                : `Son ${km} km de camino (${freeRoute.minutes} min sin contratiempos).`,
        });
    } else {
        // Sin ruta: línea recta con factor de calles, o 20 min si ni eso.
        const km = destination ? haversineKm(origin, destination) * 1.4 : null;
        const base = km ? Math.round((km / 25) * 60) + 5 : 20;
        const rush = isRushHour();
        minutes = rush ? Math.round(base * 1.3) : base;
        factors.push({
            type: "traffic",
            minutes,
            label: rush
                ? "Es hora pico: el camino suele tardar más (estimado)."
                : "Tiempo de camino aproximado (estimado).",
        });
    }

    const point = destination || origin;
    const weather =
        (hasGoogleKey() ? await google.currentWeather(point) : null) || (await free.currentWeather(point));
    if (weather?.raining) {
        const extra = weather.heavy ? Math.round(minutes * 0.4) + 5 : Math.round(minutes * 0.2) + 3;
        minutes += extra;
        factors.push({
            type: "weather",
            minutes: extra,
            label: `${weather.description || "Está lloviendo"} en tu zona: el repartidor va con más cuidado (+${extra} min).`,
        });
    }

    return { minutes, destination, factors, source, weather };
};

// Estimación completa de un pedido en línea (usa el caché si está fresco).
export const estimateOrder = async (order, { force = false } = {}) => {
    if (!order || order.orderType !== "online") return null;
    if (["delivered", "cancelled"].includes(order.status)) return null;

    const cached = order.eta;
    if (
        !force &&
        cached?.computedAt &&
        cached.status === order.status &&
        Date.now() - new Date(cached.computedAt).getTime() < CACHE_MS
    ) {
        return cached;
    }

    const avgPrep = await averagePrepMinutes();
    const kitchen = await kitchenEstimate(order, avgPrep);
    const factors = [{ type: "kitchen", minutes: kitchen.minutes, label: kitchen.label }];

    let travel = { minutes: 0, factors: [], destination: null, source: null, weather: null };
    if (order.isDelivery) {
        travel = await travelEstimate(order, cached?.destination);
        factors.push(...travel.factors);
    }

    const totalMinutes = kitchen.minutes + travel.minutes;
    const arrivalAt = new Date(Date.now() + totalMinutes * 60000);
    const promised = new Date(
        new Date(order.createdAt).getTime() + PROMISE_MINUTES[order.isDelivery ? "delivery" : "pickup"] * 60000,
    );
    const lateBy = Math.round((arrivalAt - promised) / 60000);
    // La ventana se abre más cuando hay más incertidumbre (cola larga, lluvia).
    const spread = Math.max(3, Math.round(totalMinutes * 0.15));

    const eta = {
        status: order.status,
        computedAt: new Date(),
        minutes: totalMinutes,
        arrivalAt,
        window: [Math.max(totalMinutes - spread, 0), totalMinutes + spread],
        promisedAt: promised,
        lateBy: Math.max(lateBy, 0),
        risk: lateBy > 10 || order.status === "atrasado" ? "high" : lateBy > 0 ? "medium" : "low",
        factors,
        isDelivery: !!order.isDelivery,
        trafficSource: travel.source,
        raining: !!travel.weather?.raining,
        destination: travel.destination || null,
    };

    await Order.updateOne({ _id: order._id }, { $set: { eta } });
    return eta;
};

export default { estimateOrder };
