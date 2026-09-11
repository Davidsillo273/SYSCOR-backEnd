import mongoose, { Schema, model } from "mongoose";

// Sesión temporal para capturar el DUI desde el celular.
//
// El problema que resuelve: el admin está invitando a un empleado desde una
// computadora, que normalmente no tiene una cámara útil para fotografiar un
// documento. En vez de obligarlo a pasar la foto al escritorio a mano, la
// PC muestra un código QR; el admin lo escanea con su teléfono, el teléfono
// abre una página pública que solo sirve para tomar esas dos fotos, y las
// imágenes aparecen en la pantalla de la PC al instante (por Socket.IO).
//
// Es deliberadamente efímera y de un solo uso:
//   - Vive 10 minutos (índice TTL); pasado ese tiempo, MongoDB la borra.
//   - El token va en la URL que codifica el QR: quien lo tenga puede subir
//     fotos a ESA sesión y nada más. No da acceso a ninguna otra cosa del
//     sistema, no expone datos y no sirve para leer nada.
const duiCaptureSessionSchema = new Schema({
  // Token aleatorio que viaja en el QR. Es lo único que necesita el celular
  // para identificar la sesión, así que la página móvil no pide iniciar
  // sesión (sería imposible en la práctica: el teléfono del admin no
  // necesariamente tiene su cuenta abierta).
  token: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Quién abrió la sesión desde la PC. Se guarda para poder emitir el evento
  // de socket solo a esa persona (room "user:<id>"), y no a todo el panel.
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },

  status: {
    type: String,
    enum: ["pending", "uploaded", "consumed"],
    default: "pending",
  },

  // Las dos caras del documento, ya subidas a Cloudinary desde el celular.
  front: {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
  },
  back: {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
  },
}, {
  timestamps: true,
  collection: "duicapturesessions",
});

// La sesión se autodestruye a los 10 minutos: es tiempo de sobra para
// escanear el QR y tomar dos fotos, y evita dejar tokens válidos dando
// vueltas si el admin abandona el proceso a medias.
const TEN_MINUTES_IN_SECONDS = 60 * 10;
duiCaptureSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: TEN_MINUTES_IN_SECONDS });

export default model("DuiCaptureSession", duiCaptureSessionSchema);
