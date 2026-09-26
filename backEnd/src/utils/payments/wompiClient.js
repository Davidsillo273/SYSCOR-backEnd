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

// Errores con `code` para que el checkout le diga a la app qué pasó:
//   WOMPI_CONFIG       faltan las credenciales en el servidor
//   WOMPI_AUTH         Wompi rechazó las credenciales (no dio token)
//   WOMPI_UNREACHABLE  Wompi no respondió (caído, sin red o tardó demasiado)
export class WompiError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "WompiError";
        this.code = code;
    }
}

const wompiFetch = async (url, options, timeoutMs) => {
    try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        throw new WompiError(
            "WOMPI_UNREACHABLE",
            timedOut ? `Wompi tardó más de ${timeoutMs / 1000} s.` : `Sin conexión con Wompi (${error?.message}).`
        );
    }
};

const getAccessToken = async () => {
    if (cachedToken && Date.now() < cachedUntil) return cachedToken;
    if (!config.wompi.clientId || !config.wompi.clientSecret) {
        throw new WompiError("WOMPI_CONFIG", "Faltan CLIENT_ID / CLIENT_SECRET de Wompi en las variables de entorno.");
    }

    const response = await wompiFetch(ID_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: config.wompi.grantType || "client_credentials",
            audience: config.wompi.audience || "wompi_api",
            client_id: config.wompi.clientId,
            client_secret: config.wompi.clientSecret,
        }),
    }, 15000);

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new WompiError("WOMPI_AUTH", `Wompi no entregó token de acceso (${response.status}${data?.error ? `: ${data.error}` : ""}).`);
    }

    cachedToken = data.access_token;
    cachedUntil = Date.now() + (Number(data.expires_in || 3600) - 60) * 1000;
    return cachedToken;
};

const request = async (method, path, body) => {
    const token = await getAccessToken();
    const response = await wompiFetch(`${API_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    }, 20000);
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
