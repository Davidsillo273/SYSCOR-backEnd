// Catálogo de herramientas del asistente de IA general de SYSCOR. Cada
// herramienta tiene tres partes:
//   - `declaration`: lo que se le manda a Gemini (function calling)
//   - `permission`: el id del catálogo de permisos que hace falta para
//     ejecutarla (null = cualquiera con sesión de admin/empleado puede).
//     Los admins siempre pasan (ver assistantChatController.checkToolPermission).
//   - `formFields`: metadata para que el frontend pueda dibujar un formulario
//     cuando falte un campo obligatorio, en vez de que Gemini tenga que
//     insistir preguntando en texto plano.
//   - `run(args, req)`: ejecuta la acción real contra Mongo. Nunca lanza:
//     siempre devuelve { success, ...} para que el controller decida cómo seguir.
import SaucersModel from "../../models/menu/saucersModel.js";
import DrinksModel from "../../models/menu/drinksModel.js";
import ExtrasModel from "../../models/menu/extrasModel.js";
import CombosModel from "../../models/menu/combosModel.js";
import InventoryModel from "../../models/inventory/inventoryModel.js";
import TablesModel from "../../models/tables/tablesModel.js";
import Order from "../../models/orders/orderModel.js";
import Invoice from "../../models/orders/invoiceModel.js";
import EmployeeModel from "../../models/users/employeeModel.js";
import { findByNameInsensitive } from "../../utils/common/duplicateNameUtils.js";

const MENU_MODELS = {
  dish: { model: SaucersModel, label: "platillo", permission: "dishes" },
  drink: { model: DrinksModel, label: "bebida", permission: "drinks" },
  extra: { model: ExtrasModel, label: "extra", permission: "extras" },
  combo: { model: CombosModel, label: "combo", permission: "combos" },
};

const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

// ---------------------------------------------------------------------------
// Herramientas de lectura/consulta
// ---------------------------------------------------------------------------

const getMenuItems = {
  declaration: {
    name: "get_menu_items",
    description: "Consulta platillos, bebidas, extras o combos del menú. Úsala para responder preguntas o antes de editar algo (para confirmar el nombre exacto).",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING", enum: ["dish", "drink", "extra", "combo"], description: "Tipo de ítem del menú" },
        onlyActive: { type: "BOOLEAN", description: "Si es true, solo trae los disponibles/activos" },
      },
      required: ["type"],
    },
  },
  permission: null, // se resuelve dinámicamente según `type`, ver checkToolPermission
  formFields: [],
  run: async (args) => {
    const cfg = MENU_MODELS[args.type];
    if (!cfg) return { success: false, message: "Tipo de menú inválido." };
    const filter = args.onlyActive ? { status: { $in: ["Activo", "activo", "disponible", "casa", "tercero"] } } : {};
    const items = await cfg.model.find(filter).select("name price status category quantity").limit(50).lean();
    return { success: true, items: items.map((i) => ({ id: i._id, name: i.name, price: i.price, status: i.status, category: i.category })) };
  },
};

const getInventoryStatus = {
  declaration: {
    name: "get_inventory_status",
    description: "Consulta el inventario: cantidades disponibles, unidad de medida y cuáles insumos están en alerta de stock bajo.",
    parameters: {
      type: "OBJECT",
      properties: {
        onlyLowStock: { type: "BOOLEAN", description: "Si es true, solo trae los insumos por debajo de su umbral de alerta" },
      },
    },
  },
  permission: "inventory",
  formFields: [],
  run: async (args) => {
    const items = await InventoryModel.find({ itemType: "producto" }).select("name quantity unit lowStockAlert pending").limit(80).lean();
    const filtered = args.onlyLowStock
      ? items.filter((i) => !i.pending && i.lowStockAlert != null && Number(i.quantity) <= Number(i.lowStockAlert))
      : items;
    return {
      success: true,
      items: filtered.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, lowStockAlert: i.lowStockAlert, pending: i.pending })),
    };
  },
};

const getTablesStatus = {
  declaration: {
    name: "get_tables_status",
    description: "Consulta el estado actual de todas las mesas (libre, ocupada, en limpieza, reservada).",
    parameters: { type: "OBJECT", properties: {} },
  },
  permission: "tables",
  formFields: [],
  run: async () => {
    const tables = await TablesModel.find().select("number status").sort({ number: 1 }).lean();
    return { success: true, tables: tables.map((t) => ({ number: t.number, status: t.status })) };
  },
};

