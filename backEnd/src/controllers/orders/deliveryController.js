import Order from "../../models/orders/orderModel.js";
import DeliveryBatch from "../../models/orders/deliveryBatchModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { BRANCH } from "../../constants/branch.js";
import cloudinaryUtils from "../../utils/cloudinaryUtils.js";
import { haversineKm } from "../../utils/panchita/etaUtils.js";
import {
  QUEUE_FILTER,
  BUSY_DELIVERY_STATUSES,
  STREET_FACTOR,
  destinationOf,
  ensureDestination,
  planRoute,
  dispatchDeliveries,
  releaseAssignedBatch,
  closeBatchIfDone,
  readyAtOf,
} from "../../utils/panchita/dispatchUtils.js";
import { applyOrderStatus } from "./orderController.js";
import { emitToRoles, emitToTypes, emitToUser, SOCKET_EVENTS } from "../../config/socket.js";

// Reparto interno del restaurante: los repartidores son empleados del local.
// Cuando cocina termina un pedido a domicilio, Chef Panchita lo agrupa con
// otros domicilios cercanos en un PAQUETE y se lo asigna a un repartidor en
// turno que no esté en ruta (ver utils/panchita/dispatchUtils.js). El
// repartidor sale con el paquete, sigue las paradas en orden y confirma cada
// entrega. Solo cobra los pedidos de pago al recibir (efectivo o tarjeta en
// POS); los pagados en línea no.
const deliveryController = {};

const DELIVERY_POPULATE = [
  { path: "customer", select: "personalInfo.name personalInfo.lastname personalInfo.phones" },
  { path: "driver", select: "personalInfo.name personalInfo.lastname" },
];

const PAY_ON_DELIVERY = ["cash", "card_on_delivery"];

// Lo que el repartidor cobra en la puerta: lo que no cubrió el saldo a favor.
// Lo agregado después ("Agregar más productos") siempre se paga en línea.
const amountToCollect = (order) => {
  if (!PAY_ON_DELIVERY.includes(order.paymentMethod) || order.paymentStatus === "paid") return 0;
  const charge = order.payment?.amount ?? (order.total || 0) - (order.payment?.creditApplied || 0);
  return Math.max(Math.round(charge * 100) / 100, 0);
};

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
      .lean();

    res.json(orders.sort((a, b) => readyAtOf(a) - readyAtOf(b)).map(formatDelivery));
  } catch (err) {
    console.error("delivery.getQueue:", err);
    res.status(500).json({ message: "Error al obtener los pedidos por entregar." });
  }
};

// Paquete que el repartidor tiene asignado o en ruta, con sus paradas en
// orden. Las entregas que se tomaron a mano antes de que existieran los
// paquetes se devuelven como un paquete de una sola parada.
const findDriverPackage = async (driverId) => {
  const batch = await DeliveryBatch.findOne({ driver: driverId, status: { $in: ["assigned", "on_route"] } }).lean();

  if (!batch) {
    const legacy = await Order.findOne({ driver: driverId, deliveryStatus: { $in: BUSY_DELIVERY_STATUSES }, deliveryBatch: null })
      .populate(DELIVERY_POPULATE)
      .lean();
    if (!legacy) return null;
    await ensureDestination(legacy);
    const stop = { ...formatDelivery(legacy), sequence: 1 };
    return {
      id: null,
      code: stop.code,
      status: legacy.deliveryStatus === "on_route" ? "on_route" : "assigned",
      reason: null,
      distanceKm: stop.distanceKm,
      startedAt: stop.startedAt,
      stops: [stop],
      currentStopId: stop.id,
    };
  }

  const orders = await Order.find({ _id: { $in: batch.stops.map((st) => st.order) } })
    .populate(DELIVERY_POPULATE)
    .lean();
  for (const order of orders) await ensureDestination(order);

  const sequenceOf = new Map(batch.stops.map((st) => [String(st.order), st.sequence]));
  const stops = orders
    .map((order) => ({ ...formatDelivery(order), sequence: sequenceOf.get(String(order._id)) }))
    .sort((a, b) => a.sequence - b.sequence);
  const current = stops.find((st) => st.status !== "delivered");

  return {
    id: batch._id,
    code: batch.code,
    status: batch.status,
    reason: batch.reason,
    distanceKm: batch.distanceKm,
    startedAt: batch.startedAt,
    stops,
    currentStopId: current?.id || null,
  };
};

// GET /orders/delivery/package
deliveryController.getPackage = async (req, res) => {
  try {
    res.json(await findDriverPackage(req.user.id));
  } catch (err) {
    console.error("delivery.getPackage:", err);
    res.status(500).json({ message: "Error al obtener tu paquete de entregas." });
  }
};

