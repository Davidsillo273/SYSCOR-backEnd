import bcryptjs from "bcryptjs";
import Order from "../../models/orders/orderModel.js";
import Invoice from "../../models/orders/invoiceModel.js";
import Combos from "../../models/menu/combosModel.js";
import Drinks from "../../models/menu/drinksModel.js";
import Extras from "../../models/menu/extrasModel.js";
import TablesModel from "../../models/tables/tablesModel.js";
import AdminModel from "../../models/users/adminModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { resolvePeriodRange, buildDateMatch } from "../../utils/orders/periodUtils.js";
// Tiempo real: cocina y el panel de pedidos reflejan cada comanda nueva o
// cambio de estado al instante, sin recargar ni sondear.
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import Claim from "../../models/orders/claimModel.js";
import { creditWallet, orderRef } from "../../utils/wallet/walletUtils.js";

const orderController = {};

// Mismo público que ya define notificationUtils para la categoría "orders":
// las comandas las ven el administrador y el personal.
const ORDERS_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.orders;

const ONE_HOUR_MS = 60 * 60 * 1000;

// Revisa los pedidos "preparing" y marca como "atrasado" los que llevan más
// de 1 hora sin pasar a "ready". Se ejecuta cada vez que se listan pedidos,
// para no depender de un cron/proceso en segundo plano aparte.
const flagDelayedOrders = async () => {
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
        .populate('waiter', 'name lastname')
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
orderController.createOrder = async (req, res) => {
  try {
    const { orderType, items } = req.body;

    if (!['local', 'online'].includes(orderType)) {
      return res.status(400).json({ message: "orderType debe ser 'local' u 'online'" });
    }

    const orderFields = { orderType };

    if (orderType === 'local') {
      const { table, localCustomerName, paymentMethod, customer } = req.body;
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
      orderFields.localCustomerName = localCustomerName?.trim() || undefined;
      orderFields.paymentMethod = paymentMethod || 'cash';
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
      let model;
      switch (item.itemType) {
        case 'combo': model = Combos; break;
        case 'extra': model = Extras; break;
        case 'drink': model = Drinks; break;
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
      .populate('waiter', 'name lastname')
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
// y estado (?status=). El populate de table/waiter/customer no molesta
// aunque el pedido sea del otro tipo: simplemente queda null.
orderController.getOrders = async (req, res) => {
  try {
    await flagDelayedOrders();

    const filter = {};
    if (req.query.table) filter.table = req.query.table;
    if (req.query.waiter) filter.waiter = req.query.waiter;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.orderType) filter.orderType = req.query.orderType;
    // Pedidos programados: los que tienen una fecha/hora futura para prepararse
    if (req.query.scheduled === 'true') filter.scheduledFor = { $ne: null };

    const orders = await Order.find(filter)
      .populate('table', 'number status')
      .populate('waiter', 'name lastname')
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
// El cliente puede cancelar su pedido en línea desde la app durante los
// primeros 15 minutos, mientras cocina no lo tenga listo.
export const CUSTOMER_CANCEL_WINDOW_MS = 15 * 60 * 1000;
const CUSTOMER_CANCELLABLE_STATUSES = ['pending', 'preparing', 'atrasado'];

const cancelDeadlineOf = (order) => {
  if (order.orderType !== 'online' || !CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)) return null;
  return new Date(new Date(order.createdAt).getTime() + CUSTOMER_CANCEL_WINDOW_MS);
};

orderController.getMyOrders = async (req, res) => {
  try {
    await flagDelayedOrders();

    const filter = { customer: req.user.id };
    if (['local', 'online'].includes(req.query.orderType)) filter.orderType = req.query.orderType;

    const orders = await Order.find(filter)
      .select('orderType table isDelivery deliveryAddress scheduledFor paymentMethod paymentStatus items total status statusHistory cancellation createdAt updatedAt')
      .populate('table', 'number')
      .sort({ createdAt: -1 });

    // Hasta cuándo se puede cancelar desde la app (null = ya no se puede).
    const now = Date.now();
    return res.status(200).json(
      orders.map((order) => {
        const deadline = cancelDeadlineOf(order);
        return { ...order.toObject(), cancelDeadline: deadline && deadline.getTime() > now ? deadline : null };
      }),
    );
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Cambiar estado de un pedido. Cuando el nuevo estado es "delivered" (y no
// lo era ya), se dispara la facturación automática (ver generateInvoice).
orderController.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'delivered', 'cancelled', 'atrasado'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const previousOrder = await Order.findById(req.params.id).select("status");
    if (!previousOrder) return res.status(404).json({ message: "Order not found" });

    const mongoUpdate = { $set: { status } };
    if (previousOrder.status !== status) {
      mongoUpdate.$push = { statusHistory: { status, changedAt: new Date() } };
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      mongoUpdate,
      { new: true }
    ).populate('table', 'number status')
     .populate('waiter', 'name lastname')
     .populate('customer', 'personalInfo');

    // Facturar solo la primera vez que llega a "delivered" (evita duplicar
    // la venta si el estado se mueve delivered -> otro -> delivered)
    if (status === 'delivered' && previousOrder.status !== 'delivered') {
      await generateInvoice(order);
    }

    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });

    return res.status(200).json({ message: "Order updated", data: order });
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
     .populate('waiter', 'name lastname')
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
     .populate('waiter', 'name lastname')
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
    if (!CUSTOMER_CANCELLABLE_STATUSES.includes(current.status)) {
      return res.status(400).json({
        title: "Ya no se puede cancelar",
        message: current.status === 'ready' ? "Tu pedido ya está listo." : "Tu pedido ya fue entregado.",
      });
    }
    const deadline = cancelDeadlineOf(current);
    if (!deadline || Date.now() > deadline.getTime()) {
      return res.status(400).json({
        title: "Ya no se puede cancelar",
        message: "Pasaron más de 15 minutos desde que hiciste el pedido. Si hay un problema, cuéntaselo a Chef Panchita.",
      });
    }

    const paidOnline = current.paymentStatus === 'paid' && current.paymentMethod === 'online';
    const toWallet = paidOnline ? Number(current.payment?.creditApplied) || 0 : 0;
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
        },
        $push: { statusHistory: { status: 'cancelled', changedAt: new Date() } },
      },
      { new: true },
    ).populate('customer', 'personalInfo');
    if (!order) {
      return res.status(409).json({ title: "Ya no se puede cancelar", message: "El estado de tu pedido acaba de cambiar. Revísalo de nuevo." });
    }

    const ref = orderRef(order._id);
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
orderController.getWaiterDashboard = async (req, res) => {
  try {
    const waiterId = req.user.id; // o req.query.waiter si prefieres pasarlo explícito

    // Obtener todas las mesas
    const tables = await TablesModel.find().sort({ number: 1 });

    // Obtener pedidos locales activos del mesero (pending, preparing, ready, atrasado)
    const activeOrders = await Order.find({
      orderType: 'local',
      waiter: waiterId,
      status: { $in: ['pending', 'preparing', 'ready', 'atrasado'] }
    })
    .populate('table', 'number status')
    .sort({ createdAt: -1 });

    // Combinar mesas con sus pedidos activos
    const dashboard = tables.map(table => {
      const ordersForTable = activeOrders.filter(
        order => order.table._id.toString() === table._id.toString()
      );
      return {
        _id: table._id,
        number: table.number,
        status: table.status,
        activeOrders: ordersForTable.map(order => ({
          _id: order._id,
          status: order.status,
          total: order.total,
          itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
          createdAt: order.createdAt
        }))
      };
    });

    res.status(200).json(dashboard);
  } catch (error) {
    console.error("Error en dashboard:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};

export default orderController;