const getOrders = {
  declaration: {
    name: "get_orders",
    description: "Consulta pedidos recientes, opcionalmente filtrados por estado o tipo.",
    parameters: {
      type: "OBJECT",
      properties: {
        status: { type: "STRING", enum: ["pending", "preparing", "ready", "delivered", "cancelled", "atrasado"] },
        orderType: { type: "STRING", enum: ["local", "online"] },
        limit: { type: "NUMBER", description: "Máximo de resultados, por defecto 10" },
      },
    },
  },
  permission: "orders",
  formFields: [],
  run: async (args) => {
    const filter = {};
    if (args.status) filter.status = args.status;
    if (args.orderType) filter.orderType = args.orderType;
    const orders = await Order.find(filter)
      .populate("table", "number")
      .populate("waiter", "name lastname")
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(args.limit) || 10, 30))
      .lean();
    return {
      success: true,
      orders: orders.map((o) => ({
        id: o._id,
        shortId: String(o._id).slice(-4).toUpperCase(),
        orderType: o.orderType,
        status: o.status,
        total: o.total,
        table: o.table?.number,
        waiter: o.waiter ? `${o.waiter.name || ""} ${o.waiter.lastname || ""}`.trim() : null,
        createdAt: o.createdAt,
      })),
    };
  },
};

const getSalesAnalytics = {
  declaration: {
    name: "get_sales_analytics",
    description: "Consulta métricas de ventas: ventas de hoy, del mes, ticket promedio y productos más vendidos. Úsala para responder preguntas con cálculos o comparaciones de ventas.",
    parameters: { type: "OBJECT", properties: {} },
  },
  permission: "orders",
  formFields: [],
  run: async () => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [todayInvoices, monthInvoices] = await Promise.all([
      Invoice.find({ issuedAt: { $gte: startOfDay } }).select("total").lean(),
      Invoice.find({ issuedAt: { $gte: startOfMonth } }).select("total items").lean(),
    ]);

    const todayTotal = todayInvoices.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const monthTotal = monthInvoices.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const avgTicket = monthInvoices.length > 0 ? monthTotal / monthInvoices.length : 0;

    const productCounts = {};
    for (const inv of monthInvoices) {
      for (const item of inv.items || []) {
        productCounts[item.name] = (productCounts[item.name] || 0) + Number(item.quantity || 0);
      }
    }
    const topProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, quantity]) => ({ name, quantity }));

    return {
      success: true,
      todayOrdersCount: todayInvoices.length,
      todayNetSales: todayTotal,
      monthOrdersCount: monthInvoices.length,
      monthNetSales: monthTotal,
      avgTicket,
      topProducts,
    };
  },
};

const getEmployees = {
  declaration: {
    name: "get_employees",
    description: "Consulta la lista de empleados, opcionalmente filtrada por puesto.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING", enum: ["kitchen", "waiter", "cashier", "manager", "cleaner", "delivery", "other"] },
      },
    },
  },
  permission: "employees",
  formFields: [],
  run: async (args) => {
    const filter = args.type ? { "personalInfo.type": args.type } : {};
    const employees = await EmployeeModel.find(filter).select("personalInfo.name personalInfo.lastname personalInfo.type workInfo.status loginInfo.email").limit(60).lean();
    return {
      success: true,
      employees: employees.map((e) => ({
        name: `${e.personalInfo?.name || ""} ${e.personalInfo?.lastname || ""}`.trim(),
        email: e.loginInfo?.email,
        type: e.personalInfo?.type,
        status: e.workInfo?.status,
      })),
    };
  },
};

