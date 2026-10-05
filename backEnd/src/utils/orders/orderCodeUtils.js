// Código de orden que ven clientes, personal y Panchita: tipo + día + número
// del día para ese tipo, en hora de El Salvador.
//
//   AD27-01 → A domicilio, día 27, primer pedido a domicilio del día
//   CL27-01 → Comer en el local (reserva desde la app o comanda del mesero)
//   PL27-01 → Para llevar (el cliente pasa a traerlo)
//
// Se genera una sola vez, al crear el pedido (hook de orderModel), y se
// guarda en `code`. Todas las pantallas muestran ese mismo valor: antes cada
// una recortaba el id por su cuenta (4, 5 o 6 caracteres) y el mismo pedido
// aparecía con números distintos.
//
// El día se repite cada mes, así que el código no es único para siempre:
// para buscar un pedido por código se usa junto con el cliente o la fecha.
import mongoose from "mongoose";
import OrderCounter from "../../models/orders/orderCounterModel.js";
import { BRANCH } from "../../constants/branch.js";

export const ORDER_CODE_PREFIXES = { delivery: "AD", dine_in: "CL", pickup: "PL" };

export const orderCodePrefix = (order) => {
    if (order.orderType === "local" || order.fulfillment === "dine_in") return ORDER_CODE_PREFIXES.dine_in;
    if (order.fulfillment === "delivery" || (!order.fulfillment && order.isDelivery)) return ORDER_CODE_PREFIXES.delivery;
    return ORDER_CODE_PREFIXES.pickup;
};

// Fecha en hora de El Salvador, como Date "desplazada" (leer con getUTC*).
const localDate = (date) => new Date(new Date(date).getTime() + BRANCH.utcOffsetMinutes * 60 * 1000);

export const nextOrderCode = async (order, date = new Date()) => {
    const local = localDate(date);
    const prefix = orderCodePrefix(order);
    const counter = await OrderCounter.findOneAndUpdate(
        { _id: `${local.toISOString().slice(0, 10)}:${prefix}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" },
    );
    const day = String(local.getUTCDate()).padStart(2, "0");
    return `${prefix}${day}-${String(counter.seq).padStart(2, "0")}`;
};

// Número de cocina: 1, 2, 3... en el orden en que llegan los pedidos del día
// (hora de El Salvador), sin importar el tipo. El código ("CL27-03") sigue
// siendo el identificador de siempre; este número es solo un apodo corto
// para la cocina, fácil de leer en el ticket y de decirle a Chef Panchita
// ("marca la orden 3 como lista"). Se reinicia cada día.
export const nextKitchenNumber = async (date = new Date()) => {
    const local = localDate(date);
    const counter = await OrderCounter.findOneAndUpdate(
        { _id: `${local.toISOString().slice(0, 10)}:COCINA` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" },
    );
    return counter.seq;
};

// El código de un pedido (o de su id, si no se tiene el documento poblado).
// Los pedidos anteriores a este sistema ya tienen código (scripts/backfillOrderCodes.js);
// el recorte del id queda solo como respaldo.
export const orderCode = (orderOrId) => {
    if (orderOrId && typeof orderOrId === "object" && orderOrId.code) return orderOrId.code;
    const id = orderOrId?._id || orderOrId;
    return String(id || "").slice(-6).toUpperCase();
};

// Igual que orderCode, pero si solo se tiene el id lo busca en la base (el
// modelo se pide por nombre porque orderModel importa este archivo).
export const findOrderCode = async (orderOrId) => {
    if (orderOrId && typeof orderOrId === "object" && orderOrId.code) return orderOrId.code;
    const id = orderOrId?._id || orderOrId;
    if (!id) return "";
    const doc = await mongoose.model("Order").findById(id).select("code").lean();
    return orderCode(doc || id);
};

// Normaliza lo que escribe alguien ("#ad27-1", "AD 27-01") al formato guardado.
export const normalizeOrderCode = (text) => {
    const match = String(text || "").toUpperCase().replace(/[#\s]/g, "").match(/^(AD|CL|PL)(\d{1,2})-?(\d{1,3})$/);
    if (!match) return null;
    return `${match[1]}${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
};

export default { orderCodePrefix, nextOrderCode, nextKitchenNumber, orderCode, findOrderCode, normalizeOrderCode };
