import mongoose, { Schema, model } from "mongoose";
import {
  DOCUMENT_CLASSES, DOCUMENT_TYPES, OPERATION_TYPES, CLASSIFICATIONS,
  SECTORS, COST_TYPES, BOOK_AMOUNT_FIELDS,
} from "../../utils/orders/purchaseBookCatalogs.js";

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
//
// También son la fuente del Libro de Compras (anexo 3 del F-07): por eso
// llevan la clase y el tipo de documento, el NRC del proveedor, el desglose
// de la compra por columna del libro y la clasificación para renta. Los
// códigos de esos campos están en utils/orders/purchaseBookCatalogs.js.
const amount = { type: Number, default: 0, min: 0 };

const purchaseInvoiceSchema = new Schema({
  // Nombre del proveedor tal como aparece en la factura
  supplierName: {
    type: String,
    required: true,
    trim: true
  },
  // NIT del proveedor. Las facturas viejas lo guardaban como "NIT / NRC"
  // en un solo campo; el NRC ahora va aparte, en supplierNrc.
  supplierTaxId: {
    type: String,
    default: null,
    trim: true
  },
  // NRC (registro de contribuyente de IVA) del proveedor: columna NRC del
  // libro. Sin él la compra no da derecho a crédito fiscal.
  supplierNrc: { type: String, default: null, trim: true },
  // DUI del proveedor: solo se usa cuando es persona natural sin NRC
  // (típicamente, compras a sujetos excluidos).
  supplierDui: { type: String, default: null, trim: true },

  // Número del documento (NUMDOC). En un DTE es el código de generación.
  invoiceNumber: {
    type: String,
    required: true,
    trim: true
  },
  // Serie del documento (NUMSERIE). Solo la traen los impresos por imprenta.
  series: { type: String, default: null, trim: true },
  // CLASEDOC y TIPODOCUM del libro. Por defecto DTE + Crédito Fiscal, que es
  // lo que emiten hoy casi todos los proveedores.
  documentClass: { type: String, enum: Object.keys(DOCUMENT_CLASSES), default: "4" },
  documentType: { type: String, enum: Object.keys(DOCUMENT_TYPES), default: "03" },
  // Fecha que aparece impresa en la factura, NO la fecha en que se subió al
  // sistema (para eso está createdAt). El período fiscal se calcula con esta.
  issuedAt: {
    type: Date,
    required: true
  },

  // --- Desglose del Libro de Compras ---
  // Una columna del libro por campo (ver BOOK_AMOUNT_FIELDS). Lo normal en
  // el negocio es que todo vaya en compras internas gravadas.
  internalTaxed: amount,
  internalExempt: amount,
  internationTaxed: amount,
  internationExempt: amount,
  importGoods: amount,
  importServices: amount,
  importExempt: amount,
  excludedSubject: amount,
  // IVARET: IVA retenido o percibido en la compra. Se suma al total.
  ivaWithheld: amount,

  // --- Clasificación para renta (columnas finales del libro) ---
  // Los valores por defecto son los que el negocio ya usa en su libro.
  operationType: { type: String, enum: Object.keys(OPERATION_TYPES), default: "1" },
  classification: { type: String, enum: Object.keys(CLASSIFICATIONS), default: "2" },
  sector: { type: String, enum: Object.keys(SECTORS), default: "2" },
  costType: { type: String, enum: Object.keys(COST_TYPES), default: "2" },

  // --- Montos ---
  // subtotal y total se recalculan solos a partir del desglose (ver el
  // pre("validate") de abajo); los sigue leyendo el reporte de IVA.
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
// subtotal = base de la compra (todas las columnas del libro), total = base
// + IVA + IVA retenido. Así el reporte de IVA y el libro nunca se
// contradicen. Las facturas viejas, que solo traían subtotal, no tienen
// desglose: a esas no se les toca el subtotal.
purchaseInvoiceSchema.pre("validate", function () {
  const base = BOOK_AMOUNT_FIELDS.reduce((acc, f) => acc + (Number(this[f]) || 0), 0);
  if (base > 0) this.subtotal = Math.round(base * 100) / 100;
  this.total = Math.round(((Number(this.subtotal) || 0) + (Number(this.tax) || 0) + (Number(this.ivaWithheld) || 0)) * 100) / 100;
});

purchaseInvoiceSchema.index({ issuedAt: -1 });
purchaseInvoiceSchema.index({ processedForTax: 1, issuedAt: -1 });

export default model("PurchaseInvoice", purchaseInvoiceSchema);
