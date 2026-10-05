import { Schema, model } from "mongoose";

// Una pantalla de cocina emparejada (KDS). El token de dispositivo solo vale
// mientras este registro esté activo y su tokenVersion coincida con la del
// token: desactivarla o volver a emparejarla invalida al instante cualquier
// token anterior, sin esperar a que venza (kill switch).
const kitchenDeviceSchema = new Schema({
    // UUID que genera la propia pantalla y guarda en su navegador (kds_device_id)
    deviceId: { type: String, required: true, unique: true },
    // Nombre para reconocerla en el panel ("Cocina 1"), editable a futuro
    label: { type: String, default: "Pantalla de cocina" },
    active: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    // Navegador desde el que se emparejó, para reconocerla en el panel
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
});

export default model("KitchenDevice", kitchenDeviceSchema);
