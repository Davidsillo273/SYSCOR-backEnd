// Importamos las herramientas necesarias para construir nuestro servidor
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
// Importamos todas nuestras rutas desde el archivo principal de rutas
import allRoutes from "./src/routes/allRoutes/index.js";
// Middleware que identifica al usuario sin bloquear las rutas públicas
import { attachUser } from "./src/middlewares/auth/authMiddleware.js";
// Limitador de peticiones global, para mitigar abuso/scraping de la API
import { globalRateLimiter } from "./src/middlewares/security/rateLimitMiddleware.js";
// Documento OpenAPI generado a partir de los comentarios @swagger de las rutas
import { swaggerSpec } from "./src/config/swagger.js";

// Inicializamos la aplicación de Express
const app = express();

// Render (como cualquier PaaS) pone la app detrás de un proxy inverso: la IP
// real del cliente llega en el header X-Forwarded-For, no en la conexión TCP.
// Sin esto, express-rate-limit no puede confiar en esa IP (y la rechaza con
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) y req.ip/req.secure quedan mal.
app.set("trust proxy", 1);

// --- Middlewares ---
// Los middlewares son como filtros que procesan la información antes de llegar a las rutas

// Orígenes permitidos por CORS. FRONTEND_URL admite varias URLs separadas por
// coma (ej. producción y previews de Vercel) para no limitarnos a un solo dominio.
// Se exporta porque Socket.IO (src/config/socket.js) necesita exactamente la
// misma lista: si el tiempo real permitiera otros orígenes que la API, sería
// una puerta trasera; y si permitiera menos, el panel conectaría a la API pero
// no a los sockets.
export const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    ...(process.env.FRONTEND_URL?.split(",").map((url) => url.trim()) || []),
];

// Configuramos CORS para permitir que el frontend se comunique con nuestro backend
app.use(cors({
    // Definimos qué orígenes tienen permiso para hacer peticiones
    origin: (origin, callback) => {
        // Sin header Origin (ej. Postman, curl, peticiones same-origin): se permite
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`Origen no permitido por CORS: ${origin}`));
        }
    },
    // Permitimos el envío de credenciales como las cookies
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

// Usamos cookie-parser para poder leer y manejar las cookies que nos envían los usuarios
app.use(cookieParser());
// Permitimos que nuestra aplicación pueda entender los datos que vienen en formato JSON
app.use(express.json());

// Intentamos identificar al usuario en TODAS las peticiones (sin bloquear ninguna).
// Gracias a esto las notificaciones pueden decir quién realizó cada movimiento.
app.use(attachUser);

// Limitador de peticiones global (300 cada 15 min por IP): protege la API
// completa contra abuso sin afectar el uso normal del panel. Las rutas de
// login/recuperación tienen además su propio límite, más estricto, definido
// en cada archivo de rutas de auth (ver rateLimitMiddleware.authRateLimiter).
app.use(globalRateLimiter);

// Documentación interactiva de la API (Swagger UI). Solo lectura: no exige
// sesión porque describe la API, no la ejecuta.
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Definimos la ruta base para nuestra API, por defecto usamos "/api"
const api = process.env.API_URL || "/api";

// --- Rutas ---
// Le decimos a la aplicación que utilice todas las rutas que importamos bajo la ruta base
// Todas las rutas se encuentran en: ./routes/index.js
app.use(api, allRoutes);

// Exportamos la aplicación para poder usarla en otros archivos (como en index.js)
export default app;