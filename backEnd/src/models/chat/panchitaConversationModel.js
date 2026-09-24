import { Schema, model } from "mongoose";

// Conversación de un cliente con Panchita en la app.
//
// Se guarda en el servidor (a diferencia del asistente del panel, que recibe
// el historial desde el navegador) porque aquí Panchita puede levantar
// reclamos y abonar saldo: si el historial viniera del teléfono, alguien
// podría inyectar un resultado de herramienta falso.
//
//   contents → el historial tal como lo espera Gemini (incluye llamadas a
//              herramientas y la metadata que Gemini exige recibir de vuelta)
//   messages → lo que se le muestra al cliente para retomar la charla
const panchitaConversationSchema = new Schema(
    {
        customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true, unique: true },
        contents: { type: [Schema.Types.Mixed], default: [] },
        messages: [
            {
                role: { type: String, enum: ["user", "model"] },
                text: String,
                // Tarjetas que acompañan la respuesta (estimación, reclamo, carrito…)
                cards: { type: [Schema.Types.Mixed], default: [] },
                createdAt: { type: Date, default: Date.now },
            },
        ],
    },
    { timestamps: true },
);

export default model("PanchitaConversation", panchitaConversationSchema);
