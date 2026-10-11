// Facturas de COMPRA (las que el negocio recibe de sus proveedores) y el
// reporte de IVA que cruza compras contra ventas.
//
// Las de VENTA las genera el sistema solo (invoiceController); estas las sube
// el usuario, porque llegan en papel/PDF desde el proveedor.
import PurchaseInvoice from "../../models/orders/purchaseInvoiceModel.js";
import Invoice from "../../models/orders/invoiceModel.js";
import { cloudinary } from "../../utils/cloudinaryConfig.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import {
    DOCUMENT_CLASSES, DOCUMENT_TYPES, OPERATION_TYPES, CLASSIFICATIONS,
    SECTORS, COST_TYPES, PURCHASE_ANNEX, BOOK_AMOUNT_FIELDS,
} from "../../utils/orders/purchaseBookCatalogs.js";

const purchaseInvoiceController = {};

// Tasa de IVA de El Salvador. Se usa solo para DESGLOSAR el IVA de las ventas
// (cuyo total ya lo lleva incluido); en las compras manda el monto que trae
// impreso la factura del proveedor, no este cálculo.
const IVA_RATE = 0.13;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Igual que payrollController: "AAAA-MM" -> rango de fechas del mes.
const resolvePeriod = (periodParam) => {
    const now = new Date();
    const raw = typeof periodParam === "string" && /^\d{4}-\d{2}$/.test(periodParam)
        ? periodParam
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const [year, month] = raw.split("-").map(Number);
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 0, 23, 59, 59, 999);

    return { period: raw, start, end };
};

// --- Facturas de compra ---

// Lista las facturas de compra, opcionalmente filtradas por período y por si
// ya se procesaron para IVA.
purchaseInvoiceController.getPurchaseInvoices = async (req, res) => {
    try {
        const filter = {};

        // El filtro por período es opcional aquí (a diferencia del reporte):
        // sin él se ve el historial completo.
        if (req.query.period) {
            const { start, end } = resolvePeriod(req.query.period);
            filter.issuedAt = { $gte: start, $lte: end };
        }

        if (req.query.processed === "true") filter.processedForTax = true;
        if (req.query.processed === "false") filter.processedForTax = false;
        if (req.query.category) filter.category = req.query.category;

        const invoices = await PurchaseInvoice.find(filter).sort({ issuedAt: -1 });
        return res.status(200).json(invoices);
    } catch (error) {
        console.error("purchaseInvoiceController.getPurchaseInvoices:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudieron obtener las facturas de compra." });
    }
};

// Campos de texto opcionales: vacío se guarda como null.
const OPTIONAL_TEXT_FIELDS = ["supplierTaxId", "supplierNrc", "supplierDui", "series", "notes"];

// Campos de catálogo del libro, con el catálogo que valida cada uno.
const CATALOG_FIELDS = {
    documentClass: DOCUMENT_CLASSES,
    documentType: DOCUMENT_TYPES,
    operationType: OPERATION_TYPES,
    classification: CLASSIFICATIONS,
    sector: SECTORS,
    costType: COST_TYPES,
};

/**
 * Lee y valida del body los datos de una factura de compra. Lo comparten el
 * registro y la edición: en la edición (partial = true) solo se toman los
 * campos que vengan, para no pisar con vacíos lo que ya estaba guardado.
 *
 * Devuelve { data } o { error } con el mensaje para el usuario.
 */
