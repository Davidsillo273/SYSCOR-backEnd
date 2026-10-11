// Chef Panchita como despachadora de reparto.
//
// Cada vez que un pedido a domicilio queda listo en cocina (y cuando un
// repartidor se libera o entra a turno) Panchita revisa los pedidos que
// esperan repartidor y:
//
//   1. Si un repartidor ya tiene paquete asignado pero todavía no sale del
//      local, le suma los pedidos que le quedan de camino.
//   2. Con lo que sobra arma paquetes nuevos, agrupando los domicilios que
//      quedan cerca entre sí, y le asigna cada paquete al repartidor libre
//      que lleva más tiempo esperando.
//
// "Libre" = repartidor activo, con "En turno" encendido en la app y sin
// paquete asignado ni en ruta. Si no hay nadie libre los pedidos se quedan
// en la cola y se asignan en cuanto alguien se libera.
//
// El análisis es geográfico y determinista (distancias en línea recta por un
// factor de calles, el mismo que usa etaUtils): así el resultado es siempre
// explicable y no depende de que responda un servicio externo.
import Order from "../../models/orders/orderModel.js";
import DeliveryBatch from "../../models/orders/deliveryBatchModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { BRANCH } from "../../constants/branch.js";
import { haversineKm } from "./etaUtils.js";
import google, { hasGoogleKey } from "./googleMapsUtils.js";
import free from "./freeMapsUtils.js";
import { orderCode } from "../orders/orderCodeUtils.js";
import { emitToRoles, emitToTypes, emitToUser, SOCKET_EVENTS } from "../../config/socket.js";
import { notifyEmployee } from "../notifications/employeeNotificationUtils.js";

// --- Reglas del agrupamiento ---
// Máximo de paradas por paquete: más que esto y el primer cliente espera
// demasiado su comida.
export const MAX_STOPS = 3;
// Un domicilio solo se suma a un paquete si queda a esta distancia (o menos)
// de alguna de sus paradas.
export const GROUP_RADIUS_KM = 3;
// ...y si sumarlo alarga el recorrido del paquete, como mucho, esto.
export const MAX_DETOUR_KM = 2.5;
// Factor de calles sobre la línea recta, el mismo que usa etaUtils.
export const STREET_FACTOR = 1.4;

const BRANCH_POINT = { latitude: BRANCH.latitude, longitude: BRANCH.longitude };

// Pedido a domicilio listo en cocina que todavía no tiene repartidor.
export const QUEUE_FILTER = {
  isDelivery: true,
  status: "ready",
  driver: null,
  deliveryStatus: { $in: [null, "available"] },
};

// Estados de reparto en los que el repartidor está ocupado.
export const BUSY_DELIVERY_STATUSES = ["accepted", "on_route"];

const round1 = (n) => Math.round(n * 10) / 10;

const validPoint = (point) =>
  Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)
    ? { latitude: point.latitude, longitude: point.longitude }
    : null;

// Coordenadas guardadas para la entrega, o las que ya geocodificó Panchita.
export const destinationOf = (order) => validPoint(order.deliveryLocation) || validPoint(order.eta?.destination);

// Geocodifica el domicilio una sola vez y lo guarda en el pedido.
export const ensureDestination = async (order) => {
  if (destinationOf(order) || !order.deliveryAddress) return;
  try {
    const point =
      (hasGoogleKey() ? await google.geocodeAddress(order.deliveryAddress) : null) ||
      (await free.geocodeAddress(order.deliveryAddress));
    if (!validPoint(point)) return;
    await Order.updateOne({ _id: order._id }, { $set: { deliveryLocation: point } });
    order.deliveryLocation = point;
  } catch (err) {
    console.error("dispatch.ensureDestination:", err.message);
  }
};

const streetKm = (a, b) => haversineKm(a, b) * STREET_FACTOR;

/**
 * Orden de entrega de un grupo de pedidos: desde el local, siempre al
 * domicilio más cercano que falte (vecino más cercano). Con 3 paradas como
 * máximo da prácticamente el mismo resultado que probar todas las
 * combinaciones. Los pedidos sin coordenadas van al final.
 *
 * Devuelve { orders (en orden de entrega), km } — km es null si ninguna
 * parada tiene coordenadas.
 */
