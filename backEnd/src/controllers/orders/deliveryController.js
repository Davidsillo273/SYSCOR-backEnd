import Order from "../../models/orders/orderModel.js";
import Invoice from "../../models/orders/invoiceModel.js";
import { emitToRoles, emitToTypes, emitToUser, SOCKET_EVENTS } from "../../config/socket.js";

const deliveryController = {};

// Proyección compartida: lo que la app del repartidor necesita ver en cada entrega.
const DELIVERY_POPULATE = [
  { path: "customer", select: "personalInfo.name personalInfo.lastname personalInfo.phones loginInfo.email" },
  { path: "driver", select: "personalInfo.name personalInfo.lastname" },
];

const extractPhone = (customer, order) => {
  if (order?.contact?.phone) return order.contact.phone;
  const phones = customer?.personalInfo?.phones;
  if (Array.isArray(phones) && phones.length > 0) {
    const first = phones[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.number || first.phone || null;
  }
  return customer?.personalInfo?.phone || null;
};

// Formatea un Order de domicilio al shape que espera la app móvil del repartidor.
const formatDelivery = (order) => {
  const customer = order.customer;
  const customerName = customer?.personalInfo
    ? `${customer.personalInfo.name || ""} ${customer.personalInfo.lastname || ""}`.trim()
    : order.contact?.name
    ? `${order.contact.name} ${order.contact.lastname || ""}`.trim()
    : "Cliente";

  const total = order.total || 0;
  // Estimación básica para distancia y tiempo si no vienen precalculados
  const distanceKm = order.eta?.distanceKm ?? 3.2;
  const etaMinutes = order.eta?.durationMinutes ?? 14;

  return {
    id: order._id,
    code: `#D-${String(order._id).slice(-3).toUpperCase()}`,
    status: order.deliveryStatus,
    customer: {
      name: customerName,
      phone: extractPhone(customer, order),
    },
    items: (order.items || []).map((i) => ({
      id: i._id,
      quantity: i.quantity,
      name: i.name,
      price: i.price,
    })),
    note: order.notes || null,
    total: total,
    paymentMethod: order.paymentMethod,
    cashGiven: order.cashGiven || null,
    pickup: {
      name: "El Corral · Centro",
      address: "Av. Cuscatlán #218",
      detail: "Av. Cuscatlán #218 · mostrador de reparto",
    },
    dropoff: {
      address: order.deliveryAddress || "Sin dirección",
      detail: order.driverMessages?.[0]?.text || null,
    },
    navigation: {
      primaryInstruction: "Gira a la derecha en 200 m",
      primaryStreet: "Av. Roosevelt Norte",
      nextInstruction: "Luego continúa 1.2 km hasta el semáforo",
    },
    arrivalClock: "12:42",
    distanceKm: distanceKm,
    etaMinutes: etaMinutes,
    deliveredAt: order.updatedAt
      ? new Date(order.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null,
    createdAt: order.createdAt,
  };
};

// GET /orders/delivery/available
// Pedidos de domicilio en estado "ready" sin repartidor asignado todavía.
deliveryController.getAvailable = async (req, res) => {
  try {
    const orders = await Order.find({
      isDelivery: true,
      status: "ready",
      deliveryStatus: "available",
      driver: null,
    })
      .populate(DELIVERY_POPULATE)
      .sort({ createdAt: 1 })
      .lean();

    res.json(orders.map(formatDelivery));
  } catch (err) {
    console.error("delivery.getAvailable:", err);
    res.status(500).json({ message: "Error al obtener entregas disponibles." });
  }
};

// GET /orders/delivery/mine
// La entrega activa (accepted o on_route) del repartidor con sesión.
deliveryController.getMine = async (req, res) => {
  try {
    const active = await Order.findOne({
      driver: req.user.id,
      deliveryStatus: { $in: ["accepted", "on_route"] },
    })
      .populate(DELIVERY_POPULATE)
      .lean();

    res.json(active ? formatDelivery(active) : null);
  } catch (err) {
    console.error("delivery.getMine:", err);
    res.status(500).json({ message: "Error al obtener tu entrega activa." });
  }
};

// GET /orders/delivery/history
// Últimas 30 entregas completadas por este repartidor.
deliveryController.getHistory = async (req, res) => {
  try {
    const orders = await Order.find({
      driver: req.user.id,
      deliveryStatus: "delivered",
    })
      .sort({ updatedAt: -1 })
      .limit(30)
      .populate(DELIVERY_POPULATE)
      .lean();

    res.json(orders.map(formatDelivery));
  } catch (err) {
    console.error("delivery.getHistory:", err);
    res.status(500).json({ message: "Error al obtener el historial." });
  }
};

// PATCH /orders/delivery/:id/accept
// El repartidor acepta una entrega del pool.
deliveryController.accept = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      isDelivery: true,
      deliveryStatus: "available",
      driver: null,
    });

    if (!order) {
      return res.status(409).json({
        message: "Esta entrega ya no está disponible. Otro repartidor pudo haberla tomado.",
      });
    }

    // Verificar que el repartidor no tenga ya una activa
    const hasActive = await Order.exists({
      driver: req.user.id,
      deliveryStatus: { $in: ["accepted", "on_route"] },
    });

    if (hasActive) {
      return res.status(400).json({
        message: "Ya tienes una entrega en curso. Complétala antes de tomar otra.",
      });
    }

    order.driver = req.user.id;
    order.deliveryStatus = "on_route";
    order.statusHistory.push({ status: "on_route", changedAt: new Date() });
    await order.save();

    const populated = await Order.findById(order._id).populate(DELIVERY_POPULATE).lean();

    emitToRoles(["admin", "employee"], SOCKET_EVENTS.ORDER_UPDATED, { order: populated });
    emitToUser(order.customer, "delivery:accepted", { orderId: order._id });

    res.json(formatDelivery(populated));
  } catch (err) {
    console.error("delivery.accept:", err);
    res.status(500).json({ message: "Error al aceptar la entrega." });
  }
};

