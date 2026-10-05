// Importamos la aplicación principal y la conexión a la base de datos
import http from "http";
import app, { allowedOrigins } from "./app.js";
import "./database.js";
import { initSocket } from "./src/config/socket.js";
import { syncReservations } from "./src/utils/tables/reservationUtils.js";
import { releaseExpiredHolds } from "./src/utils/orders/orderHoldUtils.js";
import { requestKitchenSync } from "./src/utils/orders/kitchenQueueUtils.js";
import { migrateRetiredEmployeeTypes } from "./src/utils/users/employeeTypeMigration.js";

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

    // Los puestos de empleado "gerente", "limpieza" y "otro" ya no existen:
    // quien los tuviera pasa a un puesto vigente.
    migrateRetiredEmployeeTypes().catch((error) => console.error("migrateRetiredEmployeeTypes:", error));

    // Reservas de mesa de la app: apartar la mesa antes de la hora y soltarla
    // si el cliente no llegó. También se revisa al consultar mesas o reservas,
    // por si el servidor estuvo dormido.
    setInterval(syncReservations, 60 * 1000);
    // Pedidos "En espera" cuyo tiempo terminó: vuelven solos a la cola.
    setInterval(() => releaseExpiredHolds().catch((error) => console.error("releaseExpiredHolds:", error)), 30 * 1000);
    // Sistema de Cocina: los cambios de pedidos ya revisan la cola solos, pero
    // un pedido programado que llega a su hora no cambia nada en la base.
    // Esta revisión periódica lo mete a cocina si está libre.
    setInterval(requestKitchenSync, 30 * 1000);
    // Mostramos un mensaje en la consola para confirmar que el servidor está funcionando
    console.log(`Server on port ${PORT}`);
}

// Ejecutamos la función principal para arrancar todo
main();
