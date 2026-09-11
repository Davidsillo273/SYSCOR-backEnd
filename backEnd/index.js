// Importamos la aplicación principal y la conexión a la base de datos
import http from "http";
import app, { allowedOrigins } from "./app.js";
import "./database.js";
import { initSocket } from "./src/config/socket.js";

// Render asigna el puerto por variable de entorno y espera que la app escuche
// ahí; en local seguimos usando el 4000 de siempre.
const PORT = process.env.PORT || 4000;

// Esta función se encarga de iniciar el servidor
async function main() {
    // Antes usábamos app.listen(), que crea el servidor HTTP por dentro y no
    // nos lo entrega. Socket.IO necesita ese servidor para colgarse de él y
    // atender las conexiones de tiempo real en el MISMO puerto que la API
    // (Render expone un solo puerto por servicio), así que ahora lo creamos
    // nosotros y se lo pasamos a ambos.
    const server = http.createServer(app);

    // Tiempo real: notificaciones, mesas y comandas se avisan solas, sin que
    // el panel tenga que preguntar cada 30 segundos (ver src/config/socket.js)
    initSocket(server, allowedOrigins);

    server.listen(PORT);
    // Mostramos un mensaje en la consola para confirmar que el servidor está funcionando
    console.log(`Server on port ${PORT}`);
}

// Ejecutamos la función principal para arrancar todo
main();
