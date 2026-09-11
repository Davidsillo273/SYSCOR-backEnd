/**
 * Validaciones específicas para el flujo de invitación de Admin/Empleado.
 * Se complementan con validationsUsersUtils.js (validateEmail, validateName,
 * validatePassword, validatePhone, etc.), que ya cubre lo genérico.
 */

const invitationValidationsUtils = {};

/**
 * Valida el tipo/puesto de empleado al momento de invitarlo.
 * Solo aplica cuando se invita a un Employee, no a un Admin.
 */
invitationValidationsUtils.validateEmployeeType = (type) => {
    const validTypes = ["kitchen", "waiter", "cashier", "manager", "cleaner", "delivery", "other"];
    if (!type || !validTypes.includes(type)) {
        return {
            valid: false,
            message: `El puesto del empleado debe ser uno de: ${validTypes.join(", ")}.`,
        };
    }
    return { valid: true };
};

export default invitationValidationsUtils;