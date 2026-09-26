import mongoose, { Schema, model } from "mongoose";

// CHECKOUT: un intento de pago en línea desde la app de clientes.
//
// El pedido (Order) NO se crea al pagar, sino hasta que Wompi confirma que el
// cobro fue aprobado: así cocina nunca ve pedidos sin pagar. Mientras tanto
// todo lo necesario para crearlo vive aquí, ya con los precios calculados en
// el servidor (nunca los que manda el teléfono).
//
// Estados:
//   pending    → se creó el cobro en Wompi y el cliente está en la verificación 3DS
//   processing → se está creando el pedido (evita crearlo dos veces si la
//                redirección y el webhook llegan al mismo tiempo)
//   approved   → pagado; `order` apunta al pedido creado
//   rejected   → Wompi lo rechazó (o el cliente abandonó la verificación)
//   error      → no se pudo ni crear el cobro
const checkoutItemSchema = new Schema(
    {
        itemType: { type: String, enum: ["combo", "extra", "drink", "saucer"], required: true },
        itemId: { type: Schema.Types.ObjectId, required: true },
        name: String,
        price: Number,
        quantity: { type: Number, default: 1 },
        notes: String,
    },
    { _id: false },
);

const checkoutSchema = new Schema(
    {
        customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
        items: { type: [checkoutItemSchema], default: [] },
        subtotal: { type: Number, required: true },
        amount: { type: Number, required: true }, // total del pedido (no hay propina)
        // Saldo a favor que el cliente usó. Se descuenta al crear el checkout
        // (queda apartado) y se le devuelve si el pago no se completa.
        creditApplied: { type: Number, default: 0 },
        creditReleased: { type: Boolean, default: false },
        chargeAmount: { type: Number, required: true }, // lo que se cobra a la tarjeta: amount - creditApplied
        isDelivery: { type: Boolean, default: false },
        deliveryAddress: { type: String },
        status: {
            type: String,
            enum: ["pending", "processing", "approved", "rejected", "error"],
            default: "pending",
        },
        wompi: {
            transactionId: { type: String, index: true },
            authorizationCode: String,
            isReal: Boolean,
            message: String,
        },
        // Tarjeta nueva que el cliente pidió guardar: se pasa a su cuenta solo
        // si el pago se aprueba, y entonces se borra de aquí. Número cifrado
        // (cardCryptoUtils); nunca el CVV.
        pendingCard: {
            token: String,
            lastFour: String,
            brand: String,
            cardHolder: String,
            expiryMonth: Number,
            expiryYear: Number,
        },
        order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    },
    { timestamps: true },
);

export default model("Checkout", checkoutSchema);
