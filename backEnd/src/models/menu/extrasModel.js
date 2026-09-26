import mongoose, {Schema, model} from 'mongoose';
import { UNIT_LIST } from "../../utils/units/unitsUtils.js"
import { EXTRA_TARGETS } from "../../utils/extras/extraTargetsUtils.js"

// Definimos la estructura para los Extras (adicionales al menú)
const extraSchema = new Schema({
    // Nombre del extra
    name: { type: String },
    // Costo adicional
    price: { type: Number },
    // Categoría libre para agrupar extras (Verduras, Lácteos, Salsas, Especial...)
    category: { type: String },
    // A qué tipos de producto se le puede agregar (categorías de platillo o
    // "Bebidas"). Vacío = no se ofrece en ningún lado (ver extraTargetsUtils)
    appliesTo: [{ type: String, enum: EXTRA_TARGETS }],
    // Si está disponible o no
    status: { type: String },
    // Foto del extra (opcional: si no hay, el front usa un placeholder)
    image: { type: String },
    // ID de la imagen en Cloudinary
    publicId: { type: String },
    // true cuando este extra depende de insumos de inventario (ej. "Guacamole
    // extra" hecho de aguacate + limón + sal), en vez de ser un simple cargo
    // adicional sin relación con el stock
    isCompound: { type: Boolean, default: false },
    // Ingredientes de inventario que consume este extra. Al confirmar un pedido
    // que lo incluya, se descuenta cada uno multiplicado por la cantidad pedida.
    ingredients: [{
        ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory" },
        quantity: { type: Number },
        unit: { type: String, enum: UNIT_LIST }
    }]
},{
    // Para saber cuándo se añadió al sistema
    timestamps: true,
    strict: false
})
export default model("Extras", extraSchema)