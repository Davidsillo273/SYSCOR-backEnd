// Cuentas de la caja: IVA, documentos simulados (DTE), resumen del turno y
// validación de los datos del Crédito Fiscal.
import crypto from "crypto";
import OrderCounter from "../../models/orders/orderCounterModel.js";
import CashSession from "../../models/cashier/cashSessionModel.js";
import { ISSUER, IVA_RATE, DOCUMENT_TYPES } from "../../constants/fiscal.js";

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Los precios del menú llevan el IVA incluido: aquí se desglosa.
//   total 11.30 → base 10.00 + IVA 1.30
export const splitIva = (total) => {
    const base = round2(total / (1 + IVA_RATE));
    return { base, iva: round2(total - base) };
};

// Correlativo propio de cada tipo de documento (no se reinicia por día)
export const nextDocumentCorrelative = async (documentType) => {
    const { code } = DOCUMENT_TYPES[documentType];
    const counter = await OrderCounter.findOneAndUpdate(
        { _id: `DTE:${code}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" },
    );
    return counter.seq;
};

// Número de control con el formato de Hacienda:
//   DTE-01-M001P001-000000000000123
export const controlNumberFor = (documentType, correlative) =>
    `DTE-${DOCUMENT_TYPES[documentType].code}-${ISSUER.establishmentCode}${ISSUER.pointOfSaleCode}-${String(correlative).padStart(15, "0")}`;

export const newGenerationCode = () => crypto.randomUUID().toUpperCase();

// Sello de recepción simulado (el real lo devuelve Hacienda al transmitir)
export const newReceptionSeal = (date = new Date()) =>
    `${date.getFullYear()}${crypto.randomBytes(18).toString("hex").toUpperCase()}`;

// Autorización simulada del POS de tarjeta
export const newAuthorizationCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

// "T-1010-02": mes y día + correlativo del día
export const nextSessionCode = async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const count = await CashSession.countDocuments({ openedAt: { $gte: start } });
    const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    return `T-${mmdd}-${String(count + 1).padStart(2, "0")}`;
};

// --- Crédito Fiscal: datos del receptor ---
const NIT_RE = /^(\d{4}-?\d{6}-?\d{3}-?\d|\d{8}-?\d)$/; // NIT de 14 dígitos o DUI homologado
const NRC_RE = /^\d{1,7}-?\d$/;

const clean = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/**
 * Valida al receptor. En Crédito Fiscal son obligatorios nombre, NIT, NRC,
 * giro y dirección; en Factura solo se guarda el nombre si lo dieron.
 * Devuelve { customer } o { error }.
 */
export const parseReceiptCustomer = (documentType, raw = {}) => {
    const customer = {
        name: clean(raw.name, 120) || null,
        nit: clean(raw.nit, 20) || null,
        nrc: clean(raw.nrc, 12) || null,
        activity: clean(raw.activity, 120) || null,
        address: clean(raw.address, 200) || null,
        email: clean(raw.email, 120).toLowerCase() || null,
    };

    if (documentType === "ccf") {
        if (!customer.name) return { error: "Escribe el nombre o razón social del cliente." };
        if (!customer.nit || !NIT_RE.test(customer.nit)) return { error: "El NIT no es válido (14 dígitos, o el DUI de 9)." };
        if (!customer.nrc || !NRC_RE.test(customer.nrc)) return { error: "El NRC no es válido." };
        if (!customer.activity) return { error: "Escribe el giro o actividad económica del cliente." };
        if (!customer.address) return { error: "Escribe la dirección del cliente." };
    }
    if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
        return { error: "El correo del cliente no es válido." };
    }
    return { customer };
};

/**
 * Resumen de un turno a partir de sus comprobantes: lo que se vendió, cómo
 * se pagó y cuánto efectivo debería haber en la gaveta.
 */
export const summarizeSession = (session, receipts) => {
    const byMethod = { cash: { count: 0, amount: 0 }, card: { count: 0, amount: 0 } };
    const byDocument = { fcf: { count: 0, total: 0 }, ccf: { count: 0, total: 0 } };
    const bySource = { table: { count: 0, total: 0 }, pickup: { count: 0, total: 0 }, counter: { count: 0, total: 0 } };
    let sales = 0;
    let base = 0;
    let iva = 0;
    let tips = 0;
    let creditApplied = 0;

    for (const r of receipts) {
        sales += r.total;
        base += r.base;
        iva += r.iva;
        tips += r.tip || 0;
        creditApplied += r.creditApplied || 0;
        byMethod[r.payment.method].count += 1;
        byMethod[r.payment.method].amount += r.amountDue;
        byDocument[r.documentType].count += 1;
        byDocument[r.documentType].total += r.total;
        bySource[r.source.kind].count += 1;
        bySource[r.source.kind].total += r.total;
    }

    const movementsIn = (session.movements || []).filter((m) => m.type === "in").reduce((s, m) => s + m.amount, 0);
    const movementsOut = (session.movements || []).filter((m) => m.type === "out").reduce((s, m) => s + m.amount, 0);
    const expectedCash = (session.openingFloat || 0) + byMethod.cash.amount + movementsIn - movementsOut;

    const roundGroup = (group) =>
        Object.fromEntries(Object.entries(group).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, round2(vv)]))]));

    return {
        receipts: receipts.length,
        sales: round2(sales),
        base: round2(base),
        iva: round2(iva),
        tips: round2(tips),
        creditApplied: round2(creditApplied),
        collected: round2(byMethod.cash.amount + byMethod.card.amount),
        byMethod: roundGroup(byMethod),
        byDocument: roundGroup(byDocument),
        bySource: roundGroup(bySource),
        openingFloat: round2(session.openingFloat || 0),
        movementsIn: round2(movementsIn),
        movementsOut: round2(movementsOut),
        expectedCash: round2(expectedCash),
    };
};

// Lo que ven la caja y el panel de un turno
export const publicSession = (session, summary = null) => ({
    id: session._id,
    code: session.code,
    deviceId: session.deviceId,
    cashier: { id: session.cashier?.id, name: session.cashier?.name },
    openedBy: session.openedBy?.name || null,
    openingFloat: session.openingFloat,
    openedAt: session.openedAt,
    status: session.status,
    movements: (session.movements || []).map((m) => ({
        id: m._id, type: m.type, amount: m.amount, reason: m.reason, at: m.at,
    })),
    closedAt: session.closedAt,
    closedBy: session.closedBy?.name ? session.closedBy : null,
    countedCash: session.countedCash,
    expectedCash: session.expectedCash,
    difference: session.difference,
    closingNotes: session.closingNotes,
    summary: summary || session.summary || null,
});

export default {
    round2,
    splitIva,
    nextDocumentCorrelative,
    controlNumberFor,
    newGenerationCode,
    newReceptionSeal,
    newAuthorizationCode,
    nextSessionCode,
    parseReceiptCustomer,
    summarizeSession,
    publicSession,
};
