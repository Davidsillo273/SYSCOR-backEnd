import { Schema, model } from "mongoose";

// Este modelo guarda UN SOLO documento con la configuración del restaurante.
// No hay un documento por usuario: son ajustes globales que el administrador
// define y que afectan a todo el sistema (dashboard, alertas, notificaciones).
const settingsSchema = new Schema({
    // Ajustes del día a día de la operación
    operation: {
        // A partir de cuántas unidades se considera "agotado"/bajo stock,
        // configurable por separado para cada sección del sistema. Inventario no
        // tiene entrada aquí: su umbral es obligatorio por insumo (ver
        // inventoryModel.lowStockAlert), así que no existe un umbral general.
        lowStockThresholds: {
            drinks: { type: Number, default: 10 },
            saucers: { type: Number, default: 10 },
            extras: { type: Number, default: 10 },
            combos: { type: Number, default: 10 }
        },
        // Si el panel debe recargar sus datos solo, sin que el usuario refresque
        autoRefreshDashboard: { type: Boolean, default: true },
        // Cada cuántos segundos se recarga el panel cuando lo anterior está activo
        dashboardRefreshSeconds: { type: Number, default: 60 }
    },
    // Interruptores para decidir qué movimientos generan notificación.
    // Si una categoría se apaga, esos eventos dejan de registrarse.
    notifications: {
        orders: { type: Boolean, default: true },
        staff: { type: Boolean, default: true },
        inventory: { type: Boolean, default: true },
        tables: { type: Boolean, default: true },
        menu: { type: Boolean, default: true },
        clients: { type: Boolean, default: true }
    },
    // Sistema de Cocina (KDS, proyecto SYSCOR-kitchenSystem del frontend).
    // Mientras está apagado, la pantalla de cocina se queda en su lobby de
    // espera y los pedidos siguen el flujo manual de siempre (la app de
    // empleados los pasa a preparación). Encendido, además, la cola de
    // cocina avanza sola (ver utils/orders/kitchenQueueUtils.js).
    kitchen: {
        enabled: { type: Boolean, default: false },
        // Minutos desde que se pidió una comanda para que su ticket se pinte
        // de amarillo (demora) y de rojo parpadeante (superó el máximo).
        warningMinutes: { type: Number, default: 10 },
        maxMinutes: { type: Number, default: 15 },
        // Último cambio del interruptor, para que el panel diga quién y cuándo
        changedAt: { type: Date, default: null },
        changedBy: { type: String, default: null }
    }
}, {
    timestamps: true,
    strict: true
});

export default model("Settings", settingsSchema);
