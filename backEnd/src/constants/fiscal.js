// Datos fiscales del emisor para los comprobantes que imprime la caja.
//
// IMPORTANTE: la caja todavía SIMULA la facturación electrónica (DTE) del
// Ministerio de Hacienda: arma el documento con el mismo formato (número de
// control, código de generación, sello, QR de consulta en ambiente de
// pruebas), pero no lo transmite. Por eso todo comprobante sale marcado como
// "documento de prueba". Reemplaza NIT y NRC por los reales del negocio
// cuando se conecte con Hacienda.
export const ISSUER = {
    name: "Taquería El Corral",
    legalName: "Taquería El Corral",
    nit: "0614-000000-000-0",
    nrc: "000000-0",
    activity: "Restaurantes",
    address: "Km 14½, Carretera Troncal del Norte, Apopa, San Salvador",
    phone: "2200-0000",
    // Código de establecimiento y punto de venta que va en el número de control
    establishmentCode: "M001",
    pointOfSaleCode: "P001",
};

// Tasa de IVA. Los precios del menú ya la llevan incluida.
export const IVA_RATE = 0.13;

// Tipos de documento que emite la caja
export const DOCUMENT_TYPES = {
    fcf: { code: "01", label: "Factura de Consumidor Final", short: "Factura" },
    ccf: { code: "03", label: "Comprobante de Crédito Fiscal", short: "Crédito Fiscal" },
};

// Ambiente de Hacienda: "00" es pruebas. La consulta pública del QR apunta
// a ese ambiente porque el documento es simulado.
export const DTE_ENVIRONMENT = "00";
export const DTE_QUERY_URL = "https://admin.factura.gob.sv/consultaPublica";

export default { ISSUER, IVA_RATE, DOCUMENT_TYPES, DTE_ENVIRONMENT, DTE_QUERY_URL };
