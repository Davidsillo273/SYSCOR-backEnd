import { Schema, model } from 'mongoose';

// Definimos la estructura de datos para las mesas del restaurante
const tableSchema = new Schema({
  // Número visible de la mesa, único en todo el local
  number: { type: Number, required: true, unique: true },
  // Estado operativo de la mesa: libre (disponible), ocupada (con clientes),
  // limpieza (recién desocupada, aún no lista) o reservada. Cambiar a 'libre'
  // o 'limpieza' cancela en cascada los pedidos activos de esa mesa (ver
  // tablesController.updateTable / bulkUpdateStatus)
  status: {
    type: String,
    enum: ['libre', 'ocupada', 'limpieza', 'reservada'],
    default: 'libre'
  },
  // Datos de la ocupación actual: se llenan al pasar a 'ocupada' y se limpian
  // al pasar a cualquier otro estado.
  customerName: { type: String, trim: true, maxlength: 60 },
  peopleCount: { type: Number, min: 1, max: 50 },
  occupiedAt: { type: Date }
}, {
  // Registra fecha de creación y última actualización
  timestamps: true,
  // Permite guardar campos adicionales no definidos arriba
  strict: false
});

export default model("Tables", tableSchema);