const getCustomerLeaderboard = {
  declaration: {
    name: "get_customer_leaderboard",
    description: "Consulta los clientes con más pedidos o mayor gasto total (pedidos en línea entregados).",
    parameters: { type: "OBJECT", properties: {} },
  },
  permission: "clients",
  formFields: [],
  run: async () => {
    const rows = await Order.aggregate([
      { $match: { orderType: "online", status: "delivered", customer: { $ne: null } } },
      { $group: { _id: "$customer", orderCount: { $sum: 1 }, totalSpent: { $sum: "$total" } } },
      { $sort: { totalSpent: -1 } },
      { $limit: 5 },
    ]);
    const CustomerModel = (await import("../../models/users/customerModel.js")).default;
    const ids = rows.map((r) => r._id).filter(Boolean);
    const customers = await CustomerModel.find({ _id: { $in: ids } }).select("personalInfo.name personalInfo.lastname").lean();
    const map = new Map(customers.map((c) => [c._id.toString(), c]));
    return {
      success: true,
      topCustomers: rows
        .map((r) => {
          const c = map.get(r._id?.toString());
          if (!c) return null;
          return { name: `${c.personalInfo?.name || ""} ${c.personalInfo?.lastname || ""}`.trim(), orderCount: r.orderCount, totalSpent: r.totalSpent };
        })
        .filter(Boolean),
    };
  },
};

const getEmployeeLeaderboard = {
  declaration: {
    name: "get_employee_leaderboard",
    description: "Consulta qué empleado vendió más (pedidos locales entregados), filtrable por día, semana o mes.",
    parameters: {
      type: "OBJECT",
      properties: { period: { type: "STRING", enum: ["day", "week", "month"], description: "Por defecto 'week'" } },
    },
  },
  permission: "employees",
  formFields: [],
  run: async (args) => {
    const period = ["day", "month"].includes(args.period) ? args.period : "week";
    const now = new Date();
    let start;
    if (period === "day") { start = new Date(now); start.setHours(0, 0, 0, 0); }
    else if (period === "month") { start = new Date(now.getFullYear(), now.getMonth(), 1); }
    else { start = new Date(now); const dow = start.getDay(); start.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1)); start.setHours(0, 0, 0, 0); }

    const rows = await Order.aggregate([
      { $match: { orderType: "local", status: "delivered", waiter: { $ne: null }, createdAt: { $gte: start } } },
      { $group: { _id: "$waiter", orderCount: { $sum: 1 }, totalSales: { $sum: "$total" } } },
      { $sort: { totalSales: -1 } },
      { $limit: 5 },
    ]);
    const ids = rows.map((r) => r._id).filter(Boolean);
    const employees = await EmployeeModel.find({ _id: { $in: ids } }).select("personalInfo.name personalInfo.lastname").lean();
    const map = new Map(employees.map((e) => [e._id.toString(), e]));
    return {
      success: true,
      period,
      topEmployees: rows
        .map((r) => {
          const e = map.get(r._id?.toString());
          if (!e) return null;
          return { name: `${e.personalInfo?.name || ""} ${e.personalInfo?.lastname || ""}`.trim(), orderCount: r.orderCount, totalSales: r.totalSales };
        })
        .filter(Boolean),
    };
  },
};

// ---------------------------------------------------------------------------
// Herramientas de escritura
// ---------------------------------------------------------------------------

const createMenuItem = (type) => ({
  declaration: {
    name: `create_${type}`,
    description: `Registra un nuevo ${MENU_MODELS[type].label} en el menú.`,
    parameters: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING", description: "Nombre" },
        price: { type: "NUMBER", description: "Precio en USD, mayor a 0" },
        category:
          type === "dish"
            ? { type: "STRING", enum: ["Burritos", "Tortas", "Tacos", "Sopas", "Especiales"] }
            : type === "drink"
            ? { type: "STRING", enum: ["casa", "tercero"], description: "'casa' se prepara en el local, 'tercero' viene embotellada" }
            : { type: "STRING", description: "Categoría libre" },
        description: { type: "STRING", description: "Descripción breve (opcional)" },
      },
      required: type === "extra" ? ["name", "price"] : ["name", "price", "category"],
    },
  },
  permission: MENU_MODELS[type].permission,
  formFields: [
    { name: "name", label: "Nombre", type: "text", required: true },
    { name: "price", label: "Precio", type: "number", required: true },
    ...(type !== "extra"
      ? [{
          name: "category",
          label: "Categoría",
          type: "select",
          required: true,
          options: type === "dish" ? ["Burritos", "Tortas", "Tacos", "Sopas", "Especiales"] : ["casa", "tercero"],
        }]
      : []),
  ],
  run: async (args) => {
    const cfg = MENU_MODELS[type];
    const name = String(args.name || "").trim();
    if (name.length < 3) return { success: false, message: "El nombre debe tener al menos 3 caracteres." };
    const price = num(args.price);
    if (!price || price <= 0) return { success: false, message: "El precio debe ser mayor a 0." };

    const existing = await findByNameInsensitive(cfg.model, name);
    if (existing) {
      return { success: false, message: `Ya existe un ${cfg.label} llamado "${existing.name}".` };
    }

    const doc = new cfg.model({
      name,
      price,
      category: args.category,
      description: args.description || undefined,
      status: type === "dish" ? "Activo" : "disponible",
    });
    await doc.save();
    return { success: true, item: { id: doc._id, name: doc.name, price: doc.price } };
  },
});

