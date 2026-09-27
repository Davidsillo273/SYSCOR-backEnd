import { Schema, model } from "mongoose";

// Contador de pedidos por día y tipo, para el código de orden (ver
// orderCodeUtils). Un documento por combinación, ej. "2026-09-27:AD". Se
// incrementa de forma atómica, así dos pedidos simultáneos nunca reciben el
// mismo número.
const orderCounterSchema = new Schema(
    {
        _id: { type: String },
        seq: { type: Number, default: 0 },
    },
    { versionKey: false },
);

export default model("OrderCounter", orderCounterSchema);
