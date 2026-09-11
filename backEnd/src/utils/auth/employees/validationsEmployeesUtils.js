// Validaciones específicas para documentos e ingresos laborales de empleados
// (DUI, NIT, salario mínimo, puesto). Nota: al momento de este comentario,
// ningún controller importa este archivo — la validación de puesto usada en
// producción vive en invitationValidationsUtils.validateEmployeeType, y el
// salario se valida con validationsUsersUtils.validatePositiveNumber. Se deja
// aquí por si se retoma, pero no forma parte del flujo activo.
import utils from "../validationsUsersUtils.js";

// El DUI salvadoreño tiene formato fijo de 8 dígitos + dígito verificador
const validateDUI = (dui) => {
  if (!dui || typeof dui !== "string") {
    return { valid: false, message: "El DUI es requerido." };
  }
  if (!/^\d{8}-\d$/.test(dui.trim())) {
    return { valid: false, message: "El DUI debe tener el formato 00000000-0." };
  }
  return { valid: true };
};

// El NIT salvadoreño tiene formato fijo de 14 dígitos agrupados
const validateNIT = (nit) => {
  if (!nit || typeof nit !== "string") {
    return { valid: false, message: "El NIT es requerido." };
  }
  if (!/^\d{4}-\d{6}-\d{3}-\d$/.test(nit.trim())) {
    return { valid: false, message: "El NIT debe tener el formato 0000-000000-000-0." };
  }
  return { valid: true };
};

// Acepta cualquiera de los dos documentos: primero intenta como DUI, y si no
// calza, intenta como NIT antes de rechazarlo
const validateDuiNit = (value) => {
  const duiResult = validateDUI(value);
  if (duiResult.valid) return { valid: true };
  const nitResult = validateNIT(value);
  if (nitResult.valid) return { valid: true };
  return { valid: false, message: "El campo DUI/NIT no es válido. Use formato DUI (00000000-0) o NIT (0000-000000-000-0)." };
};

// El salario no puede quedar por debajo del salario mínimo legal vigente en
// El Salvador ($402.00 mensual)
const validateSalary = (salary) => {
  const result = utils.validatePositiveNumber(salary, "El salario");
  if (!result.valid) return result;
  if (Number(salary) < 402.00) {
    return { valid: false, message: "El salario no puede ser menor al salario mínimo ($402.00)." };
  }
  return { valid: true };
};

const VALID_EMPLOYEE_TYPES = ["kitchen", "waiter", "cashier", "manager", "cleaner", "delivery", "other"];

const validateEmployeeType = (type) => {
  if (!type || !VALID_EMPLOYEE_TYPES.includes(type)) {
    return {
      valid: false,
      message: `El tipo de empleado debe ser uno de: ${VALID_EMPLOYEE_TYPES.join(", ")}.`,
    };
  }
  return { valid: true };
};

export default {
  validateDUI,
  validateNIT,
  validateDuiNit,
  validateSalary,
  validateEmployeeType,
};