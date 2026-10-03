// Mesero de una comanda, listo para mostrar: { _id, name, lastname }.
//
// El nombre del empleado vive en personalInfo (ver employeeModel), pero todo
// el sistema (cocina, panel web, facturas, Panchita) lee waiter.name y
// waiter.lastname. Antes se pedía populate('waiter', 'name lastname'), que no
// existen en el modelo, y el mesero salía vacío ("Sin mesero"). Con este
// populate el nombre llega donde todos lo esperan.
export const WAITER_POPULATE = {
    path: "waiter",
    select: "personalInfo.name personalInfo.lastname",
    transform: (doc) =>
        doc
            ? { _id: doc._id, name: doc.personalInfo?.name || "", lastname: doc.personalInfo?.lastname || "" }
            : doc,
};

// Nombre corto de un empleado ya cargado: "David Guardado".
export const employeeName = (employee) =>
    `${employee?.personalInfo?.name || employee?.name || ""} ${employee?.personalInfo?.lastname || employee?.lastname || ""}`.trim();

export default { WAITER_POPULATE, employeeName };