const adjustInventoryStock = {
  declaration: {
    name: "adjust_inventory_stock",
    description: "Suma o resta una cantidad al stock de un insumo de inventario ya existente (usa deltaQuantity negativo para restar).",
    parameters: {
      type: "OBJECT",
      properties: {
        itemName: { type: "STRING", description: "Nombre exacto o aproximado del insumo" },
        deltaQuantity: { type: "NUMBER", description: "Cantidad a sumar (positiva) o restar (negativa)" },
      },
      required: ["itemName", "deltaQuantity"],
    },
  },
  permission: "inventory_adjust_stock",
  formFields: [
    { name: "itemName", label: "Insumo", type: "text", required: true },
    { name: "deltaQuantity", label: "Cantidad a sumar/restar", type: "number", required: true },
  ],
  run: async (args) => {
    const item = await findByNameInsensitive(InventoryModel, args.itemName);
    if (!item) return { success: false, message: `No encontré ningún insumo llamado "${args.itemName}".` };
    const delta = num(args.deltaQuantity);
    if (delta === undefined) return { success: false, message: "La cantidad debe ser un número." };
    const newQuantity = Number(item.quantity || 0) + delta;
    if (newQuantity < 0) return { success: false, message: `${item.name} solo tiene ${item.quantity} ${item.unit || "unidades"}, no se puede restar ${Math.abs(delta)}.` };
    item.quantity = newQuantity;
    await item.save();
    return { success: true, item: { name: item.name, quantity: item.quantity, unit: item.unit } };
  },
};

const updateTableStatus = {
  declaration: {
    name: "update_table_status",
    description: "Cambia el estado de una mesa.",
    parameters: {
      type: "OBJECT",
      properties: {
        tableNumber: { type: "NUMBER", description: "Número de la mesa" },
        status: { type: "STRING", enum: ["libre", "ocupada", "limpieza", "reservada"] },
      },
      required: ["tableNumber", "status"],
    },
  },
  permission: "tables_change_status",
  formFields: [
    { name: "tableNumber", label: "Número de mesa", type: "number", required: true },
    { name: "status", label: "Nuevo estado", type: "select", required: true, options: ["libre", "ocupada", "limpieza", "reservada"] },
  ],
  run: async (args) => {
    const table = await TablesModel.findOne({ number: num(args.tableNumber) });
    if (!table) return { success: false, message: `No encontré la mesa ${args.tableNumber}.` };
    table.status = args.status;
    await table.save();
    return { success: true, table: { number: table.number, status: table.status } };
  },
};

const updateOrderStatus = {
  declaration: {
    name: "update_order_status",
    description: "Cambia el estado de un pedido (identificado por los últimos 4 caracteres de su ID, visibles en Pedidos y Órdenes).",
    parameters: {
      type: "OBJECT",
      properties: {
        orderShortId: { type: "STRING", description: "Últimos 4 caracteres del ID del pedido" },
        status: { type: "STRING", enum: ["pending", "preparing", "ready", "delivered", "cancelled"] },
      },
      required: ["orderShortId", "status"],
    },
  },
  permission: "orders",
  formFields: [
    { name: "orderShortId", label: "ID corto del pedido", type: "text", required: true },
    { name: "status", label: "Nuevo estado", type: "select", required: true, options: ["pending", "preparing", "ready", "delivered", "cancelled"] },
  ],
  run: async (args) => {
    const shortId = String(args.orderShortId || "").trim().toUpperCase();
    if (shortId.length < 3) return { success: false, message: "Necesito al menos los últimos 4 caracteres del ID del pedido." };
    const candidates = await Order.find({ status: { $ne: "delivered" } }).select("_id status").limit(200).lean();
    const match = candidates.find((o) => String(o._id).slice(-4).toUpperCase() === shortId);
    if (!match) return { success: false, message: `No encontré ningún pedido activo que termine en "${shortId}".` };
    await Order.findByIdAndUpdate(match._id, { $set: { status: args.status }, $push: { statusHistory: { status: args.status, changedAt: new Date() } } });
    return { success: true, order: { shortId, status: args.status } };
  },
};

