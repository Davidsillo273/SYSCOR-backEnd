// Asigna el código de orden (AD27-01, CL27-01, PL27-01) a los pedidos que se
// crearon antes de que existiera. Va del más antiguo al más nuevo, usando la
// fecha de creación de cada uno, así que el contador de cada día queda al
// día y los pedidos nuevos siguen la numeración. Solo toca pedidos sin
// código: correrlo de nuevo no cambia nada. Con --dry-run solo muestra qué haría.
//
//   node scripts/backfillOrderCodes.js --dry-run
//   node scripts/backfillOrderCodes.js
import mongoose from "mongoose";
import { config } from "../config.js";
import Order from "../src/models/orders/orderModel.js";
import Invoice from "../src/models/orders/invoiceModel.js";
import { nextOrderCode, orderCodePrefix } from "../src/utils/orders/orderCodeUtils.js";

const DRY_RUN = process.argv.includes("--dry-run");

await mongoose.connect(config.db.uri);

const orders = await Order.find({ $or: [{ code: { $exists: false } }, { code: null }] })
    .select("orderType fulfillment isDelivery createdAt")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

// En simulación se cuenta en memoria para no mover los contadores reales.
const dryCounters = new Map();
for (const order of orders) {
    let code;
    if (DRY_RUN) {
        const local = new Date(new Date(order.createdAt).getTime() - 6 * 3600 * 1000);
        const key = `${local.toISOString().slice(0, 10)}:${orderCodePrefix(order)}`;
        dryCounters.set(key, (dryCounters.get(key) || 0) + 1);
        code = `${orderCodePrefix(order)}${String(local.getUTCDate()).padStart(2, "0")}-${String(dryCounters.get(key)).padStart(2, "0")}`;
    } else {
        code = await nextOrderCode(order, order.createdAt);
        await Order.updateOne({ _id: order._id }, { $set: { code } });
        await Invoice.updateMany({ order: order._id }, { $set: { orderCode: code } });
    }
    console.log(`${DRY_RUN ? "[dry-run] " : ""}${order._id} ${new Date(order.createdAt).toISOString()} → ${code}`);
}
console.log(`${DRY_RUN ? "[dry-run] " : ""}${orders.length} pedidos con código nuevo.`);

await mongoose.disconnect();