const parsePurchaseInvoiceBody = (body, { partial = false } = {}) => {
    const has = (key) => body[key] !== undefined;
    const data = {};

    for (const key of ["supplierName", "invoiceNumber"]) {
        if (has(key)) data[key] = String(body[key]).trim();
    }
    if (has("issuedAt")) {
        // "AAAA-MM-DD" (lo que manda un <input type=date>) se lee como día
        // LOCAL a mediodía: new Date("2026-07-01") sería medianoche UTC, que
        // en El Salvador cae el 30 de junio y cambiaría el período fiscal.
        const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.issuedAt));
        const date = ymd
            ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12, 0, 0, 0)
            : new Date(body.issuedAt);
        if (Number.isNaN(date.getTime())) return { error: "La fecha de la factura no es válida." };
        data.issuedAt = date;
    }
    if (!partial && (!data.supplierName || !data.invoiceNumber || !data.issuedAt)) {
        return { error: "El proveedor, el número de factura y la fecha son obligatorios." };
    }
    if (partial && (data.supplierName === "" || data.invoiceNumber === "")) {
        return { error: "El proveedor y el número de factura no pueden quedar vacíos." };
    }

    for (const key of OPTIONAL_TEXT_FIELDS) {
        if (has(key)) data[key] = String(body[key]).trim() || null;
    }

    for (const [key, catalog] of Object.entries(CATALOG_FIELDS)) {
        if (!has(key) || body[key] === "") continue;
        if (!catalog[body[key]]) return { error: `El valor de "${key}" no es válido.` };
        data[key] = String(body[key]);
    }

    if (has("category")) data.category = body.category || "insumos";

    // Montos: cada columna del libro, el IVA y la retención. En la edición
    // un monto vacío se toma como 0 (el usuario borró esa columna).
    for (const key of [...BOOK_AMOUNT_FIELDS, "tax", "ivaWithheld"]) {
        if (!has(key)) continue;
        const value = body[key] === "" ? 0 : Number(body[key]);
        if (Number.isNaN(value) || value < 0) {
            return { error: "Los montos deben ser números válidos, mayores o iguales a cero." };
        }
        data[key] = round2(value);
    }

    // Compatibilidad con el formulario anterior, que mandaba solo "subtotal":
    // ese monto es una compra interna gravada.
    if (has("subtotal") && !BOOK_AMOUNT_FIELDS.some(has)) {
        const value = Number(body.subtotal);
        if (Number.isNaN(value) || value < 0) return { error: "El subtotal debe ser un número válido." };
        data.internalTaxed = round2(value);
    }

    if (!partial) {
        const base = BOOK_AMOUNT_FIELDS.reduce((acc, f) => acc + (data[f] || 0), 0);
        if (base <= 0) return { error: "La compra debe tener al menos un monto mayor que cero." };
    }

    return { data };
};

// Registra una factura de compra. El archivo (PDF o imagen) es opcional: a
// veces se registra el monto primero y el comprobante se adjunta después.
purchaseInvoiceController.createPurchaseInvoice = async (req, res) => {
    try {
        const { data, error } = parsePurchaseInvoiceBody(req.body);
        if (error) {
            return res.status(400).json({ title: "Datos inválidos", message: error });
        }

        // Una misma factura del mismo proveedor no debería registrarse dos
        // veces: duplicarla inflaría el crédito fiscal declarado.
        const duplicate = await PurchaseInvoice.findOne({
            supplierName: data.supplierName,
            invoiceNumber: data.invoiceNumber,
        });

        if (duplicate) {
            return res.status(409).json({
                title: "Factura duplicada",
                message: `Ya existe una factura ${data.invoiceNumber} de ${data.supplierName}.`,
            });
        }

        // subtotal y total los recalcula el modelo a partir del desglose.
        const newInvoice = new PurchaseInvoice({
            ...data,
            subtotal: 0,
            total: 0,
            // Mismo patrón que el resto del proyecto: multer-storage-cloudinary
            // deja la URL en req.file.path y el publicId en req.file.filename.
            ...(req.file ? {
                fileUrl: req.file.path,
                filePublicId: req.file.filename,
                fileName: req.file.originalname || null,
            } : {}),
        });

        await newInvoice.save();

        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "created",
            title: "Factura de compra registrada",
            message: (actor) =>
                `${actor.name} registró la factura ${newInvoice.invoiceNumber} de ${newInvoice.supplierName} ($${newInvoice.total.toFixed(2)})`,
            icon: "receipt",
            severity: "info",
            entity: { model: "PurchaseInvoice", id: newInvoice._id, label: `Factura ${newInvoice.invoiceNumber}` },
        });

        return res.status(201).json({
            title: "Factura registrada",
            message: "La factura de compra se guardó correctamente.",
            data: newInvoice,
        });
    } catch (error) {
        console.error("purchaseInvoiceController.createPurchaseInvoice:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo registrar la factura de compra." });
    }
};

