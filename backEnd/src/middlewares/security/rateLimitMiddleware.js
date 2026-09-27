// Limitadores de velocidad (rate limiting) para proteger la API contra abuso
// y ataques de fuerza bruta. Usan express-rate-limit, que cuenta peticiones
// por IP dentro de una ventana de tiempo y responde 429 cuando se supera el
// límite, sin necesidad de tocar la lógica de cada controller.
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Formato de respuesta consistente con el resto del sistema ({title, message}),
// igual al que usan los controllers en sus errores.
const rateLimitResponse = (title, message) => (req, res) => {
  res.status(429).json({ title, message });
};

// Limitador global: se aplica a TODAS las rutas de la API.
//
// Con sesión iniciada se cuenta por usuario, no por IP: en el local todos los
// dispositivos (cajas, tablets de meseros, la computadora del admin) salen a
// internet con la MISMA IP pública, así que contar por IP hacía que el uso
// normal de todo el personal se sumara en un solo cupo y el panel terminaba
// respondiendo 429 al navegar entre pantallas. attachUser corre antes que
// este middleware (ver app.js), por eso req.user ya está disponible aquí.
//
// Sin sesión se sigue contando por IP con el límite bajo de siempre, que es
// lo que frena el scraping y los loops descontrolados.
const AUTHENTICATED_LIMIT = 2000; // por usuario cada 15 min
const ANONYMOUS_LIMIT = 300; // por IP cada 15 min

export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: (req) => (req.user?.id ? AUTHENTICATED_LIMIT : ANONYMOUS_LIMIT),
  // ipKeyGenerator agrupa las IPv6 por subred; sin él, express-rate-limit v8
  // rechaza un keyGenerator propio que use req.ip directamente.
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
  standardHeaders: true, // manda los headers RateLimit-* estándar
  legacyHeaders: false, // no manda los headers X-RateLimit-* viejos
  handler: rateLimitResponse(
    "Demasiadas solicitudes",
    "Has alcanzado el límite de solicitudes. Intenta de nuevo en unos minutos."
  ),
});

// Limitador estricto para endpoints de autenticación (login de admin,
// empleado y cliente, y recuperación de contraseña): un límite mucho más
// bajo (10 intentos cada 15 minutos por IP) para dificultar ataques de
// fuerza bruta contra contraseñas, sin bloquear a un usuario real que solo
// se equivocó un par de veces.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitResponse(
    "Demasiados intentos",
    "Demasiados intentos de inicio de sesión. Por seguridad, intenta de nuevo en unos minutos."
  ),
});
