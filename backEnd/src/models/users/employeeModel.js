import mongoose from "mongoose";

// Estructura de datos para un Empleado
const employeeSchema = new mongoose.Schema(
  {
    // Información personal y de contacto
    personalInfo: {
      name: { type: String, required: true, trim: true },
      lastname: { type: String, required: true, trim: true },
      duiNit: { type: String, required: true, trim: true }, // Documento de identidad (DUI o NIT)
      address: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      image: { type: String, default: null },
      // Puesto de trabajo del empleado
      type: {
        type: String,
        required: true,
        enum: ["kitchen", "waiter", "cashier", "manager", "cleaner", "delivery", "other"],
      },

      // --- Datos extraídos del DUI al invitar (ver duiScanController) ---
      // Se guardan porque son los que el DUI trae impresos y el admin ya no
      // tiene que teclear: el sistema los lee de la foto y el admin solo los
      // confirma/corrige antes de enviar la invitación.
      birthDate: { type: Date, default: null },
      gender: {
        type: String,
        enum: ["masculino", "femenino", null],
        default: null,
      },
      maritalStatus: {
        type: String,
        enum: ["soltero", "casado", "divorciado", "viudo", "acompanado", null],
        default: null,
      },
    },

    // Documentos del expediente del empleado. Todos viven en Cloudinary
    // (misma infra que las fotos del menú); acá solo se guarda la URL y el
    // publicId, para poder borrarlos del almacenamiento si se reemplazan.
    documents: {
      // Foto del DUI por ambas caras: es de donde salieron los datos de
      // arriba, así que se conserva como respaldo de lo que se capturó.
      duiFront: {
        url: { type: String, default: null },
        publicId: { type: String, default: null },
      },
      duiBack: {
        url: { type: String, default: null },
        publicId: { type: String, default: null },
      },
      // Recibo de agua/luz a nombre del empleado
      proofOfAddress: {
        url: { type: String, default: null },
        publicId: { type: String, default: null },
      },
      criminalRecord: {
        url: { type: String, default: null },
        publicId: { type: String, default: null },
      },
    },
    // Datos para ingresar al sistema
    loginInfo: {
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      password: { type: String, required: true },
      isVerified: { type: Boolean, default: false },
      loginAttempts: { type: Number, default: 0 },
      timeOut: { type: Date, default: null },
      // Código único que se genera la primera vez que el empleado tiene al
      // menos un permiso Y ya registró su propia contraseña. Se lo manda por
      // correo y lo usa en el login (junto con su contraseña) en vez de tener
      // que escribir su email cada vez, ver loginUtils.processLoginByAccessCode.
      accessCode: { type: String, default: null },
    },
    // Información laboral y salarial. AFP/ISSS/rent ya NO se piden al admin:
    // son descuentos de ley con porcentajes fijos, se calculan automáticamente
    // a partir del salario base (ver utils/users/payrollUtils.js) y aquí se
    // guarda el monto en dólares que resultó de ese cálculo, no un porcentaje.
    workInfo: {
      workInsurance: { type: Boolean, default: false }, // Seguro médico
      AFP: { type: Number, default: 0 }, // Descuento de AFP calculado (7.25% del salario)
      isss: { type: Number, default: 0 }, // Descuento de ISSS calculado (3%, tope $30)
      rent: { type: Number, default: 0 }, // Retención de ISR calculada según tabla de Hacienda
      salary: { type: Number, required: true }, // Sueldo base bruto
      additionalPay: { type: Number, default: 0 }, // Bonos extras (opcional)
      // Hasta cuándo aplica el pago adicional. Un bono se pacta por un
      // tiempo definido (15 días, 1, 2 o 3 meses), no para siempre: cuando
      // esta fecha pasa, el bono deja de corresponder.
      additionalPayDuration: {
        type: String,
        enum: ["15d", "1m", "2m", "3m", null],
        default: null,
      },
      additionalPayEndsAt: { type: Date, default: null },

      // --- Identificadores de ley ---
      // Pueden quedar vacíos al invitar (no siempre se tienen a mano), y en
      // ese caso la ficha del empleado queda marcada como incompleta —
      // mismo criterio que los insumos "pendientes" de Inventario.
      isssNumber: { type: String, default: null, trim: true }, // N.º de afiliación al ISSS
      afpInstitution: {
        type: String,
        enum: ["confia", "crecer", "ipsfa", "inpep", null],
        default: null,
      },
      afpNumber: { type: String, default: null, trim: true }, // NUP / n.º de afiliación a la AFP

      // Cuenta donde se le deposita el salario
      bankName: { type: String, default: null, trim: true },
      bankAccount: { type: String, default: null, trim: true },

      isAuthorized: { type: Boolean, default: false },
      status: {
        type: String,
        enum: ["active", "inactive", "suspended", "on_leave"],
        default: "active", // Estado actual en la empresa
      },
      shift: { type: String, default: null }, // Turno asignado (ej. "Mañana", "Tarde", "Noche")
      schedule: { type: String, default: null }, // Horario legible (ej. "8:00 AM - 4:00 PM")

      // Días que trabaja este empleado en la semana. Junto con el horario de
      // abajo, esto es lo que le permite al Dashboard saber si el empleado
      // está trabajando "en este momento" o no.
      workDays: {
        type: [String],
        enum: ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"],
        default: [],
      },
      // Horario general, en formato 24h "HH:mm" (ej. "08:00" a "16:00")
      scheduleStart: { type: String, default: null },
      scheduleEnd: { type: String, default: null },
      // Si el admin quiere un horario distinto para sábado/domingo, lo activa
      // aquí y llena las horas de abajo; si no, el fin de semana usa el horario general.
      weekendScheduleEnabled: { type: Boolean, default: false },
      weekendScheduleStart: { type: String, default: null },
      weekendScheduleEnd: { type: String, default: null },
    },
    // Permisos granulares específicos de este empleado (ej. "menu:create").
    // El admin los asigna al invitar o al editar el perfil del empleado.
    permissions: {
      type: [String],
      default: [],
    },
    // Sirve para forzar el cierre de sesión si un administrador
    // le cambia los permisos a este empleado mientras está conectado.
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    // Los virtuales de abajo tienen que viajar en el JSON que consume el
    // panel: es ahí donde se pinta el aviso de expediente incompleto.
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Qué le falta al expediente del empleado. El ISSS y la AFP pueden quedar
// vacíos al invitarlo (no siempre se tienen a mano ese día), pero el sistema
// tiene que recordarlo: mismo criterio que los insumos "pendientes" de
// Inventario, que se pueden crear a medias pero quedan marcados.
employeeSchema.virtual("missingFields").get(function getMissingFields() {
  const missing = [];
  const work = this.workInfo || {};
  const docs = this.documents || {};

  if (!work.isssNumber) missing.push("Número de ISSS");
  if (!work.afpInstitution) missing.push("Institución de AFP");
  if (!work.afpNumber) missing.push("Número de AFP");
  if (!work.bankName || !work.bankAccount) missing.push("Cuenta bancaria");
  if (!docs.proofOfAddress?.url) missing.push("Comprobante de domicilio");
  if (!docs.criminalRecord?.url) missing.push("Antecedentes penales");

  return missing;
});

// Atajo para las pantallas: true si hay algo pendiente de completar.
employeeSchema.virtual("hasMissingFields").get(function hasMissingFields() {
  return this.missingFields.length > 0;
});

export default mongoose.model("Employee", employeeSchema);