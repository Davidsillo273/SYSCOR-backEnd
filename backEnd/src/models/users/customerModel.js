import mongoose, { Schema, model } from "mongoose";

// Sub-esquema para guardar las tarjetas de pago del cliente
const cardSchema = new Schema(
  {
    // Número de la tarjeta cifrado (ver cardCryptoUtils). Nunca sale del servidor.
    // El CVV no se guarda: el cliente lo escribe en cada compra.
    token: { type: String, required: true },
    lastFour: { type: String, required: true, maxlength: 4 }, // Últimos 4 dígitos para mostrar
    brand: { type: String, required: true, enum: ["VISA", "MASTERCARD", "AMEX", "DINERS", "OTHER"] },
    cardHolder: { type: String, required: true },
    expiryMonth: { type: Number, min: 1, max: 12 },
    expiryYear: { type: Number, min: 0, max: 99 }, // Dos dígitos, como viene impreso
    isDefault: { type: Boolean, default: false }, // ¿Es su tarjeta principal?
  },
  { _id: false }, // No necesitamos un ID interno para cada tarjeta
);

// Sub-esquema para las direcciones de envío
const addressSchema = new Schema(
  {
    tag: { type: String, required: true }, // Ej. "Casa", "Trabajo"
    details: { type: String, required: true }, // Dirección completa
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

// Estructura principal del Cliente
const customerSchema = new Schema(
  {
    // Datos personales
    personalInfo: {
      name: { type: String, required: true, trim: true },
      lastname: { type: String, required: true, trim: true },
      image: { type: String, default: null },
      birthdate: { type: Date, default: null },
      addresses: { type: [addressSchema], default: [] }, // Lista de direcciones
      // Hasta 3 teléfonos: { number, type: "mobile" | "landline" | "work" | "other", isDefault }.
      // Es Mixed porque los clientes antiguos los tienen guardados como texto
      // plano; customerContactUtils.normalizePhones los lleva a la forma nueva.
      phones: { type: [Schema.Types.Mixed], default: [] },
      cards: { type: [cardSchema], default: [] }, // Lista de tarjetas guardadas
    },
    // Credenciales para iniciar sesión
    loginInfo: {
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      password: { type: String, required: true },
      isVerified: { type: Boolean, default: false },
      loginAttempts: { type: Number, default: 0 },
      timeOut: { type: Date, default: null },
    },
    // Saldo a favor: lo abona Panchita al resolver un reclamo y se usa en el
    // pago de los siguientes pedidos (ver claimPolicy y checkoutController).
    wallet: {
      balance: { type: Number, default: 0, min: 0 },
    },
    // Productos favoritos del menú
    favorites: {
      type: [{ type: Schema.Types.ObjectId, ref: "Products" }],
      default: [],
    },
    // Estado de la cuenta del cliente. A diferencia de los empleados
    // (workInfo.status, con varios estados laborales), aquí basta con
    // activo/inactivo: desactivar es la forma de cerrarle el acceso a alguien
    // sin borrar su historial de pedidos, que se necesita para la
    // contabilidad y los rankings.
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
    strict: false,
  },
);

export default model("Customer", customerSchema);