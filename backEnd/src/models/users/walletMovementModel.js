import { Schema, model } from "mongoose";

// MOVIMIENTO del saldo a favor de un cliente. El saldo vive en
// customer.wallet.balance; aquí queda el historial de por qué subió o bajó,
// para que el cliente lo vea en la app ("Mi saldo").
//
// `amount` es positivo si entra saldo y negativo si sale. Tipos:
//   claim_credit    → reclamo aprobado como saldo a favor
//   order_payment   → se usó saldo para pagar un pedido
//   payment_release → un pago no se completó y el saldo apartado regresó
//   order_cancel    → el cliente canceló un pedido y regresó lo pagado con saldo
//   adjustment      → ajuste manual del equipo
const walletMovementSchema = new Schema(
    {
        customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
        type: {
            type: String,
            enum: ["claim_credit", "order_payment", "payment_release", "order_cancel", "adjustment"],
            required: true,
        },
        amount: { type: Number, required: true },
        // Texto para el cliente: "Pago del pedido #A1B2C".
        description: { type: String, maxlength: 200 },
        order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
        checkout: { type: Schema.Types.ObjectId, ref: "Checkout", default: null },
        claim: { type: Schema.Types.ObjectId, ref: "Claim", default: null },
    },
    { timestamps: true },
);

export default model("WalletMovement", walletMovementSchema);