export const planRoute = (orders) => {
  const located = orders.filter((o) => destinationOf(o));
  const unlocated = orders.filter((o) => !destinationOf(o));

  const ordered = [];
  let km = 0;
  let current = BRANCH_POINT;
  const pending = [...located];
  while (pending.length > 0) {
    let best = 0;
    let bestKm = Infinity;
    pending.forEach((o, i) => {
      const d = streetKm(current, destinationOf(o));
      if (d < bestKm) { bestKm = d; best = i; }
    });
    const [next] = pending.splice(best, 1);
    ordered.push(next);
    km += bestKm;
    current = destinationOf(next);
  }

  return { orders: [...ordered, ...unlocated], km: located.length ? round1(km) : null };
};

// Distancia (por calle) del pedido a la parada más cercana del grupo.
const nearestStopKm = (group, order) => {
  const point = destinationOf(order);
  return Math.min(...group.map((o) => streetKm(destinationOf(o), point)));
};

/**
 * ¿Se puede sumar `candidate` a un grupo? Solo si todo tiene coordenadas,
 * queda cerca de alguna parada y no alarga demasiado el recorrido.
 * Devuelve { ok, nearKm, detourKm }.
 */
export const evaluateJoin = (group, candidate) => {
  if (group.length >= MAX_STOPS) return { ok: false };
  if (!destinationOf(candidate) || group.some((o) => !destinationOf(o))) return { ok: false };

  const nearKm = nearestStopKm(group, candidate);
  if (nearKm > GROUP_RADIUS_KM) return { ok: false, nearKm };

  const before = planRoute(group).km;
  const after = planRoute([...group, candidate]).km;
  const detourKm = round1(after - before);
  return { ok: detourKm <= MAX_DETOUR_KM, nearKm: round1(nearKm), detourKm };
};

/**
 * Agrupa los pedidos en espera. El más antiguo abre cada paquete (nadie se
 * queda atrás por estar lejos) y se le suman, del más cercano al más lejano,
 * los que pasen evaluateJoin. Devuelve los paquetes en orden de prioridad.
 */
export const buildPackages = (queue) => {
  const pending = [...queue];
  const packages = [];

  while (pending.length > 0) {
    const group = [pending.shift()];

    if (destinationOf(group[0])) {
      const candidates = pending
        .filter((o) => destinationOf(o))
        .map((o) => ({ order: o, km: streetKm(destinationOf(group[0]), destinationOf(o)) }))
        .sort((a, b) => a.km - b.km);

      for (const { order } of candidates) {
        const check = evaluateJoin(group, order);
        if (!check.ok) continue;
        group.push(order);
        pending.splice(pending.indexOf(order), 1);
        if (group.length >= MAX_STOPS) break;
      }
    }

    packages.push({ orders: group });
  }

  return packages;
};

/**
 * Explicación corta para el repartidor de por qué el paquete quedó así.
 * Recibe las paradas ya en orden de entrega.
 */
export const explainPackage = (plannedOrders) => {
  if (plannedOrders.length === 1) {
    return destinationOf(plannedOrders[0])
      ? "No hay otros domicilios listos de camino: este pedido sale solo."
      : "No pude ubicar este domicilio en el mapa: sale solo para no retrasar a otros.";
  }
  const located = plannedOrders.filter((o) => destinationOf(o));
  // Qué tan juntos están: la mayor distancia de una parada a su vecina más cercana.
  const spread = round1(Math.max(...located.map((o) => nearestStopKm(located.filter((x) => x !== o), o))));
  // Cuánto agrega juntarlos frente a ir solo al domicilio más lejano.
  const farthest = Math.max(...located.map((o) => streetKm(BRANCH_POINT, destinationOf(o))));
  const extra = round1(Math.max(planRoute(located).km - farthest, 0));
  const codes = plannedOrders.map((o) => orderCode(o)).join(" → ");
  return `Junté ${plannedOrders.length} pedidos: cada domicilio queda a ${spread} km o menos de otro `
    + `y juntarlos agrega solo ${extra} km al recorrido. Orden de entrega: ${codes}.`;
};

