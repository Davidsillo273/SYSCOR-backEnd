import bcryptjs from "bcryptjs";
import Order from "../../models/orders/orderModel.js";
import { WAITER_POPULATE, employeeName } from "../../utils/orders/waiterPopulate.js";
import Invoice from "../../models/orders/invoiceModel.js";
import Combos from "../../models/menu/combosModel.js";
import Drinks from "../../models/menu/drinksModel.js";
import Extras from "../../models/menu/extrasModel.js";
import Saucers from "../../models/menu/saucersModel.js";
import { buildItems } from "./checkoutController.js";
import TablesModel from "../../models/tables/tablesModel.js";
import AdminModel from "../../models/users/adminModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { resolvePeriodRange, buildDateMatch } from "../../utils/orders/periodUtils.js";
// Tiempo real: cocina y el panel de pedidos reflejan cada comanda nueva o
// cambio de estado al instante, sin recargar ni sondear.
import { emitToRoles, emitToTypes, SOCKET_EVENTS } from "../../config/socket.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { notifyOrderStatus } from "../../utils/notifications/pushUtils.js";
import { notifyWaiterOrderReady } from "../../utils/notifications/employeeNotificationUtils.js";
import { isChatOrder, chatSummary } from "../../utils/orders/orderChatUtils.js";
import Claim from "../../models/orders/claimModel.js";
import { creditWallet, orderRef } from "../../utils/wallet/walletUtils.js";
import { cancelReservationOfOrder, syncReservations, publicTable } from "../../utils/tables/reservationUtils.js";
import { HOLD_MS, canHold, publicHold, notOnHoldFilter, releaseExpiredHolds, emitOrder } from "../../utils/orders/orderHoldUtils.js";
import { dispatchDeliveries, detachOrderFromBatch } from "../../utils/panchita/dispatchUtils.js";
import { isCashierOpen } from "../../utils/cashier/cashierStatusUtils.js";

const orderController = {};

// Mismo público que ya define notificationUtils para la categoría "orders":
// las comandas las ven el administrador y el personal.
const ORDERS_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.orders;

const ONE_HOUR_MS = 60 * 60 * 1000;

// Revisa los pedidos "preparing" y marca como "atrasado" los que llevan más
// de 1 hora sin pasar a "ready". Se ejecuta cada vez que se listan pedidos,
// para no depender de un cron/proceso en segundo plano aparte.
export const flagDelayedOrders = async () => {
  const preparingOrders = await Order.find({ status: 'preparing' });
  const cutoff = Date.now() - ONE_HOUR_MS;

  for (const order of preparingOrders) {
    const history = order.statusHistory || [];
    const lastPreparingEntry = [...history].reverse().find((h) => h.status === 'preparing');
    const since = lastPreparingEntry ? new Date(lastPreparingEntry.changedAt).getTime() : new Date(order.updatedAt).getTime();

    if (since <= cutoff) {
      order.status = 'atrasado';
      order.statusHistory.push({ status: 'atrasado', changedAt: new Date() });
      await order.save();

      // Este cambio no lo pidió nadie desde la interfaz: lo decide el propio
      // servidor. Sin avisarlo por socket, el panel mostraría la comanda como
      // "preparing" hasta que alguien recargara la pantalla.
      const populated = await Order.findById(order._id)
        .populate('table', 'number status')
        .populate(WAITER_POPULATE)
        .populate('customer', 'personalInfo');

      if (populated) {
        emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: populated.toObject() });
      }
    }
  }
};

// Arma el registro de facturación (colección "invoices") a partir de un
// pedido recién entregado. Se llama una sola vez, cuando el estado pasa a
// "delivered" por primera vez (ver updateOrderStatus).
const generateInvoice = async (order) => {
  await Invoice.create({
    order: order._id,
    orderType: order.orderType,
    orderCode: order.code,
    items: (order.items || []).map((i) => ({ name: i.name, price: i.price, quantity: i.quantity })),
    total: order.total,
    tableNumber: order.table?.number,
    waiterName: order.waiter
      ? `${order.waiter.name || ''} ${order.waiter.lastname || ''}`.trim()
      : undefined,
    customerName: order.customer?.personalInfo
      ? `${order.customer.personalInfo.name || ''} ${order.customer.personalInfo.lastname || ''}`.trim()
      : undefined,
    isDelivery: order.isDelivery,
    paymentMethod: order.paymentMethod,
  });
};

// Crear pedido. Los campos que se guardan cambian según orderType:
//   - "local": requiere mesa (debe estar "ocupada") y el mesero es quien tiene la sesión.
//   - "online": requiere cliente, y si isDelivery es true, la dirección de entrega.
// Ronda que le toca a una comanda nueva de la mesa: la siguiente a las que ya
// tiene la cuenta abierta (desde que se ocupó), o la misma de `roundOf` si es
// el segundo tiempo de un envío.
const nextRoundFor = async (tableDoc, roundOf) => {
  if (roundOf && /^[a-f\d]{24}$/i.test(String(roundOf))) {
    const sibling = await Order.findOne({ _id: roundOf, table: tableDoc._id }).select('round').lean();
    if (sibling?.round) return sibling.round;
  }
  const since = tableDoc.occupiedAt ? new Date(tableDoc.occupiedAt) : new Date(0);
  const previous = await Order.find({
    table: tableDoc._id,
    orderType: 'local',
    createdAt: { $gte: since },
    status: { $ne: 'cancelled' },
  }).select('round').sort({ createdAt: 1 }).lean();
  return previous.reduce((max, o, i) => Math.max(max, o.round || i + 1), 0) + 1;
};

