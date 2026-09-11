// Facturas de COMPRA (las que el negocio recibe de sus proveedores) y el
// reporte de IVA que cruza compras contra ventas.
//
// Las de VENTA las genera el sistema solo (invoiceController); estas las sube
// el usuario, porque llegan en papel/PDF desde el proveedor.
import PurchaseInvoice from "../../models/orders/purchaseInvoiceModel.js";
import Invoice from "../../models/orders/invoiceModel.js";
import { cloudinary } from "../../utils/cloudinaryConfig.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";

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

// Registra una factura de compra. El archivo (PDF o imagen) es opcional: a
// veces se registra el monto primero y el comprobante se adjunta después.
purchaseInvoiceController.createPurchaseInvoice = async (req, res) => {
    try {
        const {
            supplierName, supplierTaxId, invoiceNumber, issuedAt,
            subtotal, tax, total, category, notes,
        } = req.body;

        if (!supplierName || !invoiceNumber || !issuedAt) {
            return res.status(400).json({
                title: "Datos incompletos",
                message: "El proveedor, el número de factura y la fecha son obligatorios.",
            });
        }

        const parsedSubtotal = Number(subtotal);
        const parsedTax = Number(tax) || 0;
        // Si no mandan el total, se arma con subtotal + IVA. Así el formulario
        // puede pedir solo dos de los tres montos.
        const parsedTotal = total !== undefined && total !== null && total !== ""
            ? Number(total)
            : parsedSubtotal + parsedTax;

        if (Number.isNaN(parsedSubtotal) || parsedSubtotal < 0) {
            return res.status(400).json({ title: "Monto inválido", message: "El subtotal debe ser un número válido." });
        }
        if (Number.isNaN(parsedTotal) || parsedTotal < 0) {
            return res.status(400).json({ title: "Monto inválido", message: "El total debe ser un número válido." });
        }

        // Una misma factura del mismo proveedor no debería registrarse dos
        // veces: duplicarla inflaría el crédito fiscal declarado.
        const duplicate = await PurchaseInvoice.findOne({
            supplierName: supplierName.trim(),
            invoiceNumber: invoiceNumber.trim(),
        });

        if (duplicate) {
            return res.status(409).json({
                title: "Factura duplicada",
                message: `Ya existe una factura ${invoiceNumber} de ${supplierName}.`,
            });
        }

        const newInvoice = new PurchaseInvoice({
            supplierName: supplierName.trim(),
            supplierTaxId: supplierTaxId?.trim() || null,
            invoiceNumber: invoiceNumber.trim(),
            issuedAt: new Date(issuedAt),
            subtotal: round2(parsedSubtotal),
            tax: round2(parsedTax),
            total: round2(parsedTotal),
            category: category || "insumos",
            notes: notes?.trim() || null,
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

export default purchaseInvoiceController;
