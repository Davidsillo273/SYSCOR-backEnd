import mongoose, { Schema, model } from "mongoose";

// RECLAMO de un pedido en línea, levantado por el cliente con Panchita.
//
// Quien decide no es la IA sino claimPolicy (reglas fijas): Panchita solo
// recoge los datos y los pasa. Estados:
//   approved        → aprobado y ya abonado como saldo a favor
//   pending_refund  → aprobado, el cliente pidió el dinero en su tarjeta: un
//                     admin lo reembolsa desde el panel de Wompi (su API no
//                     permite reembolsos) y lo marca como `refunded`
//   refunded        → reembolsado a la tarjeta
//   in_review       → no cumple las reglas automáticas: lo decide un admin
//   rejected        → un admin lo rechazó
const claimSchema = new Schema(
    {
        customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
        order: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
        type: {
            type: String,
            // "cancelled": no es una queja; es el reembolso a tarjeta de un pedido
            // que el cliente canceló (ver orderController.cancelMyOrder).
            enum: ["missing_item", "wrong_item", "quality", "late", "other", "cancelled"],
            required: true,
        },
        items: [
            {
                name: String,
                quantity: Number,
                amount: Number,
                _id: false,
            },
        ],
        description: { type: String, maxlength: 500 },
        amount: { type: Number, default: 0 },
        resolution: { type: String, enum: ["credit", "card_refund"], default: "credit" },
        status: {
            type: String,
            enum: ["approved", "pending_refund", "refunded", "in_review", "rejected"],
            required: true,
        },
        decidedBy: { type: String, enum: ["panchita", "admin"], default: "panchita" },
        // Por qué quedó así, en palabras para el cliente.
        reason: { type: String },
        adminNote: { type: String },
        resolvedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

export default model("Claim", claimSchema);
