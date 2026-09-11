import express from "express";
import purchaseInvoiceController from "../../controllers/orders/purchaseInvoiceController.js";
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js";
import { requirePermission } from "../../middlewares/auth/permissionMiddleware.js";
import upload from "../../utils/cloudinaryConfig.js";

const router = express.Router();

// Toda la contabilidad va detrás del permiso "reports": son datos fiscales
// del negocio, no información operativa.
const guard = [validateAuthCookie(["admin", "employee"]), requirePermission("reports")];

/**
 * @swagger
 * /purchase-invoices/tax-report:
 *   get:
 *     summary: Reporte de IVA de un período
 *     description: >
 *       Cruza el IVA cobrado en las ventas (débito fiscal) contra el pagado en
 *       las compras (crédito fiscal) y devuelve el resultado a declarar.
 *     tags: [Contabilidad]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, example: "2026-09" }
 *         description: Período AAAA-MM. Por defecto, el mes en curso.
 *     responses:
 *       200: { description: Reporte calculado. }
 *       403: { description: Sin el permiso "reports". }
 */
// Va ANTES de "/:id" para que Express no interprete "tax-report" como un id.
router.route("/tax-report").get(...guard, purchaseInvoiceController.getTaxReport);

/**
 * @swagger
 * /purchase-invoices:
 *   get:
 *     summary: Lista las facturas de compra
 *     tags: [Contabilidad]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, example: "2026-09" }
 *       - in: query
 *         name: processed
 *         schema: { type: string, example: "false" }
 *         description: Filtra por estado de procesado ("true" o "false").
 *     responses:
 *       200: { description: Arreglo de facturas de compra. }
 *   post:
 *     summary: Registra una factura de compra
 *     description: >
 *       Acepta multipart/form-data con un archivo opcional ("file": PDF o
 *       imagen del comprobante), que se guarda en Cloudinary.
 *     tags: [Contabilidad]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [supplierName, invoiceNumber, issuedAt, subtotal]
 *             properties:
 *               supplierName: { type: string, example: "Distribuidora La Ceiba" }
 *               supplierTaxId: { type: string, example: "0614-010203-101-2" }
 *               invoiceNumber: { type: string, example: "F-00123" }
 *               issuedAt: { type: string, example: "2026-09-05" }
 *               subtotal: { type: number, example: 150.00 }
 *               tax: { type: number, example: 19.50 }
 *               total: { type: number, example: 169.50 }
 *               category: { type: string, example: "insumos" }
 *               notes: { type: string }
 *               file: { type: string, format: binary }
 *     responses:
 *       201: { description: Factura registrada. }
 *       409: { description: Ya existe esa factura para ese proveedor. }
 */
router.route("/")
    .get(...guard, purchaseInvoiceController.getPurchaseInvoices)
    .post(...guard, upload.single("file"), purchaseInvoiceController.createPurchaseInvoice);

/**
 * @swagger
 * /purchase-invoices/{id}/processed:
 *   patch:
 *     summary: Marca o desmarca una factura como procesada para IVA
 *     tags: [Contabilidad]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Estado actualizado. }
 *       404: { description: Factura no encontrada. }
 */
router.route("/:id/processed").patch(...guard, purchaseInvoiceController.toggleProcessed);

/**
 * @swagger
 * /purchase-invoices/{id}:
 *   delete:
 *     summary: Elimina una factura de compra
 *     tags: [Contabilidad]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Factura eliminada. }
 *       404: { description: Factura no encontrada. }
 */
router.route("/:id").delete(...guard, purchaseInvoiceController.deletePurchaseInvoice);

export default router;
