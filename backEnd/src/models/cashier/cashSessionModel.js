import { Schema, model } from "mongoose";

// TURNO DE CAJA: lo abre un administrador desde el panel (elige al cajero y
// cuenta el fondo inicial) y lo cierra el cajero al hacer el arqueo (o el
// administrador, si hace falta). Mientras está abierto, la caja cobra y todo
// lo que cobra queda a nombre de este turno y de este cajero.
//
// Efectivo esperado al cerrar = fondo inicial + cobros en efectivo (con su
// propina) + entradas de efectivo − salidas de efectivo. La diferencia contra
// lo contado es el faltante (negativo) o sobrante (positivo) del corte.
const actor = {
    id: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, default: null },
};

const cashSessionSchema = new Schema({
    // "T-1010-01": mes y día + correlativo del día
    code: { type: String, required: true },
    // Pantalla de caja donde corre el turno
    deviceId: { type: String, required: true, index: true },
    // Empleado (puesto "cashier") que cobra durante el turno
    cashier: {
        id: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
        name: { type: String, required: true },
    },
    openedBy: actor,
    openingFloat: { type: Number, required: true, min: 0 },
    openedAt: { type: Date, default: Date.now },

    status: { type: String, enum: ["open", "closed"], default: "open", index: true },

    // Entradas y salidas de efectivo que no son ventas (ej. "retiro a caja
    // fuerte", "cambio de monedas")
    movements: [
        {
            type: { type: String, enum: ["in", "out"], required: true },
            amount: { type: Number, required: true, min: 0 },
            reason: { type: String, maxlength: 120, required: true },
            at: { type: Date, default: Date.now },
        },
    ],

    // --- Cierre (corte Z) ---
    closedAt: { type: Date, default: null },
    closedBy: {
        kind: { type: String, enum: ["cashier", "admin", null], default: null },
        name: { type: String, default: null },
    },
    countedCash: { type: Number, default: null },
    expectedCash: { type: Number, default: null },
    difference: { type: Number, default: null },
    closingNotes: { type: String, maxlength: 300, default: null },
    // Resumen congelado al cerrar, para imprimir el corte igual siempre
    summary: { type: Schema.Types.Mixed, default: null },
}, {
    timestamps: true,
    collection: "cashsessions",
});

// Un solo turno abierto por caja
cashSessionSchema.index(
    { deviceId: 1 },
    { unique: true, partialFilterExpression: { status: "open" }, name: "one_open_session_per_device" },
);

export default model("CashSession", cashSessionSchema);