/**
 * Repartidores libres, el que lleva más tiempo sin salir primero (así el
 * trabajo se reparte parejo).
 */
export const findAvailableDrivers = async () => {
  const drivers = await EmployeeModel.find({
    "personalInfo.type": "delivery",
    "workInfo.status": "active",
    "workInfo.deliveryOnShift": true,
  })
    .select("personalInfo.name personalInfo.lastname workInfo.deliveryOnShiftAt")
    .lean();
  if (drivers.length === 0) return [];

  const ids = drivers.map((d) => d._id);
  const [busyBatches, busyOrders, lastTrips] = await Promise.all([
    DeliveryBatch.distinct("driver", { driver: { $in: ids }, status: { $in: ["assigned", "on_route"] } }),
    // Entregas tomadas a mano antes de que existieran los paquetes.
    Order.distinct("driver", { driver: { $in: ids }, deliveryStatus: { $in: BUSY_DELIVERY_STATUSES } }),
    DeliveryBatch.aggregate([
      { $match: { driver: { $in: ids }, status: "completed" } },
      { $group: { _id: "$driver", last: { $max: "$completedAt" } } },
    ]),
  ]);

  const busy = new Set([...busyBatches, ...busyOrders].map(String));
  const lastTripOf = new Map(lastTrips.map((t) => [String(t._id), t.last]));
  // Desde cuándo está libre: su última entrega o, si no ha salido hoy, desde
  // que entró a turno.
  const freeSince = (d) => new Date(lastTripOf.get(String(d._id)) || d.workInfo?.deliveryOnShiftAt || 0).getTime();

  return drivers
    .filter((d) => !busy.has(String(d._id)))
    .sort((a, b) => freeSince(a) - freeSince(b));
};

const driverShortName = (driver) => {
  const first = String(driver?.personalInfo?.name || "").trim().split(/\s+/)[0] || "";
  const initial = String(driver?.personalInfo?.lastname || "").trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
};

// "P-1010-03": mes y día + correlativo del día.
const nextBatchCode = async () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const count = await DeliveryBatch.countDocuments({ createdAt: { $gte: start } });
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `P-${mmdd}-${String(count + 1).padStart(2, "0")}`;
};

/**
 * Pone los pedidos a nombre del repartidor, uno por uno y de forma atómica:
 * si alguno ya lo tomó otro (o lo cancelaron) en ese instante, se omite.
 */
const claimOrders = async (orders, driverId, batchId) => {
  const claimed = [];
  for (const order of orders) {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, ...QUEUE_FILTER },
      { $set: { driver: driverId, deliveryStatus: "accepted", deliveryBatch: batchId } },
      { returnDocument: "after" }
    ).lean();
    if (updated) claimed.push(updated);
  }
  return claimed;
};

// Avisa a todos: panel (pedidos actualizados), repartidor (su paquete) y
// cocina (qué órdenes empacar juntas y para quién). `orders` son los pedidos
// nuevos del paquete; `allOrders`, el paquete completo en orden de entrega.
const announce = async (batch, driver, orders, { added = false, allOrders = orders } = {}) => {
  const populated = await Order.find({ _id: { $in: orders.map((o) => o._id) } })
    .populate("customer", "personalInfo")
    .lean();
  populated.forEach((order) => emitToRoles(["admin", "employee"], SOCKET_EVENTS.ORDER_UPDATED, { order }));

  emitToUser(batch.driver, "delivery:package_assigned", { batchId: batch._id, added });
  // Queda en su bandeja de la app y, con la app cerrada, le llega como push.
  notifyEmployee(batch.driver, {
    type: "delivery_package",
    title: added ? "Panchita sumó un pedido a tu paquete" : "Chef Panchita te asignó un paquete",
    body: `${batch.code}: ${allOrders.length} ${allOrders.length === 1 ? "entrega" : "entregas"}. Pasa por el mostrador a recogerlo.`,
    data: { batchId: String(batch._id) },
  });
  emitToTypes(["delivery"], "delivery:queue_changed", {});
  emitToRoles(["admin", "employee"], SOCKET_EVENTS.DELIVERY_PACKAGE_ASSIGNED, {
    deliveryPackage: {
      code: batch.code,
      kitchenNumbers: populated.map((o) => o.kitchenNumber),
      orderCodes: populated.map((o) => orderCode(o)),
      packageKitchenNumbers: allOrders.map((o) => o.kitchenNumber),
      packageOrderCodes: allOrders.map((o) => orderCode(o)),
      driverName: driverShortName(driver),
      added,
    },
  });
};

