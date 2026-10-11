import { Schema, model } from "mongoose";

// Bandeja personal de cada empleado en la app de empleados: avisos que son
// para ÉL (paquete asignado al repartidor, comanda lista para su mesero...).
//
// No es la campana del panel (notificationsModel): esa es el registro de
// movimientos del negocio y se reparte por rol; esta va dirigida a una
// persona y se marca como leída por documento.
const employeeNotificationSchema = new Schema(
    {
        employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
        // Qué pasó; la app decide el icono y a qué pantalla lleva.
        // 'delivery_package' | 'order_ready'
        type: { type: String, required: true },
        title: { type: String, required: true },
        body: { type: String, required: true },
        // Lo que la app necesita para abrir lo que corresponde (ids como texto).
        data: { type: Schema.Types.Mixed, default: {} },
        readAt: { type: Date, default: null },
    },
    { timestamps: true, strict: true },
);

// Bandeja del empleado, de la más nueva a la más vieja.
employeeNotificationSchema.index({ employee: 1, createdAt: -1 });

// MongoDB las borra solas a los 7 días: son avisos del turno, no un historial.
const SEVEN_DAYS_IN_SECONDS = 60 * 60 * 24 * 7;
employeeNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: SEVEN_DAYS_IN_SECONDS });

export default model("EmployeeNotification", employeeNotificationSchema);