// PATCH /orders/delivery/:id/reject
// El repartidor rechaza / devuelve la entrega al pool.
deliveryController.reject = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      driver: req.user.id,
      deliveryStatus: { $in: ["accepted", "on_route"] },
    });

    if (!order) {
      return res.status(404).json({ message: "Entrega no encontrada o ya no está en tu poder." });
    }

    order.driver = null;
    order.deliveryStatus = "available";
    await order.save();

    const populated = await Order.findById(order._id).populate(DELIVERY_POPULATE).lean();
    emitToRoles(["admin", "employee"], SOCKET_EVENTS.ORDER_UPDATED, { order: populated });
    emitToTypes(["delivery"], "delivery:available", { order: formatDelivery(populated) });

    res.json({ message: "Entrega devuelta al pool." });
  } catch (err) {
    console.error("delivery.reject:", err);
    res.status(500).json({ message: "Error al rechazar la entrega." });
  }
};

// PATCH /orders/delivery/:id/confirm
// El repartidor confirma que entregó el pedido.
deliveryController.confirm = async (req, res) => {
  try {
    const { deliveryMethod, driverNote } = req.body;

    const order = await Order.findOne({
      _id: req.params.id,
      driver: req.user.id,
      deliveryStatus: "on_route",
    });

    if (!order) {
      return res.status(404).json({ message: "Entrega activa no encontrada." });
    }

    if (deliveryMethod && !["hand", "reception"].includes(deliveryMethod)) {
      return res.status(400).json({ message: "deliveryMethod debe ser 'hand' o 'reception'." });
    }

    order.deliveryStatus = "delivered";
    order.deliveryMethod = deliveryMethod || "hand";
    order.driverNote = driverNote?.trim() || null;
    order.status = "delivered";
    order.paymentStatus = "paid";
    order.statusHistory.push({ status: "delivered", changedAt: new Date() });
    await order.save();

    const populated = await Order.findById(order._id).populate(DELIVERY_POPULATE).lean();

    // Facturar automáticamente si no existe la factura previa
    const existingInvoice = await Invoice.findOne({ order: order._id });
    if (!existingInvoice) {
      const customer = populated.customer;
      const customerName = customer?.personalInfo
        ? `${customer.personalInfo.name || ""} ${customer.personalInfo.lastname || ""}`.trim()
        : populated.contact?.name
        ? `${populated.contact.name} ${populated.contact.lastname || ""}`.trim()
        : undefined;

      await Invoice.create({
        order: order._id,
        orderType: order.orderType || "online",
        items: (order.items || []).map((i) => ({ name: i.name, price: i.price, quantity: i.quantity })),
        total: order.total,
        customerName: customerName,
        isDelivery: true,
        paymentMethod: order.paymentMethod,
      });
    }

    emitToRoles(["admin", "employee"], SOCKET_EVENTS.ORDER_UPDATED, { order: populated });
    emitToUser(order.customer, "delivery:delivered", { orderId: order._id });

    res.json({ message: "Entrega confirmada.", order: formatDelivery(populated) });
  } catch (err) {
    console.error("delivery.confirm:", err);
    res.status(500).json({ message: "Error al confirmar la entrega." });
  }
};

export default deliveryController;