// Corrige una factura ya registrada. Sirve sobre todo para completar los
// datos del Libro de Compras (NRC, clase y tipo de documento, desglose) en
// las facturas que se registraron antes de que existiera el libro.
purchaseInvoiceController.updatePurchaseInvoice = async (req, res) => {
    try {
        const invoice = await PurchaseInvoice.findById(req.params.id);
        if (!invoice) {
            return res.status(404).json({ title: "Factura no encontrada", message: "No se encontró la factura solicitada." });
        }

        const { data, error } = parsePurchaseInvoiceBody(req.body, { partial: true });
        if (error) {
            return res.status(400).json({ title: "Datos inválidos", message: error });
        }

        // Si cambian el número o el proveedor, no puede chocar con otra factura.
        const supplierName = data.supplierName ?? invoice.supplierName;
        const invoiceNumber = data.invoiceNumber ?? invoice.invoiceNumber;
        const duplicate = await PurchaseInvoice.findOne({
            _id: { $ne: invoice._id },
            supplierName,
            invoiceNumber,
        });
        if (duplicate) {
            return res.status(409).json({
                title: "Factura duplicada",
                message: `Ya existe una factura ${invoiceNumber} de ${supplierName}.`,
            });
        }

        invoice.set(data);

        const base = BOOK_AMOUNT_FIELDS.reduce((acc, f) => acc + (Number(invoice[f]) || 0), 0);
        if (base <= 0) {
            return res.status(400).json({ title: "Datos inválidos", message: "La compra debe tener al menos un monto mayor que cero." });
        }

        // Un comprobante nuevo reemplaza al anterior, que se borra de Cloudinary.
        if (req.file) {
            const previousPublicId = invoice.filePublicId;
            invoice.fileUrl = req.file.path;
            invoice.filePublicId = req.file.filename;
            invoice.fileName = req.file.originalname || null;
            if (previousPublicId) {
                cloudinary.uploader.destroy(previousPublicId).catch((cloudError) => {
                    console.error("purchaseInvoiceController: no se pudo borrar el archivo anterior:", cloudError);
                });
            }
        }

        await invoice.save();

        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "updated",
            title: "Factura de compra actualizada",
            message: (actor) =>
                `${actor.name} actualizó la factura ${invoice.invoiceNumber} de ${invoice.supplierName}`,
            icon: "pen",
            severity: "info",
            entity: { model: "PurchaseInvoice", id: invoice._id, label: `Factura ${invoice.invoiceNumber}` },
        });

        return res.status(200).json({
            title: "Factura actualizada",
            message: "La factura de compra se actualizó correctamente.",
            data: invoice,
        });
    } catch (error) {
        console.error("purchaseInvoiceController.updatePurchaseInvoice:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo actualizar la factura de compra." });
    }
};

// Marca o desmarca una factura como ya incluida en la declaración de IVA.
purchaseInvoiceController.toggleProcessed = async (req, res) => {
    try {
        const { processedForTax } = req.body;

        const invoice = await PurchaseInvoice.findById(req.params.id);
        if (!invoice) {
            return res.status(404).json({ title: "Factura no encontrada", message: "No se encontró la factura solicitada." });
        }

        // Si no mandan el valor, se alterna el actual (útil para un switch).
        const newValue = typeof processedForTax === "boolean" ? processedForTax : !invoice.processedForTax;

        invoice.processedForTax = newValue;
        invoice.processedAt = newValue ? new Date() : null;

        if (newValue) {
            // Se guarda quién la procesó, para poder rastrear después quién
            // incluyó qué en cada declaración.
            const actor = await notificationUtils.resolveActor(req);
            invoice.processedBy = { id: actor.id, name: actor.name };
        } else {
            invoice.processedBy = { id: null, name: null };
        }

        await invoice.save();

        return res.status(200).json({
            title: newValue ? "Factura procesada" : "Marca retirada",
            message: newValue
                ? "La factura quedó marcada como procesada para IVA."
                : "La factura volvió a quedar pendiente de procesar.",
            data: invoice,
        });
    } catch (error) {
        console.error("purchaseInvoiceController.toggleProcessed:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo actualizar la factura." });
    }
};

