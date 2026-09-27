import { Schema, model } from "mongoose";

// RESERVA: mesa apartada por un cliente que pidió "Comer en el local" desde
// la app. Nace sin mesa cuando se aprueba el pago (ver checkoutController) y
// Panchita se la asigna después en el chat de la app (ver
// reservationController).
//
// Estados:
//   pending_table → pagada, todavía sin mesa elegida
//   reserved      → con mesa; la mesa pasa a 'reservada' poco antes de la hora
//   checked_in    → el cliente escaneó el QR de su mesa: la mesa queda 'ocupada'
//   expired       → pasaron 30 min de la hora sin que llegara; la mesa se libera
//   cancelled     → el cliente canceló el pedido
const reservationSchema = new Schema(
    {
        customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
        order: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
        // Hora a la que llega el cliente.
        reservedFor: { type: Date, required: true, index: true },
        // Hasta cuándo se le guarda la mesa: reservedFor + 30 min.
        expiresAt: { type: Date, required: true },
        partySize: { type: Number, min: 1, max: 20, required: true },
        // Nombre con el que se anota la mesa (seudónimo o apellido). Opcional.
        alias: { type: String, trim: true, maxlength: 40 },
        // Con qué nombre la ve el personal: el alias, o el nombre del cliente
        // si no puso uno.
        displayName: { type: String, trim: true, maxlength: 60 },
        table: { type: Schema.Types.ObjectId, ref: "Tables", default: null },
        status: {
            type: String,
            enum: ["pending_table", "reserved", "checked_in", "expired", "cancelled"],
            default: "pending_table",
            index: true,
        },
        checkedInAt: { type: Date },
    },
    { timestamps: true },
);

export default model("Reservation", reservationSchema);
