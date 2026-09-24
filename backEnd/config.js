// Cargamos las variables de entorno desde el archivo .env para poder usarlas aquí abajo
import dotenv from "dotenv"

// Leemos el archivo .env y lo volcamos en process.env
dotenv.config();

// Este objeto junta toda la configuración sensible del sistema (claves, URLs,
// credenciales) en un solo lugar, para no tener variables de entorno sueltas
// por todo el código
export const config = {
    // Datos para conectarnos a la base de datos
    db: {
        uri: process.env.DB_URI
    },
    // Clave secreta con la que firmamos y verificamos las sesiones de los usuarios
    jwt: {
        secret: process.env.JWT_Secret_key
    },
    // Clave para cifrar el número de las tarjetas que guardan los clientes
    // (ver cardCryptoUtils). Si falta se usa la de JWT, solo para desarrollo
    cards: {
        encryptionKey: process.env.CARD_ENCRYPTION_KEY
    },
    // Credenciales de Mailjet, el servicio con el que el sistema manda los
    // emails (códigos, invitaciones, etc.) vía su API HTTP. Reemplaza a
    // Nodemailer porque Render bloquea los puertos SMTP en producción
    mailjet: {
        apiKey: process.env.API_KEY_MAILJET,
        secretKey: process.env.API_SECRET_MAILJET,
        fromEmail: process.env.MAILJET_FROM_EMAIL,
        fromName: process.env.MAILJET_FROM_NAME
    },
    // Credenciales de Cloudinary, el servicio donde guardamos las imágenes que suben los admins
    cloudinary: {
        cloudinaryName: process.env.CLOUDINARY_CLOUD_NAME,
        cloudinaryApiKey: process.env.CLOUDINARY_API_KEY,
        cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET
    },
    // Dirección pública de nuestro propio backend (sin /api), ej.
    // https://syscor-mll9.onrender.com. Wompi redirige y manda el webhook de
    // los pagos aquí, así que en producción es obligatoria
    appUrl: process.env.APP_URL,
    // Credenciales para conectarnos con Wompi, la pasarela que procesa los pagos
    wompi: {
        grantType: process.env.GRANT_TYPE,
        audience: process.env.AUDIENCE,
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET
    },
    // Dirección del frontend. La usamos para permitirle hacer peticiones al
    // backend sin que el navegador las bloquee (CORS). Si no está definida,
    // asumimos que estamos en desarrollo local
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
    // Credenciales para pedirle ayuda a la IA (sugerir recetas, proyectar
    // cuándo se va a agotar un insumo). Si falta la clave, esas funciones
    // simplemente no responden nada: nunca frenan el resto del sistema
    // Clave de Google Maps Platform para que Panchita estime la entrega de
    // los pedidos (Geocoding, Routes con tráfico y Weather). Sin clave, la
    // estimación usa distancia aproximada y horas pico, y no considera el clima
    google: {
        mapsApiKey: process.env.GOOGLE_MAPS_API_KEY
    },
    gemini: {
        apiKey: process.env.GEMINI_API_KEY,
        // "gemini-2.5-flash-lite" ya no está disponible para proyectos nuevos
        // (Google la retiró y devuelve error 404). "gemini-flash-lite-latest"
        // es el alias que Google mantiene apuntando siempre al modelo
        // flash-lite vigente, así no se vuelve a romper cuando cambien de versión
        model: process.env.GEMINI_MODEL || "gemini-flash-lite-latest"
    }
}
