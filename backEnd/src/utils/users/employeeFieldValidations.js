// Reglas de los datos de un empleado. Son un espejo de
// src/utils/employeeFields.js en el frontend (Invitar staff y la ficha del
// empleado): si cambian aquí, hay que cambiarlas allá.
//
// Todas devuelven { valid, message } para usarse con runValidations.

const ok = { valid: true };
const fail = (message) => ({ valid: false, message });
const onlyDigits = (value) => String(value ?? "").replace(/\D/g, "");

// --- DUI: 9 dígitos; se guarda como ########-# ------------------------------
export const normalizeDui = (value) => {
  const d = onlyDigits(value);
  return d.length === 9 ? `${d.slice(0, 8)}-${d.slice(8)}` : String(value ?? "").trim();
};

export const validateDui = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return fail("El DUI es requerido.");
  if (!/^\d{8}-?\d$/.test(raw)) return fail("El DUI debe tener exactamente 9 dígitos (sin letras).");
  return ok;
};

// --- Teléfono de empleado: 8 dígitos de El Salvador, empieza en 2, 6 o 7 ---
// (El de clientes sigue usando validatePhone de validationsUsersUtils, que
// es más permisivo; este es solo para empleados.)
export const normalizeEmployeePhone = (value) => {
  let d = onlyDigits(value);
  if (d.length === 11 && d.startsWith("503")) d = d.slice(3);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4)}` : String(value ?? "").trim();
};

export const validateEmployeePhone = (value) => {
  let d = onlyDigits(value);
  if (!d) return fail("El número de teléfono es requerido.");
  if (d.length === 11 && d.startsWith("503")) d = d.slice(3);
  if (/[a-zA-Z]/.test(String(value))) return fail("El teléfono no puede llevar letras.");
  if (d.length !== 8) return fail("El teléfono debe tener los 8 dígitos.");
  if (!/^[267]/.test(d)) return fail("El teléfono debe empezar con 2 (fijo), 6 o 7 (celular).");
  return ok;
};

// --- ISSS: exactamente 9 dígitos (opcional: puede quedar pendiente) --------
export const validateIsss = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return ok;
  if (!/^\d{9}$/.test(String(value).trim())) return fail("El número de ISSS debe tener exactamente 9 dígitos.");
  return ok;
};

// --- AFP: solo existen Crecer y Confía (el número va vinculado al DUI) -----
export const AFP_INSTITUTIONS = ["crecer", "confia"];

export const validateAfpInstitution = (value) => {
  if (value === undefined || value === null || value === "") return ok;
  if (!AFP_INSTITUTIONS.includes(value)) return fail("La institución de AFP debe ser Crecer o Confía.");
  return ok;
};

// --- Banco y cuenta ---------------------------------------------------------
// El banco se elige de la lista; la cuenta es solo de dígitos y su largo
// depende del banco. Mientras no se confirme el largo exacto de cada uno,
// todos usan el rango general de 8 a 20 dígitos.
const ACCOUNT_DEFAULT = { min: 8, max: 20 };

export const BANKS = [
  "Banco Agrícola",
  "Banco Cuscatlán",
  "Banco Davivienda",
  "BAC Credomatic",
  "Banco Promerica",
  "Banco Hipotecario",
  "Banco Atlántida",
  "Banco Azul",
  "Banco Industrial",
  "Banco de Fomento Agropecuario",
  "Banco Abank",
  "Fedecrédito",
].reduce((acc, name) => ({ ...acc, [name]: { ...ACCOUNT_DEFAULT } }), {});

// Banco y cuenta van juntos: o los dos o ninguno. `previousBankName` permite
// conservar un banco escrito a mano antes de que existiera la lista.
export const validateBankAccount = (bankName, account, previousBankName = null) => {
  const name = String(bankName ?? "").trim();
  const acc = String(account ?? "").trim();
  if (!name && !acc) return ok;
  if (!name) return fail("Elige el banco de la cuenta.");
  const bank = BANKS[name];
  if (!bank && name !== previousBankName) return fail("Elige un banco de la lista.");
  if (!acc) return fail("Escribe el número de cuenta.");
  if (!/^\d+$/.test(acc)) return fail("La cuenta bancaria solo puede llevar dígitos, sin guiones ni espacios.");
  const { min, max } = bank || ACCOUNT_DEFAULT;
  if (acc.length < min || acc.length > max) {
    return fail(`La cuenta de ${name} debe tener entre ${min} y ${max} dígitos.`);
  }
  return ok;
};

// --- Horario legal (Código de Trabajo de El Salvador) ----------------------
// - Art. 161: jornada diurna (06:00 a 19:00) de máximo 8 horas diarias y 44
//   semanales; nocturna (19:00 a 06:00) de máximo 7 horas diarias y 39
//   semanales. Una jornada con más de 4 horas nocturnas cuenta como nocturna.
// - Art. 171: al menos un día de descanso por semana (máximo 6 de trabajo).
// El turno se toma de corrido de la entrada a la salida y puede cruzar la
// medianoche.
const LIMITS = { day: { daily: 8, weekly: 44 }, night: { daily: 7, weekly: 39 }, maxWorkDays: 6 };
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const shiftMinutes = (start, end) => {
  const s = toMinutes(start);
  let e = toMinutes(end);
  if (e <= s) e += 24 * 60;
  let night = 0;
  for (let t = s; t < e; t += 1) {
    const minuteOfDay = t % (24 * 60);
    if (minuteOfDay >= 19 * 60 || minuteOfDay < 6 * 60) night += 1;
  }
  return { total: e - s, night };
};

export const validateLegalSchedule = ({
  workDays = [],
  scheduleStart,
  scheduleEnd,
  weekendScheduleEnabled = false,
  weekendScheduleStart,
  weekendScheduleEnd,
}) => {
  if (!scheduleStart && !scheduleEnd) return ok;
  if (!scheduleStart || !scheduleEnd) return fail("Indica la hora de entrada y la de salida.");
  if (!TIME_REGEX.test(scheduleStart) || !TIME_REGEX.test(scheduleEnd)) return fail("El horario debe tener el formato HH:MM.");
  if (scheduleStart === scheduleEnd) return fail("La hora de entrada y la de salida no pueden ser iguales.");
  if ((workDays || []).length > LIMITS.maxWorkDays) {
    return fail("Por ley, el empleado debe tener al menos un día de descanso a la semana (máximo 6 días de trabajo).");
  }

  const useWeekend = weekendScheduleEnabled && weekendScheduleStart && weekendScheduleEnd;
  if (useWeekend && (!TIME_REGEX.test(weekendScheduleStart) || !TIME_REGEX.test(weekendScheduleEnd))) {
    return fail("El horario de fin de semana debe tener el formato HH:MM.");
  }
  const weekday = shiftMinutes(scheduleStart, scheduleEnd);
  const weekend = useWeekend ? shiftMinutes(weekendScheduleStart, weekendScheduleEnd) : weekday;

  let nightShift = false;
  for (const shift of useWeekend ? [weekday, weekend] : [weekday]) {
    const isNight = shift.night > 4 * 60;
    nightShift = nightShift || isNight;
    const limit = isNight ? LIMITS.night : LIMITS.day;
    if (shift.total > limit.daily * 60) {
      return fail(`La jornada ${isNight ? "nocturna" : "diurna"} es de máximo ${limit.daily} horas diarias.`);
    }
  }

  const weeklyMinutes = (workDays || []).reduce(
    (sum, day) => sum + (useWeekend && ["sabado", "domingo"].includes(day) ? weekend.total : weekday.total),
    0
  );
  const weeklyLimit = nightShift ? LIMITS.night.weekly : LIMITS.day.weekly;
  if (weeklyMinutes > weeklyLimit * 60) {
    return fail(`La jornada ${nightShift ? "nocturna" : "diurna"} es de máximo ${weeklyLimit} horas semanales.`);
  }
  return ok;
};
