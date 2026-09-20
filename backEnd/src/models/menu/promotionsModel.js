import mongoose, { Schema, model } from "mongoose";

// Duración máxima de una promoción, en días. Vive acá porque tanto el modelo
// como las validaciones y el controller necesitan el mismo número: una promo
// "de hoy" no puede volverse permanente.
export const MAX_PROMOTION_DAYS = 3;

// Tipos de ítem que se pueden combinar dentro de una promoción. Cada uno
// apunta a su propia colección del menú (ej. 4 tacos + 1 burro + 1 bebida).
export const PROMOTION_ITEM_TYPES = ["saucer", "drink", "combo", "extra"];

// Mapa tipo -> nombre del modelo de Mongoose al que referencia. Se usa con
// refPath para que un mismo campo (refId) pueda apuntar a colecciones
// distintas según el itemType de esa línea.
export const PROMOTION_ITEM_MODELS = {
    saucer: "Saucers",
    drink: "Drinks",
    combo: "Combos",
    extra: "Extras",
};

// Una línea de la promoción: qué producto entra, cuántos, y con qué cambios
// de ingredientes respecto a la receta original.
const promotionItemSchema = new Schema({
    // Qué tipo de producto es esta línea (define a qué colección apunta refId)
    itemType: { type: String, enum: PROMOTION_ITEM_TYPES, required: true },
    // El producto en sí. refPath resuelve la colección a partir de itemModel.
    refId: { type: mongoose.Schema.Types.ObjectId, refPath: "items.itemModel", required: true },
    // Nombre del modelo destino. Lo llena el controller a partir de itemType,
    // el admin nunca lo manda: es un detalle interno de Mongoose.
    itemModel: { type: String, enum: Object.values(PROMOTION_ITEM_MODELS) },
    // Cuántas unidades de este producto entran en la promo (los "4" de "4 tacos")
    quantity: { type: Number, default: 1 },
    // Ingredientes que la promo quita respecto a la receta normal del platillo
    // (ej. "sin cebolla"). Son nombres, no insumos: lo que se descuenta del
    // inventario lo sigue resolviendo la receta del platillo.
    removedIngredients: [{ type: String }],
    // Ingredientes/extras que la promo agrega como parte del trato
    addedIngredients: [{
        name: { type: String },
        extraId: { type: mongoose.Schema.Types.ObjectId, ref: "Extras", default: null },
    }],
}, { _id: false });

// Definimos la estructura de una Promoción del día
const promotionsSchema = new Schema({
    // Nombre visible en la app del cliente (ej. "Martes de pastor")
    name: { type: String },
    // Texto corto que explica el trato
    description: { type: String },
    // Foto de la promo (opcional: si no hay, el front usa la imagen del
    // primer platillo incluido o un placeholder)
    image: { type: String },
    publicId: { type: String },

    // Qué incluye la promoción. Es lo que permite combinar platillos entre sí.
    items: [promotionItemSchema],

    // Precio promocional: lo que el cliente paga por todo el combo armado.
    price: { type: Number },
    // Cuánto costaría comprar lo mismo por separado. Lo calcula el backend a
    // partir de los precios vigentes de cada ítem (no se confía en el front)
    // y sirve para pintar el "antes/ahora" y el % de descuento.
    originalPrice: { type: Number, default: 0 },

    // Ventana de vigencia. Una promo arranca cuando el admin decide y muere
    // como máximo MAX_PROMOTION_DAYS días después.
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date },

    // "activa"   = corriendo (o programada) dentro de su ventana
    // "pausada"  = el admin la apagó a mano sin borrarla
    // "expirada" = se le venció la ventana (lo marca el propio backend al leer)
    status: { type: String, enum: ["activa", "pausada", "expirada"], default: "activa" },

    // Deja rastro de si la combinación salió de una sugerencia de la IA.
    // Sirve para medir si esas promos venden mejor que las armadas a mano.
    aiSuggested: { type: Boolean, default: false },
}, {
    timestamps: true,
    strict: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});

// ¿Está vigente AHORA? Es distinto de status: una promo "activa" programada
// para mañana existe, pero todavía no se le muestra al cliente.
promotionsSchema.virtual("isLive").get(function () {
    if (this.status !== "activa") return false;
    const now = Date.now();
    const starts = this.startsAt ? new Date(this.startsAt).getTime() : 0;
    const ends = this.endsAt ? new Date(this.endsAt).getTime() : Infinity;
    return now >= starts && now <= ends;
});

// Cuánto se ahorra el cliente, en porcentaje. Devuelve 0 en vez de un número
// raro cuando todavía no se pudo calcular el precio original.
promotionsSchema.virtual("discountPercent").get(function () {
    const original = Number(this.originalPrice) || 0;
    const price = Number(this.price) || 0;
    if (original <= 0 || price >= original) return 0;
    return Math.round(((original - price) / original) * 100);
});

// Consultar "las promos de hoy" es la lectura más frecuente (la hace cada
// cliente que abre el menú), así que indexamos por ventana y estado.
promotionsSchema.index({ status: 1, startsAt: 1, endsAt: 1 });

export default model("Promotions", promotionsSchema);
