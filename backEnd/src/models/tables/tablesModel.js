import { Schema, model } from 'mongoose';
import crypto from 'crypto';

// Plantas y zonas del comedor. Las zonas son las que ve el cliente al
// reservar desde la app (ver reservationController), así que los nombres
// visibles viven junto a su clave.
export const TABLE_FLOORS = { 1: 'Planta baja', 2: 'Planta alta' };
export const TABLE_ZONES = {
  ventanal: { label: 'Junto al ventanal', floor: 1 },
  salon_central: { label: 'Salón central', floor: 1 },
  terraza: { label: 'Terraza', floor: 2 },
};

// Contenido del QR pegado en cada mesa. Es aleatorio (no el número ni el id)
// para que nadie pueda marcar su llegada sin estar frente a la mesa.
export const newQrToken = () => crypto.randomBytes(9).toString('base64url');

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
  occupiedAt: { type: Date },

  // Cuántas personas caben sentadas.
  capacity: { type: Number, min: 1, max: 20, default: 4 },
  // Planta (1 = baja, 2 = alta) y zona dentro de ella (ver TABLE_ZONES).
  floor: { type: Number, enum: [1, 2], default: 1 },
  zone: { type: String, enum: Object.keys(TABLE_ZONES), default: 'salon_central' },
  // Lugar de la mesa en el croquis de su planta, en porcentaje del ancho y
  // alto del plano. La app dibuja el croquis con esto.
  position: {
    x: { type: Number, min: 0, max: 100 },
    y: { type: Number, min: 0, max: 100 },
    w: { type: Number, min: 0, max: 100 },
    h: { type: Number, min: 0, max: 100 },
  },
  qrToken: { type: String, unique: true, sparse: true, default: newQrToken },
  // Reserva de la app que tiene apartada la mesa mientras está 'reservada'.
  reservation: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null }
}, {
  // Registra fecha de creación y última actualización
  timestamps: true,
  // Permite guardar campos adicionales no definidos arriba
  strict: false
});

export default model("Tables", tableSchema);