/**
 * Paso 1: sumar pedidos a paquetes que todavía no salen del local.
 * Devuelve los pedidos de la cola que no se pudieron sumar.
 */
const topUpOpenBatches = async (queue) => {
  const open = await DeliveryBatch.find({ status: "assigned" }).populate("driver", "personalInfo").lean();
  if (open.length === 0) return queue;

  let remaining = [...queue];
  for (const batch of open) {
    if (batch.stops.length >= MAX_STOPS) continue;
    let group = await Order.find({ _id: { $in: batch.stops.map((s) => s.order) } }).lean();
    const added = [];

    for (const candidate of [...remaining]) {
      if (!evaluateJoin(group, candidate).ok) continue;
      const [claimed] = await claimOrders([candidate], batch.driver._id, batch._id);
      remaining = remaining.filter((o) => String(o._id) !== String(candidate._id));
      if (!claimed) continue;
      group = [...group, claimed];
      added.push(claimed);
      if (group.length >= MAX_STOPS) break;
    }

    if (added.length === 0) continue;
    const plan = planRoute(group);
    await DeliveryBatch.updateOne(
      { _id: batch._id },
      {
        $set: {
          stops: plan.orders.map((o, i) => ({ order: o._id, sequence: i + 1 })),
          distanceKm: plan.km,
          reason: `${explainPackage(plan.orders)} Sumé ${added.length === 1 ? "un pedido que quedó listo" : `${added.length} pedidos que quedaron listos`} de camino antes de que salieras.`,
        },
      }
    );
    await announce(batch, batch.driver, added, { added: true, allOrders: plan.orders });
  }
  return remaining;
};

/** Paso 2: paquetes nuevos para los repartidores libres. */
const assignNewPackages = async (queue) => {
  if (queue.length === 0) return [];
  const drivers = await findAvailableDrivers();
  if (drivers.length === 0) return [];

  const created = [];
  const packages = buildPackages(queue);

  for (const pkg of packages) {
    const driver = drivers.shift();
    if (!driver) break;

    const batch = await DeliveryBatch.create({ code: await nextBatchCode(), driver: driver._id, stops: [] });
    const claimed = await claimOrders(pkg.orders, driver._id, batch._id);
    if (claimed.length === 0) {
      // Todo se lo llevaron en ese instante: el repartidor sigue libre.
      await DeliveryBatch.deleteOne({ _id: batch._id });
      drivers.unshift(driver);
      continue;
    }

    const plan = planRoute(claimed);
    const reason = explainPackage(plan.orders);
    const saved = await DeliveryBatch.findByIdAndUpdate(
      batch._id,
      {
        $set: {
          stops: plan.orders.map((o, i) => ({ order: o._id, sequence: i + 1 })),
          distanceKm: plan.km,
          reason,
        },
      },
      { returnDocument: "after" }
    ).lean();

    await announce(saved, driver, claimed, { allOrders: plan.orders });
    created.push(saved);
  }
  return created;
};

// Cuándo quedó listo en cocina (la última vez que pasó a "ready").
export const readyAtOf = (order) => {
  const entry = [...(order.statusHistory || [])].reverse().find((h) => h.status === "ready");
  return new Date(entry?.changedAt || order.updatedAt || 0).getTime();
};