// GET /orders/delivery/mine
// La parada que el repartidor tiene que entregar ahora.
deliveryController.getMine = async (req, res) => {
  try {
    const pkg = await findDriverPackage(req.user.id);
    res.json(pkg?.stops.find((st) => String(st.id) === String(pkg.currentStopId)) || null);
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

// Saca a ruta todas las paradas del paquete: quedan "on_route" y el
// cliente de cada una recibe el aviso.
const departPackage = async (batch) => {
  const now = new Date();
  await DeliveryBatch.updateOne({ _id: batch._id }, { $set: { status: "on_route", startedAt: now } });
  const ids = batch.stops.map((st) => st.order);
  await Order.updateMany(
    { _id: { $in: ids }, deliveryStatus: "accepted" },
    {
      $set: { deliveryStatus: "on_route" },
      $push: { statusHistory: { status: "on_route", changedAt: now } },
    }
  );

  const orders = await Order.find({ _id: { $in: ids } }).populate(DELIVERY_POPULATE).lean();
  orders.forEach((order) => {
    emitToRoles(["admin", "employee"], SOCKET_EVENTS.ORDER_UPDATED, { order });
    if (order.customer) emitToUser(order.customer._id || order.customer, "delivery:on_route", { orderId: order._id });
  });
};

// PATCH /orders/delivery/package/start
// El repartidor sale del local con su paquete.
deliveryController.startPackage = async (req, res) => {
  try {
    const batch = await DeliveryBatch.findOne({ driver: req.user.id, status: "assigned" }).lean();
    if (!batch) {
      return res.status(404).json({ message: "No tienes un paquete esperando salir." });
    }
    await departPackage(batch);
    res.json(await findDriverPackage(req.user.id));
  } catch (err) {
    console.error("delivery.startPackage:", err);
    res.status(500).json({ message: "Error al salir a ruta." });
  }
};

// PATCH /orders/delivery/:id/start
// Respaldo manual: tomar un pedido de la cola cuando el repartidor no tiene
// paquete (ej. estaba fuera de turno cuando Panchita repartió). Sale como un
// paquete de una parada. Si el pedido ya es de su paquete, sale con el
// paquete completo.
deliveryController.start = async (req, res) => {
  try {
    const own = await DeliveryBatch.findOne({ driver: req.user.id, status: { $in: ["assigned", "on_route"] } }).lean();
    if (own) {
      const isMine = own.stops.some((st) => String(st.order) === String(req.params.id));
      if (!isMine) {
        return res.status(400).json({
          message: "Ya tienes un paquete de entregas. Termínalo antes de tomar otro pedido.",
        });
      }
      if (own.status === "assigned") await departPackage(own);
      return res.json(await findDriverPackage(req.user.id));
    }

    const hasActive = await Order.exists({ driver: req.user.id, deliveryStatus: { $in: BUSY_DELIVERY_STATUSES } });
    if (hasActive) {
      return res.status(400).json({
        message: "Ya tienes una entrega en camino. Termínala antes de salir con otro pedido.",
      });
    }

    const batch = await DeliveryBatch.create({
      code: `M-${String(req.params.id).slice(-4).toUpperCase()}`,
      driver: req.user.id,
      stops: [{ order: req.params.id, sequence: 1 }],
      reason: "Tomaste este pedido de la cola por tu cuenta.",
    });

    // Una sola operación: si dos repartidores tocan el mismo pedido, solo uno sale con él.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, ...QUEUE_FILTER },
      { $set: { driver: req.user.id, deliveryStatus: "accepted", deliveryBatch: batch._id } },
      { new: true }
    );

    if (!order) {
      await DeliveryBatch.deleteOne({ _id: batch._id });
      return res.status(409).json({ message: "Otro repartidor ya salió con este pedido." });
    }

    await ensureDestination(order);
    await DeliveryBatch.updateOne({ _id: batch._id }, { $set: { distanceKm: planRoute([order]).km } });
    await departPackage(batch);
    emitToTypes(["delivery"], "delivery:started", { orderId: order._id });

    res.json(await findDriverPackage(req.user.id));
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

    // Última parada del paquete: el repartidor queda libre y Panchita le
    // puede asignar lo que esté esperando.
    if (order.deliveryBatch) await closeBatchIfDone(order.deliveryBatch);
    else dispatchDeliveries("driver_free");

    res.json({
      message: "Entrega confirmada.",
      order: formatDelivery(populated),
      package: await findDriverPackage(req.user.id),
    });
  } catch (err) {
    console.error("delivery.confirm:", err);
    res.status(500).json({ message: "Error al confirmar la entrega." });
  }
};

// GET /orders/delivery/availability
deliveryController.getAvailability = async (req, res) => {
  try {
    const employee = await EmployeeModel.findById(req.user.id).select("workInfo.deliveryOnShift").lean();
    res.json({ onShift: Boolean(employee?.workInfo?.deliveryOnShift) });
  } catch (err) {
    console.error("delivery.getAvailability:", err);
    res.status(500).json({ message: "Error al consultar tu turno." });
  }
};

// PATCH /orders/delivery/availability  { onShift: boolean }
// El interruptor "En turno" de la app. Al entrar, Panchita le asigna lo que
// esté esperando; al salir con un paquete que todavía no sale del local, esos
// pedidos vuelven a la cola para otro repartidor. Si ya va en ruta, termina
// su paquete y después ya no recibe más.
deliveryController.setAvailability = async (req, res) => {
  try {
    const { onShift } = req.body || {};
    if (typeof onShift !== "boolean") {
      return res.status(400).json({ message: "onShift debe ser true o false." });
    }

    await EmployeeModel.updateOne(
      { _id: req.user.id },
      { $set: { "workInfo.deliveryOnShift": onShift, "workInfo.deliveryOnShiftAt": new Date() } }
    );

    let released = false;
    if (!onShift) released = await releaseAssignedBatch(req.user.id);
    if (onShift || released) await dispatchDeliveries(onShift ? "driver_on_shift" : "driver_off_shift");

    res.json({ onShift, released, package: await findDriverPackage(req.user.id) });
  } catch (err) {
    console.error("delivery.setAvailability:", err);
    res.status(500).json({ message: "Error al cambiar tu turno." });
  }
};

export default deliveryController;
