import { Schema, model } from "mongoose";

// COMPROBANTE DE CAJA: lo que se le entrega al cliente al cobrar. Es una
// fotografía del cobro (productos, montos, pago, datos fiscales) que no
// cambia aunque los pedidos se editen después.
//
// Simula un Documento Tributario Electrónico de Hacienda (ver
// constants/fiscal.js): Factura de Consumidor Final (01) o Comprobante de
// Crédito Fiscal (03), con número de control, código de generación y sello.
// No se transmite a Hacienda: todo comprobante es de prueba.
const cashReceiptSchema = new Schema({
    session: { type: Schema.Types.ObjectId, ref: "CashSession", required: true, index: true },
    deviceId: { type: String, required: true },
    cashier: {
        id: { type: Schema.Types.ObjectId, ref: "Employee" },
        name: { type: String },
    },

    // --- Documento ---
    documentType: { type: String, enum: ["fcf", "ccf"], required: true },
    dteType: { type: String, enum: ["01", "03"], required: true },
    // Correlativo propio de cada tipo de documento
    correlative: { type: Number, required: true },
    controlNumber: { type: String, required: true, unique: true },
    generationCode: { type: String, required: true, unique: true },
    receptionSeal: { type: String, required: true },

    // Qué se cobró
    source: {
        kind: { type: String, enum: ["table", "pickup", "counter"], required: true },
        tableNumber: { type: Number, default: null },
        orders: [{ type: Schema.Types.ObjectId, ref: "Order" }],
        orderCodes: [{ type: String }],
        customerName: { type: String, default: null },
    },

    items: [
        {
            name: String,
            quantity: Number,
            // Precio unitario con IVA incluido (el del menú)
            unitPrice: Number,
            total: Number,
            _id: false,
        },
    ],

    // --- Montos ---
    // total = lo que cuestan los productos (IVA incluido). base + iva = total.
    base: { type: Number, required: true },
    iva: { type: Number, required: true },
    total: { type: Number, required: true },
    // Saldo a favor del cliente que ya cubrió parte del pedido (pedidos de la app)
    creditApplied: { type: Number, default: 0 },
    // Propina voluntaria: no lleva IVA ni forma parte de la venta
    tip: { type: Number, default: 0 },
    // Lo que paga el cliente en caja: total − saldo a favor + propina
    amountDue: { type: Number, required: true },

    payment: {
        method: { type: String, enum: ["cash", "card"], required: true },
        received: { type: Number, default: null },
        change: { type: Number, default: null },
        cardBrand: { type: String, default: null },
        cardLast4: { type: String, default: null },
        authorizationCode: { type: String, default: null },
    },

    // Receptor del Crédito Fiscal (en Factura es opcional: solo el nombre)
    customer: {
        name: { type: String, default: null },
        nit: { type: String, default: null },
        nrc: { type: String, default: null },
        activity: { type: String, default: null },
        address: { type: String, default: null },
        email: { type: String, default: null },
    },

    issuedAt: { type: Date, default: Date.now },
}, {
    timestamps: true,
    collection: "cashreceipts",
});

cashReceiptSchema.index({ issuedAt: -1 });

export default model("CashReceipt", cashReceiptSchema);