const runDispatch = async () => {
  // El que lleva más tiempo listo, primero. No se ordena por updatedAt: un
  // pedido que vuelve a la cola (su repartidor salió de turno) se "tocó"
  // recién, pero lleva esperando desde que cocina lo terminó.
  const queue = (await Order.find(QUEUE_FILTER).limit(50).lean()).sort((a, b) => readyAtOf(a) - readyAtOf(b));
  if (queue.length === 0) return { created: 0 };

  // Sin coordenadas no hay forma de agrupar: se geocodifica una sola vez.
  for (const order of queue) await ensureDestination(order);

  const remaining = await topUpOpenBatches(queue);
  const created = await assignNewPackages(remaining);
  return { created: created.length };
};

// Una sola revisión a la vez: si llega otro aviso mientras corre, se repite
// una vez al terminar (en vez de correr dos en paralelo y pelear por los
// mismos pedidos).
let running = null;
let rerun = false;

export const dispatchDeliveries = async (trigger = "manual") => {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    let result = { created: 0 };
    try {
      do {
        rerun = false;
        result = await runDispatch();
      } while (rerun);
    } catch (err) {
      console.error(`dispatchDeliveries (${trigger}):`, err);
    } finally {
      running = null;
    }
    return result;
  })();
  return running;
};

/**
 * El repartidor salió de turno con un paquete asignado que todavía no sale:
 * sus pedidos vuelven a la cola para que Panchita se los dé a otro.
 */
export const releaseAssignedBatch = async (driverId) => {
  const batch = await DeliveryBatch.findOneAndUpdate(
    { driver: driverId, status: "assigned" },
    { $set: { status: "cancelled", completedAt: new Date() } },
    { returnDocument: "after" }
  ).lean();
  if (!batch) return false;

  await Order.updateMany(
    { _id: { $in: batch.stops.map((s) => s.order) }, deliveryStatus: "accepted" },
    { $set: { driver: null, deliveryStatus: "available", deliveryBatch: null } }
  );
  emitToTypes(["delivery"], "delivery:queue_changed", {});
  return true;
};

/**
 * Un pedido sale de su paquete: se canceló, o cocina lo regresó a
 * preparación antes de que el repartidor saliera. Si el paquete se queda sin
 * paradas pendientes, se cierra y el repartidor queda libre.
 */
export const detachOrderFromBatch = async (order) => {
  if (!order?.deliveryBatch) return;
  const batch = await DeliveryBatch.findByIdAndUpdate(
    order.deliveryBatch,
    { $pull: { stops: { order: order._id } } },
    { returnDocument: "after" }
  ).lean();
  // Sin estado de reparto: si no, el repartidor seguiría contando como
  // ocupado. Si todavía no salía con él, tampoco queda a su nombre (cuando
  // vuelva a estar listo, Panchita lo asigna de nuevo).
  const unset = { deliveryBatch: null, deliveryStatus: null };
  if (order.deliveryStatus === "accepted") unset.driver = null;
  await Order.updateOne({ _id: order._id }, { $set: unset });
  if (batch) {
    await DeliveryBatch.updateOne(
      { _id: batch._id },
      { $set: { stops: batch.stops.map((st, i) => ({ order: st.order, sequence: i + 1 })) } }
    );
    await closeBatchIfDone(batch._id);
  }
};

/**
 * Cierra el paquete cuando ya no le quedan paradas por entregar y vuelve a
 * despachar (el repartidor queda libre). Devuelve true si lo cerró.
 */
export const closeBatchIfDone = async (batchId) => {
  const batch = await DeliveryBatch.findById(batchId).lean();
  if (!batch || ["completed", "cancelled"].includes(batch.status)) return false;

  const pending = await Order.countDocuments({
    _id: { $in: batch.stops.map((s) => s.order) },
    deliveryStatus: { $in: BUSY_DELIVERY_STATUSES },
  });
  if (pending > 0) return false;

  await DeliveryBatch.updateOne(
    { _id: batchId },
    { $set: { status: batch.stops.length > 0 ? "completed" : "cancelled", completedAt: new Date() } }
  );
  dispatchDeliveries("driver_free");
  return true;
};

export default {
  dispatchDeliveries,
  releaseAssignedBatch,
  detachOrderFromBatch,
  closeBatchIfDone,
  planRoute,
  buildPackages,
  evaluateJoin,
  explainPackage,
  findAvailableDrivers,
  destinationOf,
  ensureDestination,
};