// Elimina una factura de compra (ej. se registró por error).
purchaseInvoiceController.deletePurchaseInvoice = async (req, res) => {
    try {
        const invoice = await PurchaseInvoice.findByIdAndDelete(req.params.id);
        if (!invoice) {
            return res.status(404).json({ title: "Factura no encontrada", message: "No se encontró la factura solicitada." });
        }

        // El archivo respaldo ya no le sirve a nadie: se borra también de
        // Cloudinary para no dejar basura acumulándose ahí.
        if (invoice.filePublicId) {
            try {
                await cloudinary.uploader.destroy(invoice.filePublicId, { resource_type: "raw" });
                await cloudinary.uploader.destroy(invoice.filePublicId);
            } catch (cloudError) {
                // Igual que cloudinaryUtils.deletePreviousImage: si falla el
                // borrado del archivo, el registro igual se eliminó y eso es
                // lo que importa.
                console.error("purchaseInvoiceController: no se pudo borrar el archivo:", cloudError);
            }
        }

        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "deleted",
            title: "Factura de compra eliminada",
            message: (actor) =>
                `${actor.name} eliminó la factura ${invoice.invoiceNumber} de ${invoice.supplierName}`,
            icon: "trash",
            severity: "danger",
            entity: { model: "PurchaseInvoice", id: invoice._id, label: `Factura ${invoice.invoiceNumber}` },
        });

        return res.status(200).json({ title: "Factura eliminada", message: "La factura de compra se eliminó correctamente." });
    } catch (error) {
        console.error("purchaseInvoiceController.deletePurchaseInvoice:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo eliminar la factura." });
    }
};

// --- Reporte de IVA ---

/**
 * Cruza las ventas del período contra las compras, que es lo que el contador
 * necesita para declarar:
 *
 *   - Débito fiscal  = IVA cobrado en las ventas
 *   - Crédito fiscal = IVA pagado en las compras
 *   - A pagar        = débito - crédito (si sale negativo, queda a favor)
 *
 * Sobre las ventas: los precios del menú ya llevan el IVA incluido (es como
 * se cobra al público en El Salvador), así que el IVA no se SUMA al total,
 * se DESGLOSA de él: base = total / 1.13, e IVA = total - base.
 */
purchaseInvoiceController.getTaxReport = async (req, res) => {
    try {
        const { period, start, end } = resolvePeriod(req.query.period);

        const [salesInvoices, purchases] = await Promise.all([
            Invoice.find({ issuedAt: { $gte: start, $lte: end } })
                .select("total issuedAt orderType")
                .sort({ issuedAt: -1 })
                .lean(),
            PurchaseInvoice.find({ issuedAt: { $gte: start, $lte: end } })
                .sort({ issuedAt: -1 })
                .lean(),
        ]);

        // --- Ventas (débito fiscal) ---
        const salesTotal = salesInvoices.reduce((acc, inv) => acc + (Number(inv.total) || 0), 0);
        const salesBase = salesTotal / (1 + IVA_RATE);
        const salesTax = salesTotal - salesBase;

        // --- Compras (crédito fiscal) ---
        const purchasesSubtotal = purchases.reduce((acc, p) => acc + (Number(p.subtotal) || 0), 0);
        const purchasesTax = purchases.reduce((acc, p) => acc + (Number(p.tax) || 0), 0);
        const purchasesTotal = purchases.reduce((acc, p) => acc + (Number(p.total) || 0), 0);

        // --- Resultado de la declaración ---
        const taxPayable = salesTax - purchasesTax;

        // Cuántas compras faltan por revisar: es lo primero que mira el
        // usuario antes de dar por cerrado un período.
        const pendingCount = purchases.filter((p) => !p.processedForTax).length;

        // Desglose de compras por categoría, para el reporte.
        const byCategory = purchases.reduce((acc, p) => {
            const key = p.category || "otros";
            if (!acc[key]) acc[key] = { category: key, count: 0, subtotal: 0, tax: 0, total: 0 };
            acc[key].count += 1;
            acc[key].subtotal = round2(acc[key].subtotal + (Number(p.subtotal) || 0));
            acc[key].tax = round2(acc[key].tax + (Number(p.tax) || 0));
            acc[key].total = round2(acc[key].total + (Number(p.total) || 0));
            return acc;
        }, {});

        return res.status(200).json({
            period,
            periodStart: start,
            periodEnd: end,
            sales: {
                count: salesInvoices.length,
                base: round2(salesBase),
                tax: round2(salesTax),
                total: round2(salesTotal),
            },
            purchases: {
                count: purchases.length,
                pendingCount,
                processedCount: purchases.length - pendingCount,
                subtotal: round2(purchasesSubtotal),
                tax: round2(purchasesTax),
                total: round2(purchasesTotal),
                byCategory: Object.values(byCategory),
            },
            // El número que se declara. Positivo: se le debe a Hacienda.
            // Negativo: queda crédito a favor para el siguiente período.
            result: {
                debitTax: round2(salesTax),
                creditTax: round2(purchasesTax),
                taxPayable: round2(taxPayable),
                inFavor: taxPayable < 0,
            },
            purchaseList: purchases,
        });
    } catch (error) {
        console.error("purchaseInvoiceController.getTaxReport:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo generar el reporte de IVA." });
    }
};

