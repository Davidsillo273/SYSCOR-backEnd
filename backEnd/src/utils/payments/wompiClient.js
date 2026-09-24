import { config } from "../../../config.js";

// Cliente de la API de Wompi El Salvador (https://docs.wompi.sv).
//
// - El token de acceso (OAuth client credentials) dura 1 hora: se guarda en
//   memoria y se renueva un minuto antes de vencer. NUNCA sale del servidor:
//   con ese token se puede leer la configuración del comercio, incluido su
//   client secret.
// - Wompi no tiene endpoint para reembolsar ni anular: eso se hace desde su
//   panel. Aquí solo se cobra (3DS) y se consulta el resultado.
const ID_URL = "https://id.wompi.sv/connect/token";
const API_URL = "https://api.wompi.sv";

let cachedToken = null;
let cachedUntil = 0;

const getAccessToken = async () => {
    if (cachedToken && Date.now() < cachedUntil) return cachedToken;

    const response = await fetch(ID_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: config.wompi.grantType || "client_credentials",
            audience: config.wompi.audience || "wompi_api",
            client_id: config.wompi.clientId,
            client_secret: config.wompi.clientSecret,
        }),
        signal: AbortSignal.timeout(15000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(`Wompi no entregó token de acceso (${response.status}).`);
    }

    cachedToken = data.access_token;
    cachedUntil = Date.now() + (Number(data.expires_in || 3600) - 60) * 1000;
    return cachedToken;
};

const request = async (method, path, body) => {
    const token = await getAccessToken();
    const response = await fetch(`${API_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
};

// Crea un cobro con 3D Secure. Devuelve { idTransaccion, urlCompletarPago3Ds, esReal, monto }:
// el cliente termina el pago abriendo urlCompletarPago3Ds.
const createTransaction3DS = (body) => request("POST", "/TransaccionCompra/3DS", body);

// Resultado real de una transacción: { esAprobada, monto, codigoAutorizacion, mensaje, ... }.
// Es la fuente de verdad: la redirección y el webhook solo avisan que hay que consultarla.
const getTransaction = (idTransaccion) =>
    request("GET", `/TransaccionCompra/${encodeURIComponent(idTransaccion)}`);

export default { getAccessToken, createTransaction3DS, getTransaction };
