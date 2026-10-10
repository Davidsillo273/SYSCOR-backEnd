import Order from "../../models/orders/orderModel.js";
import { BRANCH } from "../../constants/branch.js";
import cloudinaryUtils from "../../utils/cloudinaryUtils.js";
import { haversineKm } from "../../utils/panchita/etaUtils.js";
import google, { hasGoogleKey } from "../../utils/panchita/googleMapsUtils.js";
import free from "../../utils/panchita/freeMapsUtils.js";
import { applyOrderStatus } from "./orderController.js";
import { emitToRoles, emitToTypes, emitToUser, SOCKET_EVENTS } from "../../config/socket.js";

// Reparto interno del restaurante: los repartidores son empleados del local.
// Cuando cocina termina un pedido a domicilio entra a la cola, el repartidor
// inicia la entrega (queda a su nombre para que nadie más salga con el mismo
// pedido), sigue la ruta y confirma al entregar. Solo cobra los pedidos de
// pago al recibir (efectivo o tarjeta en POS); los pagados en línea no.
const deliveryController = {};

const DELIVERY_POPULATE = [
  { path: "customer", select: "personalInfo.name personalInfo.lastname personalInfo.phones" },
  { path: "driver", select: "personalInfo.name personalInfo.lastname" },
];

const ACTIVE_STATUSES = ["accepted", "on_route"];

// Cola: pedido a domicilio listo en cocina que todavía no sale. Los pedidos
// que quedaron listos antes de existir deliveryStatus lo traen vacío.
const QUEUE_FILTER = {
  isDelivery: true,
  status: "ready",
  driver: null,
  deliveryStatus: { $in: [null, "available"] },
};

const PAY_ON_DELIVERY = ["cash", "card_on_delivery"];

// Lo que el repartidor cobra en la puerta: lo que no cubrió el saldo a favor.
// Lo agregado después ("Agregar más productos") siempre se paga en línea.
const amountToCollect = (order) => {
  if (!PAY_ON_DELIVERY.includes(order.paymentMethod) || order.paymentStatus === "paid") return 0;
  const charge = order.payment?.amount ?? (order.total || 0) - (order.payment?.creditApplied || 0);
  return Math.max(Math.round(charge * 100) / 100, 0);
};

// Factor de calles sobre la línea recta, el mismo que usa etaUtils.
const STREET_FACTOR = 1.4;

const extractPhone = (customer) => {
  const phones = customer?.personalInfo?.phones;
  if (Array.isArray(phones) && phones.length > 0) {
    const first = phones[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.number || first.phone || null;
  }
  return null;
};

const fullName = (person) => `${person?.name || ""} ${person?.lastname || ""}`.trim();

const lastStatusAt = (order, status) =>
  [...(order.statusHistory || [])].reverse().find((h) => h.status === status)?.changedAt || null;

const validPoint = (point) =>
  Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)
    ? { latitude: point.latitude, longitude: point.longitude }
    : null;

// Coordenadas guardadas para la entrega, o las que ya geocodificó Panchita.
const destinationOf = (order) => validPoint(order.deliveryLocation) || validPoint(order.eta?.destination);

// Geocodifica el domicilio una sola vez y lo guarda en el pedido.
const ensureDestination = async (order) => {
  if (destinationOf(order) || !order.deliveryAddress) return;
  try {
    const point =
      (hasGoogleKey() ? await google.geocodeAddress(order.deliveryAddress) : null) ||
      (await free.geocodeAddress(order.deliveryAddress));
    if (!validPoint(point)) return;
    await Order.updateOne({ _id: order._id }, { $set: { deliveryLocation: point } });
    order.deliveryLocation = point;
  } catch (err) {
    console.error("delivery.ensureDestination:", err.message);
  }
};

// Minutos de camino (tráfico y clima), sin el tiempo de cocina.
const travelMinutesOf = (order) => {
  const minutes = (order.eta?.factors || [])
    .filter((f) => f.type !== "kitchen")
    .reduce((sum, f) => sum + (Number(f.minutes) || 0), 0);
  return minutes > 0 ? minutes : null;
};

const formatDelivery = (order) => {
  const customer = order.customer;
  const destination = destinationOf(order);
  const origin = { latitude: BRANCH.latitude, longitude: BRANCH.longitude };
  const distanceKm = destination
    ? Math.round(haversineKm(origin, destination) * STREET_FACTOR * 10) / 10
    : null;
  const lastMessage = order.driverMessages?.[order.driverMessages.length - 1];

  return {
    id: order._id,
    code: order.code ? `#${order.code}` : `#D-${String(order._id).slice(-3).toUpperCase()}`,
    status: order.deliveryStatus || "available",
    customer: {
      name: fullName(customer?.personalInfo) || fullName(order.contact) || "Cliente",
      phone: extractPhone(customer),
    },
    receivedBy: fullName(order.receivedBy) || null,
    items: (order.items || []).map((i) => ({ id: i._id, quantity: i.quantity, name: i.name })),
    note: order.notes || null,
    total: order.total || 0,
    paymentMethod: order.paymentMethod,
    amountToCollect: amountToCollect(order),
    collectedAmount: order.payment?.collectedAmount || 0,
    pickup: {
      name: BRANCH.name,
      address: BRANCH.address,
      detail: `${BRANCH.address} · mostrador de reparto`,
      latitude: BRANCH.latitude,
      longitude: BRANCH.longitude,
    },
    dropoff: {
      address: order.deliveryAddress || "Sin dirección",
      detail: lastMessage?.text || null,
      latitude: destination?.latitude ?? null,
      longitude: destination?.longitude ?? null,
    },
    distanceKm,
    etaMinutes: travelMinutesOf(order),
    deliveryMethod: order.deliveryMethod || null,
    driverNote: order.driverNote || null,
    deliveryProof: order.deliveryProof || null,
    readyAt: lastStatusAt(order, "ready"),
    startedAt: lastStatusAt(order, "on_route"),
    deliveredAt: lastStatusAt(order, "delivered") || (order.deliveryStatus === "delivered" ? order.updatedAt : null),
    createdAt: order.createdAt,
  };
};

