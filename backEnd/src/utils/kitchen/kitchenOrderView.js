// Cómo ve una comanda la pantalla de cocina.
//
// Menor privilegio también en los datos: la cocina necesita qué preparar, de
// dónde viene y desde cuándo; no necesita totales, precios, método de pago,
// correos, direcciones ni datos del repartidor. Todo lo que sale hacia una
// pantalla de cocina (HTTP y socket) pasa por aquí.

const firstNameAndInitial = (name, lastname) => {
    const first = String(name || "").trim().split(/\s+/)[0] || "";
    const initial = String(lastname || "").trim().charAt(0);
    if (!first) return "";
    return initial ? `${first} ${initial.toUpperCase()}.` : first;
};

const idOf = (value) => (value && typeof value === "object" && value._id ? String(value._id) : value ? String(value) : null);

export const toKitchenOrder = (order) => {
    if (!order) return null;
    const source = typeof order.toObject === "function" ? order.toObject() : order;
    const contact = source.contact?.name ? source.contact : source.customer?.personalInfo;
    const table = source.table && typeof source.table === "object" ? source.table : null;
    const waiter = source.waiter && typeof source.waiter === "object" ? source.waiter : null;

    return {
        _id: String(source._id),
        code: source.code,
        kitchenNumber: source.kitchenNumber ?? null,
        orderType: source.orderType,
        fulfillment: source.fulfillment,
        isDelivery: source.isDelivery,
        table: table ? { number: table.number } : null,
        waiter: waiter ? { name: waiter.name || "", lastname: waiter.lastname || "" } : null,
        localCustomerName: source.localCustomerName || "",
        customerName: firstNameAndInitial(contact?.name, contact?.lastname),
        items: (source.items || []).map((item) => ({
            _id: idOf(item._id),
            itemType: item.itemType,
            itemId: idOf(item.itemId),
            name: item.name,
            quantity: item.quantity,
            notes: item.notes,
            addedAt: item.addedAt,
        })),
        notes: source.notes || "",
        status: source.status,
        statusHistory: (source.statusHistory || []).map((entry) => ({ status: entry.status, changedAt: entry.changedAt })),
        waiting: Boolean(source.waiting),
        firedAt: source.firedAt || null,
        hold: { active: Boolean(source.hold?.active), until: source.hold?.until || null },
        scheduledFor: source.scheduledFor || null,
        arrivedAt: source.arrivedAt || null,
        round: source.round,
        course: source.course,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
    };
};

export default { toKitchenOrder };
