import mongoose, { Schema, model } from "mongoose";

// PURCHASE INVOICE: factura de COMPRA (las que el negocio recibe de sus
// proveedores). Es la contraparte de invoiceModel, que guarda las ventas.
//
// A diferencia de las facturas de venta —que el sistema genera solo cuando un
// pedido se entrega—, estas las sube el usuario a mano: llegan en papel o PDF
// desde el proveedor, así que alguien tiene que registrarlas.
//
// Existen para que el contador pueda cruzar el IVA: el que el negocio COBRÓ
// en sus ventas (débito fiscal) contra el que PAGÓ en sus compras (crédito
// fiscal). La diferencia es lo que se declara.
const purchaseInvoiceSchema = new Schema({
  // Nombre del proveedor tal como aparece en la factura
  supplierName: {
    type: String,
    required: true,
    trim: true
  },
  // NIT o NRC del proveedor. No es obligatorio porque no toda factura
  // pequeña lo trae legible, pero el contador lo necesita cuando existe.
  supplierTaxId: {
    type: String,
    default: null,
    trim: true
  },
  // Número de la factura/comprobante que emitió el proveedor
  invoiceNumber: {
    type: String,
    required: true,
    trim: true
  },
  // Fecha que aparece impresa en la factura, NO la fecha en que se subió al
  // sistema (para eso está createdAt). El período fiscal se calcula con esta.
  issuedAt: {
    type: Date,
    required: true
  },

  // --- Montos ---
  // Se guardan los tres por separado en vez de calcular el IVA al vuelo
  // porque la factura física ya trae su propio desglose, y por redondeos no
  // siempre coincide al centavo con aplicar el 13% sobre el subtotal. Manda
  // lo que dice el papel: es lo que el contador va a declarar.
  subtotal: {
    type: Number,
    required: true,
    min: 0
  },
  // IVA pagado en esta compra (crédito fiscal)
  tax: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  total: {
    type: Number,
    required: true,
    min: 0
  },

  // Categoría del gasto, para poder agrupar en el reporte
  category: {
    type: String,
    enum: ["insumos", "bebidas", "servicios", "equipo", "mantenimiento", "otros"],
    default: "insumos"
  },

  // --- Archivo respaldo ---
  // El PDF/imagen de la factura, guardado en Cloudinary igual que las fotos
  // del menú. Se conserva el publicId aparte para poder borrarlo del
  // almacenamiento cuando se elimine el registro.
  fileUrl: { type: String, default: null },
  filePublicId: { type: String, default: null },
  fileName: { type: String, default: null },

  // --- Control de IVA ---
  // El usuario marca esto cuando ya incluyó la factura en la declaración del
  // período. Evita que una misma compra se cuente dos veces entre un mes y
  // otro, que es el error clásico al declarar.
  processedForTax: {
    type: Boolean,
    default: false
  },
  processedAt: { type: Date, default: null },
  // Quién la marcó como procesada (copia del nombre, igual que hace
  // notificationsModel con el actor: el registro debe conservar quién fue
  // aunque después se edite ese usuario).
  processedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, default: null }
  },

  // Notas libres del usuario (ej. "falta el comprobante original")
  notes: { type: String, default: null, trim: true }
}, {
  timestamps: true,
  collection: "purchaseinvoices"
});

// El contador siempre consulta por período (mes) y por si ya se procesó,
// así que ese es el índice que hace rápida la pantalla de comparación.
purchaseInvoiceSchema.index({ issuedAt: -1 });
purchaseInvoiceSchema.index({ processedForTax: 1, issuedAt: -1 });

export default model("PurchaseInvoice", purchaseInvoiceSchema);
