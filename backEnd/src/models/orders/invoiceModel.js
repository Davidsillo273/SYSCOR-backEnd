import mongoose, { Schema, model } from "mongoose";

// INVOICE: el registro de FACTURACIÓN. No se crea a mano desde el front: se
// genera automáticamente cuando un Order pasa a "delivered" (ver
// orderController.generateInvoice). Es una "fotografía" de la venta ya
// completada, para el historial de ventas/reportes, separada del Order
// operativo (que sigue viviendo en la colección "orders" y puede seguir
// cambiando de estado, o incluso borrarse, sin afectar lo ya facturado).
const invoiceSchema = new Schema({
  // Referencia al pedido que la originó, por si se necesita ver el detalle completo
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true
  },
  orderType: {
    type: String,
    enum: ['local', 'online'],
    required: true
  },
  // Código de orden del pedido ("AD27-01"), copiado para listarlo sin populate.
  orderCode: { type: String },

  // Copia de los productos vendidos tal como estaban al momento de entregarse
  // (no una referencia), para que la factura no cambie si el pedido original
  // se edita o se elimina después.
  items: [
    {
      name: String,
      price: Number,
      quantity: Number
    }
  ],
  total: { type: Number, required: true },

  // Datos de contexto ya "aplanados" (no referencias) para poder listar el
  // historial de facturación sin tener que hacer populate del pedido original
  tableNumber: { type: Number },   // solo pedidos locales
  waiterName: { type: String },    // solo pedidos locales
  customerName: { type: String },  // solo pedidos en línea
  isDelivery: { type: Boolean },   // solo pedidos en línea
  paymentMethod: { type: String },

  // Momento en que se completó/facturó la venta (== cuando el pedido pasó a "delivered")
  issuedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  collection: "invoices"
});

export default model("Invoice", invoiceSchema);
