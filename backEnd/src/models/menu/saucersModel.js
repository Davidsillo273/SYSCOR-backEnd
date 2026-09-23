import mongoose, {Schema, model} from "mongoose"
import { UNIT_LIST } from "../../utils/units/unitsUtils.js"
import { SAUCER_CATEGORIES } from "../../utils/saucers/saucerCategoriesUtils.js"

// Definimos la estructura para los Platos principales (Saucers)
const saucersSchema = new Schema({
    // Foto del plato (opcional: si no hay, el front usa un placeholder)
    image: { type: String },
    // Nombre del platillo
    name: { type: String },
    // Categoría fija del platillo
    category: { type: String, enum: SAUCER_CATEGORIES },
    // Descripción libre del platillo
    description: { type: String },
    // Subcategoría de proteína (Al pastor, Pollo, Carne, Birria, etc.). No
    // aplica a las categorías de CATEGORIES_WITHOUT_SUBCATEGORY.
    subcategory: { type: String },
    // Cantidad de tacos por orden. Solo aplica cuando category es "Tacos": el
    // sistema detecta la categoría y muestra los botones 3/4/5 automáticamente.
    // El enum [3,4,5] se valida en el controller.
    quantity: { type: Number },
    // Precio del plato
    price: { type: Number },
    // Si está disponible a la venta. Nace 'Activo' por default
    status: { type: String, default: "Activo" },
    // Identificador de la imagen alojada
    publicId: { type: String },
    // Receta opcional: ingredientes del platillo, igual que en Drinks, con un
    // flag extra para saber si el cliente puede pedir que se lo quiten. Los
    // ingredientes con tracked:true descuentan inventario al confirmar la orden.
    recipe: [{
        name: { type: String },
        tracked: { type: Boolean, default: false },
        inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", default: null },
        removable: { type: Boolean, default: false },
        quantity: { type: Number },
        unit: { type: String, enum: UNIT_LIST }
    }]
},
{
    // Registra fechas de movimiento
    timestamps: true,
    strict: false
})

export default model("Saucers", saucersSchema)