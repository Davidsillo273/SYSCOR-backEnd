import { Schema, model } from "mongoose";

// Solicitud que el cliente hace desde la página de su mesa (al escanear el
// QR): pedir la cuenta o llamar a su mesero. Ver utils/tables/tableRequestUtils.js.
//
// Ciclo de vida:
//   pending      -> se le avisó al mesero de la mesa
//   escalated    -> nadie respondió en 30 s: se avisó a todos los meseros
//   acknowledged -> un mesero tocó "Voy"
//   resolved     -> el mesero la marcó como atendida (o pasaron 10 min)
//   cancelled    -> el cliente la canceló o la mesa se liberó
export const OPEN_REQUEST_STATUSES = ["pending", "escalated"];
export const ACTIVE_REQUEST_STATUSES = ["pending", "escalated", "acknowledged"];

export const REQUEST_REASONS = {
    order_more: "Quiere ordenar algo más",
    question: "Tiene una consulta",
    tip: "Quiere dejarte propina",
    other: "Necesita ayuda",
};

export const PAY_METHODS = {
    cash: "Pagará en efectivo: lleva cambio.",
    card: "Pagará con tarjeta: lleva el POS.",
};

const tableRequestSchema = new Schema(
    {
        table: { type: Schema.Types.ObjectId, ref: "Tables", required: true },
        tableNumber: { type: Number, required: true },
        // Ocupación de la mesa a la que pertenece: al liberarse la mesa, sus
        // solicitudes dejan de aplicar.
        occupiedAt: { type: Date, default: null },
        type: { type: String, enum: ["bill", "waiter"], required: true },
        // Solo en "waiter": para qué lo llaman.
        reason: { type: String, enum: [...Object.keys(REQUEST_REASONS), null], default: null },
        // Solo en "bill": cómo va a pagar.
        payMethod: { type: String, enum: [...Object.keys(PAY_METHODS), null], default: null },
        status: {
            type: String,
            enum: ["pending", "escalated", "acknowledged", "resolved", "cancelled"],
            default: "pending",
        },
        // Mesero de la mesa (el de su comanda más reciente). null = la mesa no
        // tiene mesero y se avisa a todos desde el inicio.
        assignedWaiter: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
        assignedWaiterName: { type: String, default: null },
        // Cuándo pasa a todos los meseros si nadie respondió. null = no escala
        // (sin mesero asignado ya es de todos; la propina espera a su mesero).
        escalateAt: { type: Date, default: null },
        escalatedAt: { type: Date, default: null },
        acknowledgedBy: {
            id: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
            name: { type: String, default: null },
            at: { type: Date, default: null },
        },
        resolvedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

tableRequestSchema.index({ table: 1, createdAt: -1 });
tableRequestSchema.index({ status: 1, escalateAt: 1 });

// Se borran solas a los 3 días: sirven para el turno, no como historial.
tableRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 3 });

export default model("TableRequest", tableRequestSchema);