const setEmployeeStatus = {
  declaration: {
    name: "set_employee_status",
    description: "Da de alta o de baja a un empleado (activa/desactiva su cuenta).",
    parameters: {
      type: "OBJECT",
      properties: {
        employeeEmail: { type: "STRING", description: "Correo del empleado" },
        status: { type: "STRING", enum: ["active", "inactive"] },
      },
      required: ["employeeEmail", "status"],
    },
  },
  permission: "employees_manage_status",
  formFields: [
    { name: "employeeEmail", label: "Correo del empleado", type: "text", required: true },
    { name: "status", label: "Nuevo estado", type: "select", required: true, options: ["active", "inactive"] },
  ],
  run: async (args) => {
    const employee = await EmployeeModel.findOne({ "loginInfo.email": String(args.employeeEmail || "").toLowerCase().trim() });
    if (!employee) return { success: false, message: `No encontré ningún empleado con el correo "${args.employeeEmail}".` };
    employee.workInfo.status = args.status;
    await employee.save();
    const name = `${employee.personalInfo?.name || ""} ${employee.personalInfo?.lastname || ""}`.trim();
    return { success: true, employee: { name, status: employee.workInfo.status } };
  },
};

const updateMenuItemPrice = {
  declaration: {
    name: "update_menu_item_price",
    description: "Cambia el precio de un platillo, bebida, extra o combo existente.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING", enum: ["dish", "drink", "extra", "combo"] },
        name: { type: "STRING", description: "Nombre exacto o aproximado del ítem" },
        newPrice: { type: "NUMBER" },
      },
      required: ["type", "name", "newPrice"],
    },
  },
  permission: null,
  formFields: [
    { name: "type", label: "Tipo", type: "select", required: true, options: ["dish", "drink", "extra", "combo"] },
    { name: "name", label: "Nombre del ítem", type: "text", required: true },
    { name: "newPrice", label: "Precio nuevo", type: "number", required: true },
  ],
  run: async (args) => {
    const cfg = MENU_MODELS[args.type];
    if (!cfg) return { success: false, message: "Tipo de menú inválido." };
    const price = num(args.newPrice);
    if (!price || price <= 0) return { success: false, message: "El precio debe ser mayor a 0." };
    const item = await findByNameInsensitive(cfg.model, args.name);
    if (!item) return { success: false, message: `No encontré ningún ${cfg.label} llamado "${args.name}".` };
    item.price = price;
    await item.save();
    return { success: true, item: { name: item.name, price: item.price } };
  },
};

export const ASSISTANT_TOOLS = {
  get_menu_items: getMenuItems,
  get_inventory_status: getInventoryStatus,
  get_tables_status: getTablesStatus,
  get_orders: getOrders,
  get_sales_analytics: getSalesAnalytics,
  get_employees: getEmployees,
  get_customer_leaderboard: getCustomerLeaderboard,
  get_employee_leaderboard: getEmployeeLeaderboard,
  create_dish: createMenuItem("dish"),
  create_drink: createMenuItem("drink"),
  create_extra: createMenuItem("extra"),
  adjust_inventory_stock: adjustInventoryStock,
  update_table_status: updateTableStatus,
  update_order_status: updateOrderStatus,
  set_employee_status: setEmployeeStatus,
  update_menu_item_price: updateMenuItemPrice,
};

// Algunas herramientas resuelven el permiso según el `type` que mande Gemini
// en sus argumentos (ej. get_menu_items/update_menu_item_price sirven para
// los 4 tipos de menú, cada uno con su propio permiso de pantalla).
export const resolveToolPermission = (toolName, args = {}) => {
  const tool = ASSISTANT_TOOLS[toolName];
  if (!tool) return undefined;
  if (tool.permission) return tool.permission;
  if (args.type && MENU_MODELS[args.type]) return MENU_MODELS[args.type].permission;
  return null; // sin restricción específica más allá de tener sesión
};

export default { ASSISTANT_TOOLS, resolveToolPermission };
