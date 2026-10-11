// Catálogos del Libro de Compras (Anexo de Compras del F-07 de Hacienda).
//
// Son los códigos que pide el formato del libro en cada columna de
// clasificación. Se guardan como código (string) en la factura de compra y se
// exportan como "código + descripción", igual que los saca el sistema
// contable del negocio (ej. "03 COMPROBANTE DE CRÉDITO FISCAL").
//
// El frontend tiene un espejo en src/constants/purchaseBook.js.

// CLASEDOC: cómo se emitió el documento
export const DOCUMENT_CLASSES = {
    "1": "IMPRESO POR IMPRENTA O TIQUETES",
    "2": "FORMULARIO UNICO",
    "3": "OTROS",
    "4": "DOCUMENTO TRIBUTARIO ELECTRONICO (DTE)",
};

// TIPODOCUM: qué documento es. Solo el CCF y sus notas dan crédito fiscal.
export const DOCUMENT_TYPES = {
    "03": "COMPROBANTE DE CRÉDITO FISCAL",
    "05": "NOTA DE CRÉDITO",
    "06": "NOTA DE DÉBITO",
    "12": "DECLARACIÓN DE MERCANCÍAS",
    "13": "MANDAMIENTO DE INGRESO",
};

// TPOPERAC: tipo de operación para renta
export const OPERATION_TYPES = {
    "1": "Gravada",
    "2": "No gravada o exenta",
    "3": "Excluido o no constituye renta",
    "4": "Mixta",
};

// CLASF: si la compra es costo o gasto
export const CLASSIFICATIONS = {
    "1": "Costo",
    "2": "Gasto",
};

// SECTOR: sector económico al que se imputa la compra
export const SECTORS = {
    "1": "Industria",
    "2": "Comercio",
    "3": "Agropecuaria",
    "4": "Servicios, profesiones, artes y oficios",
};

// TPCOSTO: tipo de costo o gasto
export const COST_TYPES = {
    "1": "Gastos de venta sin donación",
    "2": "Gastos de administración sin donación",
    "3": "Gastos financieros sin donación",
    "4": "Costo artículos producidos/comprados importaciones/internaciones",
    "5": "Costo artículos producidos/comprados interno",
    "6": "Costos indirectos de fabricación",
    "7": "Mano de obra",
};

// NUMANEXO / DSCANEXO: el Libro de Compras es siempre el anexo 3.
export const PURCHASE_ANNEX = { number: 3, description: "Compras" };

// Los montos del libro, en el orden de sus columnas. La base de la compra es
// la suma de todos ellos (el IVA y la retención van aparte).
export const BOOK_AMOUNT_FIELDS = [
    "internalTaxed",       // COMPRASGR: compras internas gravadas
    "internalExempt",      // COMPRASEX: compras internas exentas
    "internationTaxed",    // INTERGRAV: internaciones gravadas
    "internationExempt",   // INTEREXEN: internaciones exentas
    "importGoods",         // IMPORBIEN: importaciones gravadas de bienes
    "importServices",      // IMPORSERV: importaciones gravadas de servicios
    "importExempt",        // IMPOREXEN: importaciones exentas
    "excludedSubject",     // SUJEX: compras a sujetos excluidos
];

export default {
    DOCUMENT_CLASSES,
    DOCUMENT_TYPES,
    OPERATION_TYPES,
    CLASSIFICATIONS,
    SECTORS,
    COST_TYPES,
    PURCHASE_ANNEX,
    BOOK_AMOUNT_FIELDS,
};