// --- Libro de Compras ---

/**
 * Montos del libro de una factura. Las facturas registradas antes de que
 * existiera el libro solo traen subtotal: ese monto se toma como compra
 * interna gravada, que es lo que eran.
 */
const bookAmounts = (inv) => {
    const amounts = Object.fromEntries(BOOK_AMOUNT_FIELDS.map((f) => [f, round2(Number(inv[f]) || 0)]));
    const base = BOOK_AMOUNT_FIELDS.reduce((acc, f) => acc + amounts[f], 0);
    if (base === 0 && Number(inv.subtotal) > 0) amounts.internalTaxed = round2(Number(inv.subtotal));
    return amounts;
};

/**
 * Qué le falta a una factura para quedar completa en el libro. El libro se
 * genera igual, pero la pantalla las marca para que se corrijan antes de
 * entregárselo al contador.
 */
const bookWarnings = (inv, amounts) => {
    const warnings = [];
    const taxedBase = amounts.internalTaxed + amounts.internationTaxed + amounts.importGoods + amounts.importServices;
    const isExcludedOnly = amounts.excludedSubject > 0 && taxedBase === 0;
    if (!inv.supplierNrc && !isExcludedOnly) warnings.push("Falta el NRC del proveedor");
    if (isExcludedOnly && !inv.supplierDui) warnings.push("Falta el DUI del sujeto excluido");
    if (taxedBase > 0 && !(Number(inv.tax) > 0)) warnings.push("Compra gravada sin crédito fiscal");
    return warnings;
};

/**
 * Libro de Compras del período (anexo 3 del F-07): una fila por documento,
 * en orden de fecha y con correlativo, con las mismas columnas del formato
 * que maneja el contador, más los totales de cada columna.
 */
purchaseInvoiceController.getPurchaseBook = async (req, res) => {
    try {
        const { period, start, end } = resolvePeriod(req.query.period);

        const purchases = await PurchaseInvoice.find({ issuedAt: { $gte: start, $lte: end } })
            .sort({ issuedAt: 1, createdAt: 1 })
            .lean();

        const rows = purchases.map((inv, index) => {
            const amounts = bookAmounts(inv);
            // Los documentos guardados antes de estos campos no los traen.
            const documentClass = inv.documentClass || "1";
            const documentType = inv.documentType || "03";
            const tax = round2(Number(inv.tax) || 0);
            const ivaWithheld = round2(Number(inv.ivaWithheld) || 0);
            const base = BOOK_AMOUNT_FIELDS.reduce((acc, f) => acc + amounts[f], 0);

            return {
                id: inv._id,
                correlative: index + 1,
                issuedAt: inv.issuedAt,
                documentClass,
                documentClassLabel: DOCUMENT_CLASSES[documentClass],
                documentType,
                documentTypeLabel: DOCUMENT_TYPES[documentType],
                invoiceNumber: inv.invoiceNumber,
                series: inv.series || "",
                supplierNrc: inv.supplierNrc || "",
                supplierTaxId: inv.supplierTaxId || "",
                supplierDui: inv.supplierDui || "",
                supplierName: inv.supplierName,
                ...amounts,
                tax,
                ivaWithheld,
                total: round2(base + tax + ivaWithheld),
                annexNumber: PURCHASE_ANNEX.number,
                annexDescription: PURCHASE_ANNEX.description,
                operationType: inv.operationType || "1",
                classification: inv.classification || "2",
                sector: inv.sector || "2",
                costType: inv.costType || "2",
                warnings: bookWarnings(inv, amounts),
            };
        });

        const totalKeys = [...BOOK_AMOUNT_FIELDS, "tax", "ivaWithheld", "total"];
        const totals = Object.fromEntries(totalKeys.map((k) => [
            k, round2(rows.reduce((acc, r) => acc + r[k], 0)),
        ]));

        return res.status(200).json({
            period,
            periodStart: start,
            periodEnd: end,
            count: rows.length,
            incompleteCount: rows.filter((r) => r.warnings.length > 0).length,
            rows,
            totals,
        });
    } catch (error) {
        console.error("purchaseInvoiceController.getPurchaseBook:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo generar el libro de compras." });
    }
};

export default purchaseInvoiceController;
