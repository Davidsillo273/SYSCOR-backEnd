import { Schema, model } from "mongoose";

// Una pantalla de caja emparejada (POS). Mismo esquema que las pantallas de
// cocina: el token de dispositivo solo vale mientras este registro esté
// activo y su tokenVersion coincida (desvincularla lo invalida al instante).
const cashierDeviceSchema = new Schema({
    // UUID que genera la propia pantalla y guarda en su navegador (pos_device_id)
    deviceId: { type: String, required: true, unique: true },
    label: { type: String, default: "Caja 1" },
    active: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    userAgent: { type: String, default: null },
    pairedBy: {
        id: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
        name: { type: String, default: null },
    },
    pairedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
}, {
    timestamps: true,
    strict: true,
    collection: "cashierdevices",
});

export default model("CashierDevice", cashierDeviceSchema);
