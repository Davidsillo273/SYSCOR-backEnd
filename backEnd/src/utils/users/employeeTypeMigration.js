import EmployeeModel from "../../models/users/employeeModel.js";

// Puestos que ya no existen y el puesto al que pasan sus empleados.
// Los puestos vigentes son kitchen, waiter, cashier y delivery.
const RETIRED_TYPES = {
    manager: "cashier",
    cleaner: "kitchen",
    other: "waiter",
};

// Pasa a los empleados con un puesto retirado a uno vigente. Es idempotente:
// cuando ya no queda ninguno, no modifica nada. Se usa la colección directa
// porque el valor viejo ya no pasa la validación del enum.
export const migrateRetiredEmployeeTypes = async () => {
    for (const [from, to] of Object.entries(RETIRED_TYPES)) {
        const { modifiedCount } = await EmployeeModel.collection.updateMany(
            { "personalInfo.type": from },
            { $set: { "personalInfo.type": to } }
        );
        if (modifiedCount > 0) {
            console.log(`Empleados con puesto "${from}" pasados a "${to}": ${modifiedCount}`);
        }
    }
};

export default migrateRetiredEmployeeTypes;