orderController.createOrder = async (req, res) => {
  try {
    const { orderType, items } = req.body;

    if (!['local', 'online'].includes(orderType)) {
      return res.status(400).json({ message: "orderType debe ser 'local' u 'online'" });
    }

    const orderFields = { orderType };

    if (orderType === 'local') {
      const { table, localCustomerName, paymentMethod, customer, notes } = req.body;
      const waiter = req.user.id;

      if (!table) return res.status(400).json({ message: "La mesa es obligatoria en pedidos locales" });

      const tableDoc = await TablesModel.findById(table);
      if (!tableDoc) return res.status(404).json({ message: "Mesa no encontrada" });

      // Solo se pueden crear pedidos si la mesa está ocupada
      if (tableDoc.status !== 'ocupada') {
        return res.status(400).json({ message: "Solo se pueden tomar pedidos en mesas ocupadas" });
      }

      // Un pedido local solo admite pago con tarjeta o efectivo en caja
      if (paymentMethod && !['card', 'cash'].includes(paymentMethod)) {
        return res.status(400).json({ message: "El método de pago debe ser 'card' o 'cash' en pedidos locales" });
      }

      // Opcional: si el mesero liga la cuenta del cliente, el pedido local
      // también le aparece en "Mis pedidos" de la app de clientes.
      if (customer) {
        const customerExists = await CustomerModel.exists({ _id: customer });
        if (!customerExists) return res.status(404).json({ message: "Cliente no encontrado" });
        orderFields.customer = customer;
      }

      orderFields.table = table;
      orderFields.waiter = waiter;
      orderFields.localCustomerName = localCustomerName?.trim() || tableDoc.customerName || undefined;
      orderFields.notes = typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 300) : undefined;
      // Sin método queda "por definir": se fija al cobrar la cuenta de la mesa
      // (ver checkoutTable).
      orderFields.paymentMethod = paymentMethod || undefined;
      // Pedido del local: siempre es para comer en el restaurante.
      orderFields.fulfillment = 'dine_in';
      orderFields.isDelivery = false;
      // Ronda y tiempo (ver orderModel). El segundo tiempo de un mismo envío
      // llega con `roundOf` (el id del primero) para compartir la ronda.
      const course = [1, 2].includes(Number(req.body.course)) ? Number(req.body.course) : undefined;
      orderFields.course = course;
      orderFields.waiting = course === 2 && req.body.waitForWaiter === true;
      orderFields.round = await nextRoundFor(tableDoc, req.body.roundOf);
    } else {
      const {
        customer, isDelivery, deliveryAddress, paymentMethod,
        contact, receivedBy, scheduledFor,
      } = req.body;

      if (!customer) return res.status(400).json({ message: "El cliente es obligatorio en pedidos en línea" });
      if (isDelivery && !deliveryAddress) {
        return res.status(400).json({ message: "La dirección de entrega es obligatoria para pedidos a domicilio" });
      }
      if (paymentMethod && !['cash', 'card_on_delivery', 'online'].includes(paymentMethod)) {
        return res.status(400).json({ message: "Método de pago inválido para un pedido en línea" });
      }

      // La información de contacto se precarga del cliente, pero se puede
      // sobrescribir manualmente desde el body (ej. otro correo de contacto)
      let contactInfo = contact;
      if (!contactInfo) {
        const customerDoc = await CustomerModel.findById(customer).select("personalInfo loginInfo.email");
        if (customerDoc) {
          contactInfo = {
            name: customerDoc.personalInfo?.name || '',
            lastname: customerDoc.personalInfo?.lastname || '',
            email: customerDoc.loginInfo?.email || '',
          };
        }
      }

      orderFields.customer = customer;
      orderFields.contact = contactInfo;
      orderFields.isDelivery = !!isDelivery;
      orderFields.deliveryAddress = isDelivery ? deliveryAddress : undefined;
      orderFields.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
      orderFields.receivedBy = receivedBy?.name ? { name: receivedBy.name.trim(), lastname: (receivedBy.lastname || '').trim() } : undefined;
      orderFields.paymentMethod = paymentMethod || 'cash';
      orderFields.paymentStatus = paymentMethod === 'online' ? 'paid' : 'pending';
    }

    // Procesar items (igual para ambos tipos: se busca el producto real para
    // congelar su nombre/precio en el pedido)
    let total = 0;
    const processedItems = [];

    for (let item of items) {
      // Producto con el formato del carrito de la app de clientes
      // (productType, productId, bebida, platillos elegidos, ingredientes
      // quitados, extras...): lo manda el menú del mesero. Se arma con la
      // misma función del checkout, que recalcula los precios en la base.
      if (item?.productType) {
        const built = await buildItems([item]);
        if (built.error) {
          return res.status(400).json({ title: "No se pudo tomar la orden", message: built.error });
        }
        // Comentario libre del mesero para ese producto ("bien dorado").
        const comment = typeof item.comment === 'string' ? item.comment.trim().slice(0, 120) : '';
        if (comment && built.items[0]) {
          built.items[0].notes = [built.items[0].notes, `Nota: ${comment}`].filter(Boolean).join(' · ').slice(0, 300);
        }
        for (const line of built.items) {
          processedItems.push(line);
          total += line.price * line.quantity;
        }
        continue;
      }

      let model;
      switch (item.itemType) {
        case 'combo': model = Combos; break;
        case 'extra': model = Extras; break;
        case 'drink': model = Drinks; break;
        // Platillo suelto: lo usan la app de clientes y el menú del mesero.
        case 'saucer': model = Saucers; break;
        default: return res.status(400).json({ message: `Invalid item type: ${item.itemType}` });
      }

      const product = await model.findById(item.itemId);
      if (!product) return res.status(404).json({ message: `Product not found: ${item.itemId}` });

      const quantity = item.quantity || 1;
      const price = product.price;
      total += price * quantity;

      processedItems.push({
        itemType: item.itemType,
        itemId: item.itemId,
        name: product.name,
        price,
        quantity,
        notes: item.notes || ''
      });
    }

    const newOrder = new Order({
      ...orderFields,
      items: processedItems,
      total,
      status: 'pending',
      statusHistory: [{ status: 'pending', changedAt: new Date() }]
    });

    await newOrder.save();

    const populated = await Order.findById(newOrder._id)
      .populate('table', 'number status')
      .populate(WAITER_POPULATE)
      .populate('customer', 'personalInfo');

    // La comanda ya poblada es justo lo que muestra la pantalla de pedidos,
    // así que el frontend puede insertarla directo sin pedir la lista entera.
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_CREATED, { order: populated.toObject() });

    return res.status(201).json({ message: "Order created", data: populated });
  } catch (error) {
    console.error("Error creating order:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Obtener pedidos, con filtros opcionales por tipo (?orderType=local|online)
// y estado (?status=, admite varios separados por coma). ?from= limita a los
// pedidos creados desde esa fecha. El populate de table/waiter/customer no
// molesta aunque el pedido sea del otro tipo: simplemente queda null.
orderController.getOrders = async (req, res) => {
  try {
    await flagDelayedOrders();
    await releaseExpiredHolds();

    const filter = {};
    if (req.query.table) filter.table = req.query.table;
    if (req.query.waiter) filter.waiter = req.query.waiter;
    if (req.query.status) {
      const statuses = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }
    if (req.query.orderType) filter.orderType = req.query.orderType;
    if (req.query.from) {
      const from = new Date(req.query.from);
      if (!Number.isNaN(from.getTime())) filter.createdAt = { $gte: from };
    }
    // Pedidos programados: los que tienen una fecha/hora futura para prepararse
    if (req.query.scheduled === 'true') filter.scheduledFor = { $ne: null };

    const orders = await Order.find(filter)
      .populate('table', 'number status peopleCount floor')
      .populate(WAITER_POPULATE)
      .populate('customer', 'personalInfo loginInfo.email')
      .sort({ createdAt: -1 });

    return res.status(200).json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Pedidos del cliente con sesión ("Mis pedidos" de la app de clientes).
// Devuelve los de ambos tipos: los en línea siempre llevan `customer`, y los
// locales solo cuando el mesero ligó la cuenta del cliente. El cliente sale
// del token, nunca de la query, para que nadie pueda listar pedidos ajenos.
// Tampoco se popula el mesero ni el cliente: la app no los necesita.
// El cliente puede cancelar su pedido en línea desde la app mientras siga
// "Recibido" (pending): en cuanto cocina lo pasa a preparación ya no se
// puede, porque ya se está usando comida para él. No hay límite de tiempo:
// un pedido programado (comer en el local) se puede cancelar hasta que
// cocina lo empiece.
const CUSTOMER_CANCELLABLE_STATUSES = ['pending'];

const canCustomerCancel = (order) =>
  order.orderType === 'online' && CUSTOMER_CANCELLABLE_STATUSES.includes(order.status);

orderController.getMyOrders = async (req, res) => {
  try {
    await flagDelayedOrders();
    await syncReservations();
    await releaseExpiredHolds();

    const filter = { customer: req.user.id };
    if (['local', 'online'].includes(req.query.orderType)) filter.orderType = req.query.orderType;

    const orders = await Order.find(filter)
      .select('code hold orderType table isDelivery fulfillment reservation deliveryAddress scheduledFor paymentMethod paymentStatus payment.creditApplied items total status statusHistory cancellation rating createdAt updatedAt driver deliveryStatus driverMessages chatRead')
      .populate('table', 'number')
      .populate({ path: 'reservation', select: 'status reservedFor expiresAt partySize alias table checkedInAt', populate: { path: 'table' } })
      .sort({ createdAt: -1 });

    // Hasta cuándo se puede cancelar desde la app (null = ya no se puede).
    return res.status(200).json(
      orders.map((order) => {
        const plain = order.toObject();
        // De la mesa reservada solo lo que la app necesita (sin el QR).
        if (plain.reservation) {
          plain.reservation = {
            ...plain.reservation,
            id: String(plain.reservation._id),
            table: order.reservation.table ? publicTable(order.reservation.table) : null,
          };
        }
        // cancelDeadline queda en null para las versiones anteriores de la app
        // (que mostraban una cuenta regresiva de 15 minutos).
        return {
          ...plain,
          canCancel: canCustomerCancel(order),
          cancelDeadline: null,
          hold: publicHold(order),
          canHold: canHold(order),
          // Chat con el repartidor (solo a domicilio). Los mensajes completos
          // se piden aparte, a /orders/chat/:id.
          chat: isChatOrder(order) ? chatSummary(order, 'customer') : null,
          driverMessages: undefined,
          chatRead: undefined,
        };
      }),
    );
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Cambiar estado de un pedido. Cuando el nuevo estado es "delivered" (y no
// lo era ya), se dispara la facturación automática (ver generateInvoice).
//
// La lógica vive en applyOrderStatus para que la pantalla de cocina (KDS,
// controllers/kitchen) aplique EXACTAMENTE las mismas reglas sin copiar
// nada: lo único que cambia allá es qué estados puede pedir y qué datos de
// la comanda se le devuelven. Devuelve { code, body, order } en vez de
// responder, y quien la llama decide qué mandar.
export const applyOrderStatus = async ({ orderId, status, user }) => {
  const validStatuses = ['pending', 'preparing', 'ready', 'delivered', 'cancelled', 'atrasado'];
  if (!validStatuses.includes(status)) {
    return { code: 400, body: { message: "Invalid status" } };
  }

  // "Agregar más productos": primero se liberan las pausas vencidas, para que
  // un pedido cuyo tiempo ya terminó se pueda cocinar de inmediato.
  if (status === 'preparing') await releaseExpiredHolds();

  const previousOrder = await Order.findById(orderId).select("status hold waiting isDelivery driver deliveryStatus deliveryBatch");
  if (!previousOrder) return { code: 404, body: { message: "Order not found" } };

  // El cliente está agregando productos: cocina no lo empieza hasta que
  // pague lo agregado, lo deje o pasen los 10 minutos.
  const startsKitchen = status === 'preparing' && previousOrder.status === 'pending';
  // Segundo tiempo en espera: cocina no lo empieza hasta que el mesero lo marche.
  if (startsKitchen && previousOrder.waiting) {
    return {
      code: 409,
      body: {
        title: "Esperando al mesero",
        message: "Esta comanda es un segundo tiempo: se prepara cuando el mesero la marche.",
      },
    };
  }
  if (startsKitchen && previousOrder.hold?.active) {
    return {
      code: 409,
      body: {
        title: "Cliente agregando productos",
        message: "El cliente está agregando productos a este pedido. Vuelve a la cola en unos minutos; mientras, sigue con el siguiente.",
      },
    };
  }

  const mongoUpdate = { $set: { status } };
  // Quién la sirvió (puede ser otro mesero distinto del que la tomó).
  if (status === 'delivered' && previousOrder.status !== 'delivered' && user?.role === 'employee') {
    const employee = await EmployeeModel.findById(user.id).select('personalInfo.name personalInfo.lastname').lean();
    mongoUpdate.$set.servedBy = { id: user.id, name: employeeName(employee), at: new Date() };
  }
  if (status === 'cancelled') mongoUpdate.$set.waiting = false;
  // Un pedido a domicilio que sale de cocina entra a la cola de reparto.
  const opensForDrivers = status === 'ready' && previousOrder.isDelivery && !previousOrder.driver
    && [null, undefined, 'available'].includes(previousOrder.deliveryStatus);
  if (opensForDrivers) mongoUpdate.$set.deliveryStatus = 'available';
  // Volver a mandar "preparing" sobre una comanda que ya estaba en cocina
  // reinicia su tiempo en preparación (acción "Continuar" de cocina).
  const restartsPreparation = status === 'preparing' && ['preparing', 'atrasado'].includes(previousOrder.status);
  if (previousOrder.status !== status || restartsPreparation) {
    mongoUpdate.$push = { statusHistory: { status, changedAt: new Date() } };
  }

  // Al empezar cocina se revisa otra vez que no esté en espera, en la misma
  // operación: si el cliente pausa en ese instante, no se cocina.
  const filter = startsKitchen ? { _id: orderId, ...notOnHoldFilter() } : { _id: orderId };
  const order = await Order.findOneAndUpdate(
    filter,
    mongoUpdate,
    { new: true }
  ).populate('table', 'number status')
   .populate(WAITER_POPULATE)
   .populate({ path: 'reservation', select: 'table status reservedFor displayName alias', populate: { path: 'table', select: 'number' } })
   .populate('customer', 'personalInfo');
  if (!order) {
    return { code: 409, body: { title: "Cliente agregando productos", message: "El cliente acaba de empezar a agregar productos a este pedido." } };
  }

  // Facturar solo la primera vez que llega a "delivered" (evita duplicar
  // la venta si el estado se mueve delivered -> otro -> delivered)
  if (status === 'delivered' && previousOrder.status !== 'delivered') {
    await generateInvoice(order);
  }

  emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });
  if (opensForDrivers) {
    emitToTypes(['delivery'], 'delivery:queued', { orderId: order._id });
    // Chef Panchita lo agrupa con otros domicilios cercanos y se lo asigna a
    // un repartidor libre. No se espera: cocina no tiene por qué aguardar.
    dispatchDeliveries('order_ready');
  }
  // Un pedido que ya iba en un paquete sale de él si se cancela, o si cocina
  // lo regresa a preparación antes de que el repartidor salga.
  const leavesPackage = previousOrder.deliveryBatch && (
    status === 'cancelled'
    || (['pending', 'preparing'].includes(status) && previousOrder.deliveryStatus === 'accepted')
  );
  if (leavesPackage) {
    detachOrderFromBatch(previousOrder).catch((error) => console.error('detachOrderFromBatch:', error));
  }

  // Push al cliente de la app. No se espera: cocina no tiene por qué
  // aguardar a que salga el aviso.
  if (previousOrder.status !== status) notifyOrderStatus(order, status);
  // Comanda de mesa lista: avisa al mesero que la tomó.
  if (status === 'ready' && previousOrder.status !== 'ready') {
    notifyWaiterOrderReady(order)?.catch((error) => console.error("notifyWaiterOrderReady:", error));
  }

  return { code: 200, body: { message: "Order updated", data: order }, order };
};

orderController.updateOrderStatus = async (req, res) => {
  try {
    const result = await applyOrderStatus({ orderId: req.params.id, status: req.body.status, user: req.user });
    return res.status(result.code).json(result.body);
  } catch (error) {
    console.error("Error updating order:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Actualiza solo el estado de pago de un pedido (ej. marcar como "paid" un
// pago contraentrega una vez que el mesero/repartidor lo cobra).
orderController.updatePaymentStatus = async (req, res) => {
  try {
    const { paymentStatus } = req.body;
    if (!['pending', 'paid'].includes(paymentStatus)) {
      return res.status(400).json({ message: "El estado de pago debe ser 'pending' o 'paid'" });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: { paymentStatus } },
      { new: true }
    ).populate('table', 'number status')
     .populate(WAITER_POPULATE)
     .populate('customer', 'personalInfo');

    if (!order) return res.status(404).json({ message: "Order not found" });
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });

    return res.status(200).json({ message: "Estado de pago actualizado", data: order });
  } catch (error) {
    console.error("Error updating payment status:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Cancela un pedido (no lo borra, solo lo marca "cancelled") exigiendo la
// contraseña de un administrador como confirmación, ya que cancelar un
// pedido ya tomado puede implicar pérdidas para el negocio.
orderController.cancelOrder = async (req, res) => {
  try {
    const { adminPassword } = req.body;
    if (!adminPassword) {
      return res.status(400).json({ message: "Se requiere la contraseña del administrador para cancelar el pedido." });
    }

    const admins = await AdminModel.find().select("loginInfo.password");
    let authorized = false;
    for (const admin of admins) {
      if (await bcryptjs.compare(adminPassword, admin.loginInfo.password)) {
        authorized = true;
        break;
      }
    }

    if (!authorized) {
      return res.status(401).json({ message: "Contraseña de administrador incorrecta." });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      {
        $set: { status: 'cancelled' },
        $push: { statusHistory: { status: 'cancelled', changedAt: new Date() } }
      },
      { new: true }
    ).populate('table', 'number status')
     .populate(WAITER_POPULATE)
     .populate('customer', 'personalInfo');

    if (!order) return res.status(404).json({ message: "Order not found" });
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });

    return res.status(200).json({ message: "Order cancelled", data: order });
  } catch (error) {
    console.error("Error cancelling order:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /orders/:id/customer-cancel — el cliente cancela su pedido en línea.
// Lo pagado con saldo a favor regresa al saldo al instante. Lo pagado con
// tarjeta lo devuelve un admin desde el panel de Wompi (su API no tiene
// reembolsos): queda como reclamo "pending_refund" y se le avisa al equipo.
orderController.cancelMyOrder = async (req, res) => {
  try {
    const current = await Order.findOne({ _id: req.params.id, customer: req.user.id });
    if (!current) return res.status(404).json({ title: "Pedido no encontrado", message: "No encontramos ese pedido." });

    if (current.status === 'cancelled') {
      return res.status(400).json({ title: "Ya estaba cancelado", message: "Este pedido ya fue cancelado." });
    }
    if (current.orderType !== 'online') {
      return res.status(400).json({ title: "No se puede cancelar", message: "Los pedidos hechos en el local se cancelan con tu mesero." });
    }
    if (!canCustomerCancel(current)) {
      return res.status(400).json({
        title: "Ya no se puede cancelar",
        message:
          current.status === 'delivered'
            ? "Tu pedido ya fue entregado."
            : "Tu pedido ya está en cocina. Si hay un problema, cuéntaselo a Chef Panchita.",
      });
    }

    const paidOnline = current.paymentStatus === 'paid' && current.paymentMethod === 'online';
    // Pago al recibir: lo que se cubrió con saldo sí se descontó al pedir, así
    // que regresa al saldo; el resto nunca se cobró.
    const payOnDelivery = ['cash', 'card_on_delivery'].includes(current.paymentMethod);
    const toWallet = paidOnline || payOnDelivery ? Number(current.payment?.creditApplied) || 0 : 0;
    const toCard = paidOnline ? Number(current.payment?.amount) || 0 : 0;
    const reason = String(req.body?.reason || '').trim().slice(0, 200);

    // Solo cambia si sigue en un estado cancelable: evita cancelar (y
    // reembolsar) dos veces, o cancelar algo que cocina acaba de terminar.
    const order = await Order.findOneAndUpdate(
      { _id: current._id, customer: req.user.id, status: { $in: CUSTOMER_CANCELLABLE_STATUSES } },
      {
        $set: {
          status: 'cancelled',
          cancellation: { by: 'customer', reason, at: new Date(), refundedToWallet: toWallet, refundToCard: toCard },
          'hold.active': false,
        },
        $push: { statusHistory: { status: 'cancelled', changedAt: new Date() } },
      },
      { new: true },
    ).populate('customer', 'personalInfo');
    if (!order) {
      return res.status(409).json({ title: "Ya no se puede cancelar", message: "Cocina acaba de empezar tu pedido: ya no se puede cancelar." });
    }

    // Si iba a comer en el local, la mesa queda libre para alguien más.
    await cancelReservationOfOrder(order._id);

    const ref = orderRef(order);
    if (toWallet > 0) {
      await creditWallet({
        customer: req.user.id,
        amount: toWallet,
        type: 'order_cancel',
        description: `Cancelaste el pedido ${ref}`,
        order: order._id,
      });
    }
    if (toCard > 0) {
      try {
        await Claim.create({
          customer: req.user.id,
          order: order._id,
          type: 'cancelled',
          description: reason,
          amount: toCard,
          resolution: 'card_refund',
          status: 'pending_refund',
          decidedBy: 'panchita',
          reason: `Cancelaste el pedido: te reembolsaremos $${toCard.toFixed(2)} a tu tarjeta. Según tu banco, puede tardar unos días en verse.`,
        });
      } catch (error) {
        // Ya había un reclamo de ese pedido: el aviso al equipo de abajo basta.
        if (error?.code !== 11000) throw error;
      }
    }

    await notificationUtils.createNotification({
      req,
      category: "orders",
      action: "order_cancelled_by_customer",
      title: toCard > 0 ? "Pedido cancelado · reembolso pendiente" : "Pedido cancelado por el cliente",
      message: (actor) =>
        toCard > 0
          ? `${actor.name} canceló el pedido ${ref}. Reembolsa $${toCard.toFixed(2)} a su tarjeta desde el panel de Wompi.`
          : `${actor.name} canceló el pedido ${ref}.`,
      icon: "receipt",
      severity: toCard > 0 ? "warning" : "info",
      entity: { model: "Order", id: order._id, label: `Pedido ${ref}` },
    });
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });

    return res.status(200).json({
      title: "Pedido cancelado",
      message:
        toCard > 0
          ? `Te reembolsaremos $${toCard.toFixed(2)} a tu tarjeta. Según tu banco, puede tardar unos días en verse.` +
            (toWallet > 0 ? ` Los $${toWallet.toFixed(2)} que pagaste con saldo ya regresaron a tu saldo.` : "")
          : toWallet > 0
            ? `Los $${toWallet.toFixed(2)} ya regresaron a tu saldo a favor.`
            : "Listo, tu pedido quedó cancelado.",
      refundedToWallet: toWallet,
      refundToCard: toCard,
    });
  } catch (error) {
    console.error("orderController.cancelMyOrder:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo cancelar el pedido." });
  }
};

// POST /orders/:id/hold — "Agregar más productos": el cliente pausa su pedido
// 10 min para sumarle productos y pagarlos (ver orderHoldUtils).
orderController.holdMyOrder = async (req, res) => {
  try {
    const current = await Order.findOne({ _id: req.params.id, customer: req.user.id });
    if (!current) return res.status(404).json({ title: "Pedido no encontrado", message: "No encontramos ese pedido." });
    if (!canHold(current)) {
      return res.status(400).json({
        title: "No se pueden agregar productos",
        message: current.hold?.used
          ? "Ya agregaste productos a este pedido una vez. Si deseas algo más, realiza otro pedido."
          : "Solo se puede mientras el pedido no haya entrado a cocina.",
      });
    }

    const now = new Date();
    const until = new Date(now.getTime() + HOLD_MS);
    // Solo si sigue "Recibido" y sin pausa usada: si cocina lo empezó en este
    // instante, gana cocina.
    const updated = await Order.findOneAndUpdate(
      { _id: current._id, customer: req.user.id, orderType: 'online', status: 'pending', 'hold.used': { $ne: true } },
      { $set: { 'hold.active': true, 'hold.startedAt': now, 'hold.until': until, 'hold.used': true } },
      { new: true },
    );
    if (!updated) {
      return res.status(409).json({ title: "No se pudo", message: "Cocina acaba de empezar tu pedido." });
    }

    await emitOrder(updated._id);
    return res.status(200).json({
      title: "Agrega tus productos",
      message: "Tienes 10 minutos para agregar productos y pagarlos. Mientras, cocina espera tu pedido.",
      hold: publicHold(updated),
    });
  } catch (error) {
    console.error("orderController.holdMyOrder:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo empezar a agregar productos." });
  }
};

// POST /orders/:id/resume — el cliente ya no quiere agregar nada: el pedido
// vuelve a la cola sin esperar los 10 minutos.
orderController.resumeMyOrder = async (req, res) => {
  try {
    const updated = await Order.findOneAndUpdate(
      { _id: req.params.id, customer: req.user.id, 'hold.active': true },
      { $set: { 'hold.active': false, 'hold.releasedAt': new Date(), 'hold.releasedBy': 'customer' } },
      { new: true },
    );
    if (!updated) {
      return res.status(400).json({ title: "No estaba en espera", message: "Tu pedido ya está en la cola." });
    }
    await emitOrder(updated._id);
    return res.status(200).json({ title: "Pedido reanudado", message: "Listo, tu pedido volvió a la cola en su mismo lugar.", hold: publicHold(updated) });
  } catch (error) {
    console.error("orderController.resumeMyOrder:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo reanudar el pedido." });
  }
};

// Eliminar pedido
orderController.deleteOrder = async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_DELETED, { orderId: String(order._id) });

    return res.status(200).json({ message: "Order deleted" });
  } catch (error) {
    console.error("Error deleting order:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Clientes destacados (apartado de Clientes): tres rankings distintos, todos
// basados en pedidos en línea ya entregados (los locales no llevan cliente
// con cuenta, los anota el mesero como texto libre).
orderController.getCustomerLeaderboard = async (req, res) => {
  try {
    // Las tres tarjetas usan el MISMO período (un solo selector en el
    // frontend las controla a la vez), pero conservan valores por defecto
    // distintos a propósito cuando no se manda ningún filtro explícito:
    //   - "Más activos" seguía siendo sobre 7 días (period=week por defecto)
    //   - "Mayor gasto" seguía siendo histórico completo (period=all)
    //   - "Compras más caras" seguía siendo la semana en curso (period=week)
    // Si el frontend manda un período explícito, ese gana en las tres.
    const explicitPeriod = req.query.period || (req.query.from && req.query.to ? 'custom' : null);

    const mostActiveRange = resolvePeriodRange({ ...req.query, period: explicitPeriod || 'week' });
    const topSpendersRange = resolvePeriodRange({ ...req.query, period: explicitPeriod || 'all' });
    const priciestWeekRange = resolvePeriodRange({ ...req.query, period: explicitPeriod || 'week' });

    const baseMatch = { orderType: 'online', status: 'delivered', customer: { $ne: null } };

    const [mostActiveRows, topSpendersRows, priciestWeekOrders] = await Promise.all([
      Order.aggregate([
        { $match: { ...baseMatch, ...buildDateMatch(mostActiveRange) } },
        { $group: { _id: '$customer', orderCount: { $sum: 1 }, totalSpent: { $sum: '$total' } } },
        { $sort: { orderCount: -1, totalSpent: -1 } },
        { $limit: 10 },
      ]),
      Order.aggregate([
        { $match: { ...baseMatch, ...buildDateMatch(topSpendersRange) } },
        { $group: { _id: '$customer', orderCount: { $sum: 1 }, totalSpent: { $sum: '$total' } } },
        { $sort: { totalSpent: -1 } },
        { $limit: 10 },
      ]),
      Order.find({ ...baseMatch, ...buildDateMatch(priciestWeekRange) })
        .sort({ total: -1 })
        .limit(10)
        .populate('customer', 'personalInfo loginInfo.email')
        .select('total createdAt customer'),
    ]);

    // El aggregate no puede usar populate: se resuelven los clientes aparte
    const populateGroup = async (rows) => {
      const ids = rows.map((r) => r._id).filter(Boolean);
      const customers = await CustomerModel.find({ _id: { $in: ids } }).select('personalInfo loginInfo.email');
      const map = new Map(customers.map((c) => [c._id.toString(), c]));
      return rows
        .map((r) => ({
          customer: map.get(r._id?.toString()) || null,
          orderCount: r.orderCount,
          totalSpent: r.totalSpent,
        }))
        .filter((r) => r.customer);
    };

    const [mostActive, topSpenders] = await Promise.all([
      populateGroup(mostActiveRows),
      populateGroup(topSpendersRows),
    ]);

    return res.status(200).json({
      period: explicitPeriod || null,
      mostActive,
      topSpenders,
      priciestWeek: priciestWeekOrders.filter((o) => o.customer),
    });
  } catch (error) {
    console.error("Error en getCustomerLeaderboard:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Empleados destacados: quién vendió más (pedidos locales entregados),
// filtrable por día/semana/mes.
orderController.getEmployeeLeaderboard = async (req, res) => {
  try {
    // Acepta day/week/month/year/all, o un rango personalizado (?from&to).
    // Antes solo soportaba day/week/month a mano; ahora usa el mismo
    // resolvedor que el ranking de clientes, para que un solo selector en el
    // frontend sirva para las dos pantallas.
    const range = resolvePeriodRange(req.query);
    const dateMatch = buildDateMatch(range);

    const rows = await Order.aggregate([
      { $match: { orderType: 'local', status: 'delivered', waiter: { $ne: null }, ...dateMatch } },
      { $group: { _id: '$waiter', orderCount: { $sum: 1 }, totalSales: { $sum: '$total' } } },
      { $sort: { totalSales: -1 } },
      { $limit: 10 },
    ]);

    const ids = rows.map((r) => r._id).filter(Boolean);
    const employees = await EmployeeModel.find({ _id: { $in: ids } }).select('personalInfo.name personalInfo.lastname personalInfo.type personalInfo.image');
    const map = new Map(employees.map((e) => [e._id.toString(), e]));

    const topEmployees = rows
      .map((r) => ({
        employee: map.get(r._id?.toString()) || null,
        orderCount: r.orderCount,
        totalSales: r.totalSales,
      }))
      .filter((r) => r.employee);

    return res.status(200).json({ period: range.period, range: { start: range.start, end: range.end }, topEmployees });
  } catch (error) {
    console.error("Error en getEmployeeLeaderboard:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Vista rápida para el mesero con sesión iniciada: todas las mesas del local,
// cada una con sus pedidos locales activos (los que aún no llegan a
// "delivered"/"cancelled") que él mismo tomó, para que sepa de un vistazo qué
// mesas está atendiendo y en qué va cada pedido sin entrar a Pedidos y Órdenes.
const KITCHEN_ACTIVE_STATUSES = ['pending', 'preparing', 'ready', 'atrasado'];

// Comandas que forman la cuenta abierta de una mesa ocupada: las que siguen en
// cocina y las ya servidas que aún no se cobran, desde que la mesa se ocupó.
const belongsToOpenTab = (order, table) => {
  const since = table.status === 'ocupada' && table.occupiedAt ? new Date(table.occupiedAt).getTime() : null;
  // QR check-in can happen after a scheduled dine-in order was created.
  const activityAt = new Date(
    order.arrivedAt || (order.channel === 'counter' && order.tableAssignedAt) || order.createdAt
  ).getTime();
  if (KITCHEN_ACTIVE_STATUSES.includes(order.status)) {
    return since === null || activityAt >= since;
  }
  return order.status === 'delivered'
    && order.paymentStatus === 'pending'
    && since !== null
    && activityAt >= since;
};

// Tablero del mesero: todas las mesas con los datos de su ocupación y el
// detalle de las comandas que forman su cuenta abierta.
orderController.getWaiterDashboard = async (req, res) => {
  try {
    const tables = await TablesModel.find().sort({ number: 1 }).lean();

    const occupiedSince = tables
      .filter((t) => t.status === 'ocupada' && t.occupiedAt)
      .map((t) => new Date(t.occupiedAt));
    const oldestOccupation = occupiedSince.length
      ? new Date(Math.min(...occupiedSince.map((d) => d.getTime())))
      : null;

    const statusFilter = [{ status: { $in: KITCHEN_ACTIVE_STATUSES } }];
    if (oldestOccupation) {
      statusFilter.push({ status: 'delivered', paymentStatus: 'pending', createdAt: { $gte: oldestOccupation } });
    }

    const orders = await Order.find({
      $or: [
        {
          orderType: 'local',
          table: { $ne: null },
          $or: statusFilter,
        },
        {
          orderType: 'online',
          fulfillment: 'dine_in',
          reservation: { $ne: null },
          status: { $in: KITCHEN_ACTIVE_STATUSES },
        },
      ],
    })
      .populate(WAITER_POPULATE)
      .populate({ path: 'reservation', select: 'table status', populate: { path: 'table', select: 'number' } })
      .lean();
    orders.sort((a, b) => {
      const aTime = a.channel === 'counter' && a.tableAssignedAt ? a.tableAssignedAt : a.createdAt;
      const bTime = b.channel === 'counter' && b.tableAssignedAt ? b.tableAssignedAt : b.createdAt;
      return new Date(aTime) - new Date(bTime);
    });

    const ordersByTable = new Map();
    for (const order of orders) {
      const reservationTable = order.reservation?.table;
      const reservationIsActive = ['reserved', 'checked_in'].includes(order.reservation?.status);
      const tableId = order.table || (reservationIsActive ? reservationTable?._id || reservationTable : null);
      if (!tableId) continue;
      const key = String(tableId);
      if (!ordersByTable.has(key)) ordersByTable.set(key, []);
      ordersByTable.get(key).push(order);
    }

    const dashboard = tables.map((table) => {
      const tableOrders = (ordersByTable.get(String(table._id)) || []).filter((o) => belongsToOpenTab(o, table));
      return {
        _id: table._id,
        number: table.number,
        status: table.status,
        customerName: table.status === 'ocupada' ? table.customerName || null : null,
        peopleCount: table.status === 'ocupada' ? table.peopleCount || null : null,
        occupiedAt: table.status === 'ocupada' ? table.occupiedAt || null : null,
        // El mesero ya mandó la cuenta a caja ("Enviar a caja")
        billRequestedAt: table.status === 'ocupada' ? table.billRequestedAt || null : null,
        activeOrders: tableOrders.map((order) => ({
          _id: order._id,
          // Código que ven todos ("CL03-02") y quién tomó la comanda, para que
          // cualquier mesero pueda servirla y ver de quién es.
          code: order.code || null,
          waiterId: order.waiter?._id || null,
          round: order.round || null,
          course: order.course || null,
          waiting: !!order.waiting,
          firedAt: order.firedAt || null,
          tableAssignedAt: order.tableAssignedAt || null,
          channel: order.channel || null,
          fulfillment: order.fulfillment || null,
          servingBy: order.servingBy?.id ? order.servingBy : null,
          servedBy: order.servedBy?.id ? order.servedBy : null,
          status: order.status,
          paymentStatus: order.paymentStatus,
          total: order.total,
          itemCount: (order.items || []).reduce((sum, item) => sum + (item.quantity || 1), 0),
          items: (order.items || []).map((item) => ({
            _id: item._id,
            itemType: item.itemType,
            name: item.name,
            price: item.price,
            quantity: item.quantity || 1,
            notes: item.notes || '',
          })),
          notes: order.notes || '',
          customerName: order.localCustomerName || order.reservation?.displayName || null,
          waiter: order.waiter
            ? `${order.waiter.name || ''} ${order.waiter.lastname || ''}`.trim()
            : null,
          createdAt: order.createdAt,
        })),
      };
    });

    res.status(200).json(dashboard);
  } catch (error) {
    console.error("Error en dashboard:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};

// Mostrador dine-in orders can be assigned by a waiter after payment. Pickup
// orders and orders already linked to a table are intentionally excluded.
orderController.getUnassignedCounterOrders = async (_req, res) => {
  try {
    const orders = await Order.find({
      orderType: 'local',
      channel: 'counter',
      fulfillment: 'dine_in',
      table: null,
      paymentStatus: 'paid',
      status: { $in: KITCHEN_ACTIVE_STATUSES },
    })
      .select('_id code localCustomerName total status items notes createdAt')
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json(orders);
  } catch (error) {
    console.error("orderController.getUnassignedCounterOrders:", error);
    return res.status(500).json({ message: "No se pudieron cargar las comandas sin mesa." });
  }
};

orderController.assignCounterOrderToTable = async (req, res) => {
  try {
    const { tableId } = req.body || {};
    if (!/^[a-f\d]{24}$/i.test(String(tableId || ''))) {
      return res.status(400).json({ message: "Selecciona una mesa válida." });
    }

    const table = await TablesModel.findById(tableId).lean();
    if (!table) return res.status(404).json({ message: "Mesa no encontrada." });
    if (table.status === 'reservada') {
      return res.status(409).json({ message: "No se puede asignar una comanda a una mesa reservada." });
    }

    const assignedAt = new Date();
    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        orderType: 'local',
        channel: 'counter',
        fulfillment: 'dine_in',
        table: null,
        paymentStatus: 'paid',
        status: { $in: KITCHEN_ACTIVE_STATUSES },
      },
      { $set: { table: table._id, tableAssignedAt: assignedAt, waiter: req.user.id } },
      { new: true },
    );
    if (!order) {
      return res.status(409).json({ message: "La comanda ya no está disponible para asignar." });
    }

    let updatedTable = table;
    if (table.status === 'libre') {
      updatedTable = await TablesModel.findOneAndUpdate(
        { _id: table._id, status: 'libre' },
        {
          $set: {
            status: 'ocupada',
            occupiedAt: assignedAt,
            ...(order.localCustomerName ? { customerName: order.localCustomerName } : {}),
          },
          $unset: { peopleCount: '', billRequestedAt: '', billRequestedBy: '' },
        },
        { new: true },
      );

      // A reservation or another state change may have won after the initial
      // read. Roll back this order assignment rather than leave it orphaned.
      if (!updatedTable) {
        await Order.updateOne(
          { _id: order._id, table: table._id, waiter: req.user.id, tableAssignedAt: assignedAt },
          { $unset: { table: '', waiter: '', tableAssignedAt: '' } },
        );
        return res.status(409).json({ message: "La mesa cambió de estado. Actualiza y vuelve a intentar." });
      }
    } else {
      updatedTable = await TablesModel.findOne({ _id: table._id, status: 'ocupada' }).lean();
      if (!updatedTable) {
        await Order.updateOne(
          { _id: order._id, table: table._id, waiter: req.user.id, tableAssignedAt: assignedAt },
          { $unset: { table: '', waiter: '', tableAssignedAt: '' } },
        );
        return res.status(409).json({ message: "La mesa cambió de estado. Actualiza y vuelve a intentar." });
      }
    }

    const populated = await emitOrder(order._id);
    emitToRoles(notificationUtils.AUDIENCE_BY_CATEGORY.tables, SOCKET_EVENTS.TABLE_UPDATED, {
      table: updatedTable.toObject ? updatedTable.toObject() : updatedTable,
    });

    return res.status(200).json({ message: "Comanda asignada a la mesa.", data: populated });
  } catch (error) {
    console.error("orderController.assignCounterOrderToTable:", error);
    return res.status(500).json({ message: "No se pudo asignar la comanda a la mesa." });
  }
};

// Comandas de la cuenta abierta de una mesa que siguen pendientes de pago.
// La usan el cobro del mesero (checkoutTable) y la caja (cashierController).
export const findOpenTabOrders = async (table) => {
  const candidates = await Order.find({
    orderType: 'local',
    table: table._id,
    paymentStatus: 'pending',
    status: { $in: [...KITCHEN_ACTIVE_STATUSES, 'delivered'] },
  });
  return candidates.filter((o) => belongsToOpenTab(o, table));
};

export { belongsToOpenTab, KITCHEN_ACTIVE_STATUSES };

/**
 * Cobra la cuenta abierta de una mesa: todas sus comandas pendientes de pago
 * quedan pagadas con el método indicado y, si aún no se habían servido, se
 * marcan como entregadas (lo que genera su factura, igual que updateOrderStatus).
 *
 * Devuelve { code, body } con el error, o { code: 200, table, orders, total }.
 * No responde ni notifica: eso lo decide quien la llama (mesero o caja).
 */
export const settleTableTab = async ({ tableId, paymentMethod }) => {
  if (!['cash', 'card'].includes(paymentMethod)) {
    return { code: 400, body: { message: "El método de pago debe ser 'cash' o 'card'" } };
  }

  const table = await TablesModel.findById(tableId).lean();
  if (!table) return { code: 404, body: { message: "Mesa no encontrada" } };
  if (table.status !== 'ocupada') {
    return { code: 400, body: { message: "Solo se puede cobrar la cuenta de una mesa ocupada" } };
  }

  const orders = await findOpenTabOrders(table);

  // Un segundo tiempo que sigue en espera no se ha cocinado: hay que
  // marcharlo o cancelarlo antes de cobrar, o se cobraría sin servirse.
  if (orders.some((o) => o.waiting && o.status === 'pending')) {
    return {
      code: 409,
      body: {
        title: "Hay un tiempo en espera",
        message: "Esta mesa tiene una comanda esperando a que la marches. Márchala o cancélala antes de cobrar.",
      },
    };
  }

  if (orders.length === 0) {
    return { code: 400, body: { message: "La mesa no tiene consumos pendientes de cobro" } };
  }

  let total = 0;
  for (const order of orders) {
    const wasDelivered = order.status === 'delivered';
    order.paymentStatus = 'paid';
    order.paymentMethod = paymentMethod;
    if (!wasDelivered) {
      order.status = 'delivered';
      order.statusHistory.push({ status: 'delivered', changedAt: new Date() });
    }
    await order.save();
    total += order.total || 0;
    // Si la comanda ya se había servido, su factura se generó sin método de
    // pago ("por definir"): se completa ahora.
    if (wasDelivered) await Invoice.updateOne({ order: order._id }, { $set: { paymentMethod } });

    const populated = await Order.findById(order._id)
      .populate('table', 'number status')
      .populate(WAITER_POPULATE)
      .populate('customer', 'personalInfo');

    if (!wasDelivered) await generateInvoice(populated);
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: populated.toObject() });
  }

  // La cuenta ya no está "solicitada" en caja
  if (table.billRequestedAt) {
    await TablesModel.updateOne({ _id: table._id }, { $set: { billRequestedAt: null, billRequestedBy: null } });
  }

  return { code: 200, table, orders, total: Math.round(total * 100) / 100 };
};

// Cobra la cuenta abierta de una mesa desde la app del mesero. Con un turno
// de caja abierto no se puede: las cuentas se cobran en caja ("Enviar a caja").
orderController.checkoutTable = async (req, res) => {
  try {
    if (await isCashierOpen()) {
      return res.status(409).json({
        code: "CASHIER_OPEN",
        title: "La caja está abierta",
        message: "Con la caja abierta, las cuentas se cobran en caja. Usa \"Enviar a caja\".",
      });
    }

    const { paymentMethod } = req.body;
    const result = await settleTableTab({ tableId: req.params.tableId, paymentMethod });
    if (result.code !== 200) return res.status(result.code).json(result.body);
    const { table, orders, total } = result;

    await notificationUtils.createNotification({
      req,
      category: "orders",
      action: "updated",
      title: "Cuenta cobrada",
      message: (actor) => `${actor.name} cobró la cuenta de la Mesa ${table.number} ($${total.toFixed(2)})`,
      icon: "receipt",
      severity: "success",
      entity: { model: "Tables", id: table._id, label: `Mesa ${table.number}` },
    });

    return res.status(200).json({
      message: "Cuenta cobrada",
      data: { tableId: table._id, orders: orders.length, total, paymentMethod },
    });
  } catch (error) {
    console.error("Error en checkoutTable:", error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
};

// "Enviar a caja": con la caja abierta, el mesero no cobra; marca la cuenta
// de la mesa como solicitada y la caja la resalta para cobrarla.
orderController.requestTableBill = async (req, res) => {
  try {
    const table = await TablesModel.findById(req.params.tableId).lean();
    if (!table) return res.status(404).json({ message: "Mesa no encontrada" });
    if (table.status !== 'ocupada') {
      return res.status(400).json({ message: "Solo se puede pedir la cuenta de una mesa ocupada" });
    }
    const orders = await findOpenTabOrders(table);
    if (orders.length === 0) {
      return res.status(400).json({ message: "La mesa no tiene consumos pendientes de cobro" });
    }

    const actor = await notificationUtils.resolveActor(req);
    const updated = await TablesModel.findByIdAndUpdate(
      table._id,
      { $set: { billRequestedAt: new Date(), billRequestedBy: actor.name } },
      { returnDocument: 'after' },
    );
    emitToRoles(notificationUtils.AUDIENCE_BY_CATEGORY.tables, SOCKET_EVENTS.TABLE_UPDATED, { table: updated.toObject() });

    const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    return res.status(200).json({
      message: "Cuenta enviada a caja",
      data: { tableId: table._id, total: Math.round(total * 100) / 100 },
    });
  } catch (error) {
    console.error("Error en requestTableBill:", error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
};

// Lo que el cliente puede marcar al calificar, además de las estrellas.
const RATING_TAGS = [
  'Buen sabor', 'Llegó caliente', 'Buena porción', 'Rápido', 'Buen servicio',
  'Llegó frío', 'Tardó mucho', 'Faltó algo', 'Mal sabor', 'Porción pequeña',
];

// POST /orders/:id/rating — el cliente califica un pedido suyo ya entregado.
// Una sola vez por pedido. Las calificaciones bajas avisan al equipo.
orderController.rateMyOrder = async (req, res) => {
  try {
    const stars = Number(req.body?.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ title: "Elige las estrellas", message: "Califica tu pedido de 1 a 5 estrellas." });
    }
    const tags = (Array.isArray(req.body?.tags) ? req.body.tags : [])
      .filter((tag) => RATING_TAGS.includes(tag))
      .slice(0, RATING_TAGS.length);
    const comment = String(req.body?.comment || '').trim().slice(0, 500);

    // Solo se guarda si es suyo, ya se entregó y no lo había calificado.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, customer: req.user.id, status: 'delivered', 'rating.stars': { $exists: false } },
      { $set: { rating: { stars, tags, comment: comment || undefined, at: new Date() } } },
      { new: true },
    ).select('code rating contact');

    if (!order) {
      const exists = await Order.findOne({ _id: req.params.id, customer: req.user.id }).select('status rating');
      if (!exists) return res.status(404).json({ title: "Pedido no encontrado", message: "No encontramos ese pedido." });
      if (exists.rating?.stars) return res.status(409).json({ title: "Ya lo calificaste", message: "Gracias, ya habías calificado este pedido." });
      return res.status(400).json({ title: "Aún no se puede", message: "Podrás calificar tu pedido cuando se entregue." });
    }

    const who = [order.contact?.name, order.contact?.lastname].filter(Boolean).join(' ') || 'Un cliente';
    await notificationUtils.createNotification({
      req,
      category: "orders",
      action: "rated",
      title: stars <= 2 ? "Calificación baja" : "Pedido calificado",
      message: `${who} calificó el pedido ${order.code} con ${stars} ${stars === 1 ? 'estrella' : 'estrellas'}${comment ? `: "${comment.slice(0, 120)}"` : ''}`,
      icon: "star",
      severity: stars <= 2 ? "warning" : "success",
      entity: { model: "Order", id: order._id, label: order.code },
    });

    return res.status(200).json({ title: "¡Gracias!", message: "Tu calificación nos ayuda a mejorar.", rating: order.rating });
  } catch (error) {
    console.error("orderController.rateMyOrder:", error);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo guardar tu calificación." });
  }
};

// "Marchar": el mesero avisa que ya se puede preparar un segundo tiempo que
// estaba en espera. Vuelve a la cola de cocina desde este momento (se anota
// en el historial para que su tiempo de espera no cuente como retraso).
orderController.fireOrder = async (req, res) => {
  try {
    const now = new Date();
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, orderType: 'local', status: 'pending', waiting: true },
      { $set: { waiting: false, firedAt: now }, $push: { statusHistory: { status: 'pending', changedAt: now } } },
      { new: true },
    );
    if (!order) {
      return res.status(409).json({ title: "No se pudo marchar", message: "Esta comanda ya no está en espera." });
    }
    const populated = await emitOrder(order._id);
    return res.status(200).json({ title: "Comanda marchada", message: "Cocina ya puede prepararla.", data: populated });
  } catch (error) {
    console.error("orderController.fireOrder:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// "Yo la llevo": el mesero avisa que va a llevar una comanda lista a la mesa
// (claim: true) o deja de llevarla (claim: false). Es solo un aviso para los
// demás meseros; cualquiera puede marcarla servida.
orderController.claimOrder = async (req, res) => {
  try {
    const claim = req.body?.claim !== false;
    let update;
    if (claim) {
      const employee = await EmployeeModel.findById(req.user.id).select('personalInfo.name personalInfo.lastname').lean();
      update = { $set: { servingBy: { id: req.user.id, name: employeeName(employee), at: new Date() } } };
    } else {
      update = { $unset: { servingBy: "" } };
    }
    const filter = claim
      ? { _id: req.params.id, status: 'ready' }
      : { _id: req.params.id, 'servingBy.id': req.user.id };
    const order = await Order.findOneAndUpdate(filter, update, { new: true });
    if (!order) {
      return res.status(409).json({
        title: "No se pudo actualizar",
        message: claim ? "Esta comanda ya no está lista para llevarse." : "Esta comanda no la llevabas tú.",
      });
    }
    const populated = await emitOrder(order._id);
    return res.status(200).json({ message: claim ? "La llevas tú" : "Ya no la llevas", data: populated });
  } catch (error) {
    console.error("orderController.claimOrder:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default orderController;
