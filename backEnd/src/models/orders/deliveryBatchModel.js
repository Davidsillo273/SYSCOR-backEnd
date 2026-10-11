import mongoose, { Schema, model } from "mongoose";

// PAQUETE DE REPARTO: varios pedidos a domicilio que salen juntos con un
// mismo repartidor. Los arma Chef Panchita (utils/panchita/dispatchUtils.js)
// agrupando los pedidos listos cuyos domicilios quedan cerca, y se lo asigna
// solo a un repartidor en turno que no esté en ruta.
//
//   assigned  → asignado; el repartidor todavía no sale del local (aún se le
//               pueden sumar pedidos cercanos que vayan quedando listos)
//   on_route  → el repartidor salió con el paquete
//   completed → entregó todas las paradas
//   cancelled → se deshizo (el repartidor salió de turno antes de salir)
const deliveryBatchSchema = new Schema(
  {
    // Código corto para mostrar ("P-0412"): mes/día + correlativo del día.
    code: { type: String, required: true },
    driver: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    status: {
      type: String,
      enum: ["assigned", "on_route", "completed", "cancelled"],
      default: "assigned",
    },
    // Paradas en el orden en que conviene entregarlas (vecino más cercano
    // desde el local).
    stops: [
      {
        order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
        sequence: { type: Number, required: true },
        _id: false,
      },
    ],
    // Recorrido estimado del paquete completo (local → última parada), en km.
    distanceKm: { type: Number, default: null },
    // Por qué Panchita armó el paquete así; se muestra al repartidor.
    reason: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "deliverybatches" }
);

deliveryBatchSchema.index({ driver: 1, status: 1 });
deliveryBatchSchema.index({ status: 1, createdAt: -1 });

export default model("DeliveryBatch", deliveryBatchSchema);
