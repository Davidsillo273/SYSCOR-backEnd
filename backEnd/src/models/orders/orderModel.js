import mongoose, { Schema, model } from "mongoose";

// Un producto dentro de un pedido (combo, extra o bebida), con los datos ya
// "congelados" al momento de pedirse (nombre/precio) para que si el producto
// cambia de precio después, el pedido histórico no se vea afectado.
const orderItemSchema = new Schema({
  itemType: {
    type: String,
    // 'saucer' (platillo suelto) lo usan los pedidos que hace la app de clientes
    enum: ['combo', 'extra', 'drink', 'saucer'],
    required: true
  },
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'itemType' // 'combo' -> Combos, 'extra' -> Extras, 'drink' -> Drinks
  },
  name: String,
  price: Number,
  quantity: { type: Number, default: 1 },
  notes: String
});

// ORDER: el registro operativo de un pedido mientras se está preparando y
// sirviendo/despachando. Es distinto del Carrito (colección "carts", el
// borrador de compra antes de confirmar) y de la Factura (colección
// "invoices", el registro de facturación que se genera solo cuando el
// pedido se entrega, ver invoiceController.js).
//
// Un pedido puede nacer de dos formas distintas, controladas por "orderType":
//   - "local": lo toma un mesero en el restaurante. Lleva mesa + mesero.
//   - "online": lo hace el cliente desde la web/app. Lleva cliente + si es a
//     domicilio o para recoger, y su método de pago.
// Igual que Inventario separa "producto" de "activo_fijo" con un campo
// itemType en un solo esquema (en vez de dos colecciones), aquí seguimos el
// mismo patrón con orderType: un solo esquema flexible, validado según el
// tipo en el controlador (ver orderController.createOrder).
const orderSchema = new Schema({
  orderType: {
    type: String,
    enum: ['local', 'online'],
    required: true
  },

  // --- Campos exclusivos de pedidos LOCALES (dine-in) ---
  table: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tables"
  },
  waiter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee"
  },
  // Nombre del cliente o de la familia que anota el mesero al tomar el pedido
  localCustomerName: { type: String },

  // --- Campos exclusivos de pedidos EN LÍNEA ---
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer"
  },
  // Información de contacto del pedido: se precarga del cliente pero el
  // cliente la puede editar manualmente al momento de pedir (ej. otro correo).
  contact: {
    name: { type: String },
    lastname: { type: String },
    email: { type: String },
  },
  // true = se lleva a domicilio, false = el cliente pasa a recogerlo al local.
  // Solo aplica a pedidos "online" (un pedido local siempre es "en el local").
  isDelivery: { type: Boolean },
  // Dirección de entrega. Solo obligatoria cuando isDelivery es true.
  deliveryAddress: { type: String },
  // Si se llena, el pedido queda programado para esa fecha/hora en vez de
  // prepararse de inmediato (ver "Pedidos programados" en Orders.jsx).
  scheduledFor: { type: Date, default: null },
  // Si el pedido lo recibe alguien distinto al cliente (a domicilio o al
  // pasar a recogerlo al local), solo se pide nombre y apellido de esa persona.
  receivedBy: {
    name: { type: String },
    lastname: { type: String },
  },
  paymentMethod: {
    type: String,
    // 'card' y 'cash' cubren pedidos locales (tarjeta o efectivo en caja).
    // 'card_on_delivery' = tarjeta contraentrega, 'online' = ya pagado en
    // línea al hacer el pedido; ambos exclusivos de pedidos online.
    enum: ['card', 'cash', 'card_on_delivery', 'online']
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid'],
    default: 'pending'
  },
  // Cobro en línea con Wompi que originó este pedido (ver checkoutController).
  payment: {
    provider: { type: String },
    transactionId: { type: String },
    authorizationCode: { type: String },
    amount: { type: Number },
    // Parte del pedido pagada con saldo a favor (reclamos resueltos por Panchita)
    creditApplied: { type: Number, default: 0 },
    checkout: { type: mongoose.Schema.Types.ObjectId, ref: "Checkout" },
  },

  // Mensajes del cliente para el repartidor (ej. "Déjalo en la recepción").
  // Los manda desde la app, con un toque o escritos por él.
  driverMessages: [
    {
      text: { type: String, maxlength: 200 },
      preset: { type: Boolean, default: false },
      createdAt: { type: Date, default: Date.now }
    }
  ],
  // Última estimación de entrega que calculó Panchita (ver etaUtils). Se
  // guarda para no consultar a Google en cada vistazo del cliente.
  eta: { type: mongoose.Schema.Types.Mixed, default: null },

  // --- Campos compartidos por ambos tipos ---
  items: [orderItemSchema],
  total: { type: Number, default: 0 },
  status: {
    type: String,
    // "atrasado" lo asigna el sistema solo cuando un pedido lleva más de 1
    // hora en "preparing" sin pasar a "ready" (ver orderController.flagDelayedOrders).
    //
    // OJO con la diferencia entre "ready" y "delivered", no son lo mismo:
    //   - "ready": el pedido ya está listo para salir de cocina. En un pedido
    //     local significa "listo para llevar a la mesa"; en uno online
    //     significa "listo para despacharlo a domicilio o para que el
    //     cliente pase a recogerlo".
    //   - "delivered": el pedido ya llegó a su destino final. En local es
    //     "ya se sirvió en la mesa"; en online es "ya se entregó en el
    //     domicilio" o "el cliente ya lo recogió" (lo distingue isDelivery).
    enum: ['pending', 'preparing', 'ready', 'delivered', 'cancelled', 'atrasado'],
    default: 'pending'
  },
  // Cancelación hecha por el cliente desde la app (hasta 15 min después de
  // pedir, ver orderController.cancelMyOrder). Las del panel no la llenan.
  cancellation: {
    by: { type: String, enum: ['customer'] },
    reason: { type: String, maxlength: 200 },
    at: { type: Date },
    // Lo que se le devolvió: al saldo a favor (al instante) y a la tarjeta
    // (lo hace un admin desde Wompi; queda como reclamo "pending_refund").
    refundedToWallet: { type: Number, default: 0 },
    refundToCard: { type: Number, default: 0 },
  },

  // Historial de cambios de estado: de aquí se calcula el tiempo promedio de
  // preparación (preparing -> ready), el tráfico de pedidos por hora, y
  // permite detectar cuándo empezó a estar "atrasado".
  statusHistory: [
    {
      status: { type: String },
      changedAt: { type: Date, default: Date.now }
    }
  ]
}, {
  timestamps: true,
  // Se deja explícito el nombre de la colección porque este modelo viene de
  // ampliar el antiguo Order (que solo manejaba pedidos locales) para que
  // también maneje pedidos online. La colección física se queda llamándose
  // "orders" para no perder los pedidos ya existentes ni requerir mover datos.
  collection: "orders"
});

export default model("Order", orderSchema);