const findPopulated = (id) => Order.findById(id).populate(DELIVERY_POPULATE).lean();

// GET /orders/delivery/queue
// Pedidos a domicilio listos para salir, el que lleva más tiempo esperando primero.
deliveryController.getQueue = async (req, res) => {
  try {
    const orders = await Order.find(QUEUE_FILTER)
      .populate(DELIVERY_POPULATE)
      .sort({ updatedAt: 1 })
      .lean();

    res.json(orders.map(formatDelivery));
  } catch (err) {
    console.error("delivery.getQueue:", err);
    res.status(500).json({ message: "Error al obtener los pedidos por entregar." });
  }
};

// GET /orders/delivery/mine
// La entrega que el repartidor con sesión lleva en camino.
deliveryController.getMine = async (req, res) => {
  try {
    const active = await Order.findOne({ driver: req.user.id, deliveryStatus: { $in: ACTIVE_STATUSES } })
      .populate(DELIVERY_POPULATE)
      .lean();

    if (active) await ensureDestination(active);
    res.json(active ? formatDelivery(active) : null);
  } catch (err) {
    console.error("delivery.getMine:", err);
    res.status(500).json({ message: "Error al obtener tu entrega en curso." });
  }
};

// GET /orders/delivery/history
// Últimas 30 entregas completadas por este repartidor.
deliveryController.getHistory = async (req, res) => {
  try {
    const orders = await Order.find({ driver: req.user.id, deliveryStatus: "delivered" })
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

// PATCH /orders/delivery/:id/start
// El repartidor sale con el pedido: queda a su nombre y deja la cola.
deliveryController.start = async (req, res) => {
  try {
    const hasActive = await Order.exists({ driver: req.user.id, deliveryStatus: { $in: ACTIVE_STATUSES } });
    if (hasActive) {
      return res.status(400).json({
        message: "Ya tienes una entrega en camino. Termínala antes de salir con otro pedido.",
      });
    }

    // Una sola operación: si dos repartidores tocan el mismo pedido, solo uno sale con él.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, ...QUEUE_FILTER },
      {
        $set: { driver: req.user.id, deliveryStatus: "on_route" },
        $push: { statusHistory: { status: "on_route", changedAt: new Date() } },
      },
      { new: true }
    );

    if (!order) {
      return res.status(409).json({ message: "Otro repartidor ya salió con este pedido." });
    }

    const populated = await findPopulated(order._id);
    await ensureDestination(populated);

    emitToRoles(["admin", "employee"], SOCKET_EVENTS.ORDER_UPDATED, { order: populated });
    emitToTypes(["delivery"], "delivery:started", { orderId: order._id });
    if (order.customer) emitToUser(order.customer, "delivery:on_route", { orderId: order._id });

    res.json(formatDelivery(populated));
  } catch (err) {
    console.error("delivery.start:", err);
    res.status(500).json({ message: "Error al iniciar la entrega." });
  }
};

// PATCH /orders/delivery/:id/confirm
// El repartidor confirma que entregó el pedido. El cambio a "delivered" pasa
// por applyOrderStatus para facturar y avisar al cliente igual que siempre.
// Si era de pago al recibir, el repartidor ya cobró: queda pagado.
deliveryController.confirm = async (req, res) => {
  try {
    const { deliveryMethod, driverNote } = req.body || {};

    if (deliveryMethod && !["hand", "reception"].includes(deliveryMethod)) {
      await cloudinaryUtils.deletePreviousImage(req.file?.path);
      return res.status(400).json({ message: "deliveryMethod debe ser 'hand' o 'reception'." });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, driver: req.user.id, deliveryStatus: "on_route" },
      {
        $set: {
          deliveryStatus: "delivered",
          deliveryMethod: deliveryMethod || "hand",
          driverNote: String(driverNote || "").trim().slice(0, 300) || null,
          deliveryProof: req.file?.path || null,
        },
      },
      { new: true }
    );

    if (!order) {
      await cloudinaryUtils.deletePreviousImage(req.file?.path);
      return res.status(404).json({ message: "No encontramos esta entrega en camino." });
    }

    const collected = amountToCollect(order);
    if (collected > 0) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentStatus: "paid",
            "payment.collectedBy": req.user.id,
            "payment.collectedAmount": collected,
            "payment.collectedAt": new Date(),
          },
        }
      );
    }

    const result = await applyOrderStatus({ orderId: order._id, status: "delivered", user: req.user });
    if (result.code !== 200) return res.status(result.code).json(result.body);

    const populated = await findPopulated(order._id);
    if (order.customer) emitToUser(order.customer, "delivery:delivered", { orderId: order._id });

    res.json({ message: "Entrega confirmada.", order: formatDelivery(populated) });
  } catch (err) {
    console.error("delivery.confirm:", err);
    res.status(500).json({ message: "Error al confirmar la entrega." });
  }
};

export default deliveryController;
