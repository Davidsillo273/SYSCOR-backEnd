// Chef Panchita en la app de clientes: seguimiento de pedidos, estimación de
// entrega, reclamos, mensajes al repartidor y "lo de siempre".
//
// Diferencias con el asistente del panel (assistantChatController):
//   - El historial vive en el servidor (PanchitaConversation), no lo manda el
//     teléfono: así nadie puede inyectar un resultado de herramienta falso.
//   - Cada herramienta usa el cliente de la sesión (req.user.id). El modelo
//     solo elige QUÉ pedido, y siempre dentro de los del cliente.
//   - Los reembolsos los decide claimPolicy con reglas fijas, no la IA.
import { generateWithTools } from "../../utils/chat/geminiUtils.js";
import PanchitaConversation from "../../models/chat/panchitaConversationModel.js";
import Order from "../../models/orders/orderModel.js";
import Claim from "../../models/orders/claimModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import { estimateOrder } from "../../utils/panchita/etaUtils.js";
import { fileClaim, toPublicClaim, CLAIM_TYPE_LABELS } from "../../utils/panchita/claimPolicy.js";
import {
    ACTIVE_ORDER_STATUSES,
    STATUS_LABELS,
    shortId,
    summarizeOrder,
    findCustomerOrder,
    usualOrder,
    suggestDriverMessages,
} from "../../utils/panchita/panchitaUtils.js";
import { emitToRoles, emitToTypes, SOCKET_EVENTS } from "../../config/socket.js";

const panchitaController = {};

const MAX_TOOL_ROUNDS = 4;
const MAX_STORED_CONTENTS = 40;
const MAX_STORED_MESSAGES = 60;
const FALLBACK_REPLY =
    "Uy, no pude pensar mi respuesta en este momento. Inténtalo de nuevo en un ratito o escríbele al equipo por WhatsApp desde \"Más → Ayuda y soporte\".";

const SYSTEM_PROMPT = `Eres Chef Panchita, la asistente de la app de clientes de Taquería El Corral
(El Salvador, Km 14½ Carretera Troncal del Norte, Apopa; abierto todos los
días de 10:00 a. m. a 9:00 p. m.). Hablas con un cliente que ya inició sesión.

Puedes ayudarle con:
- Saber cómo va su pedido y cuándo llega (usa estimar_entrega; explica los
  factores que devuelve: cocina, tráfico y clima).
- Resolver problemas de un pedido: faltantes, producto equivocado, calidad o
  retraso (usa reportar_problema).
- Mandarle un mensaje al repartidor (usa enviar_mensaje_repartidor).
- Repetir "lo de siempre" (usa lo_de_siempre).
- Consultar su saldo a favor y sus reclamos (usa consultar_saldo).

Reglas:
1. Nunca inventes estados, horas, montos ni productos: consúltalos con las
   herramientas. Si no hay pedidos, dilo con amabilidad.
2. TÚ NO decides reembolsos. Para cualquier problema con un pedido llama a
   reportar_problema y comunica EXACTAMENTE la decisión y el monto que
   devuelve (campo "reason"). No prometas nada antes de tener ese resultado.
3. Antes de reportar un problema necesitas: qué pasó (tipo), qué productos
   (salvo retraso) y si prefiere "saldo" a favor (inmediato) o "tarjeta"
   (lo procesa el equipo y tarda unos días). Si falta algo, pregúntalo en
   una sola frase.
4. Antes de enviar un mensaje al repartidor, asegúrate de que el texto sea
   claro; si el cliente ya lo dictó, envíalo sin preguntar de nuevo.
5. No pidas ni repitas datos de tarjeta, contraseñas ni códigos.
6. Si el tema no tiene que ver con sus pedidos o el restaurante, reconduce
   con amabilidad.
7. Responde SIEMPRE en español, cálida y breve (1 a 3 frases). Trata al
   cliente de "tú" (nunca de "vos"), igual que el resto de la app.
   Usa el número corto del pedido (#ABC123) cuando hables de uno.`;

// ── HERRAMIENTAS ─────────────────────────────────────────────────────────

const PEDIDO_PARAM = {
    type: "string",
    description: "Número corto del pedido (ej. A1B2C3). Omítelo para usar el pedido en curso o el más reciente.",
};

const TOOLS = {
    ver_mis_pedidos: {
        declaration: {
            name: "ver_mis_pedidos",
            description: "Lista los pedidos del cliente: los que están en curso y los últimos entregados.",
            parameters: { type: "object", properties: {} },
        },
        run: async (_args, ctx) => {
            const orders = await Order.find({ customer: ctx.customerId }).sort({ createdAt: -1 }).limit(8).lean();
            return {
                success: true,
                active: orders.filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status)).map(summarizeOrder),
                recent: orders.filter((o) => !ACTIVE_ORDER_STATUSES.includes(o.status)).slice(0, 5).map(summarizeOrder),
            };
        },
    },

    estimar_entrega: {
        declaration: {
            name: "estimar_entrega",
            description: "Estima cuándo llega (o está listo) un pedido en curso, considerando la carga de la cocina, el tráfico y el clima.",
            parameters: { type: "object", properties: { pedido: PEDIDO_PARAM } },
        },
        run: async (args, ctx) => {
            const order = await findCustomerOrder(ctx.customerId, args.pedido);
            if (!order) return { success: false, message: "El cliente no tiene pedidos." };
            if (!ACTIVE_ORDER_STATUSES.includes(order.status)) {
                return { success: false, message: `El pedido #${shortId(order._id)} ya está ${STATUS_LABELS[order.status]?.toLowerCase()}.` };
            }
            const eta = await estimateOrder(order);
            if (!eta) return { success: false, message: "Ese pedido no se puede rastrear (se hizo en el local)." };
            ctx.cards.push({ type: "eta", order: summarizeOrder(order), eta });
            return {
                success: true,
                pedido: shortId(order._id),
                minutos: eta.minutes,
                ventana: eta.window,
                horaAproximada: eta.arrivalAt,
                riesgoDeRetraso: eta.risk,
                minutosDeRetraso: eta.lateBy,
                factores: eta.factors.map((f) => f.label),
                tipo: eta.isDelivery ? "domicilio" : "recoger en el local",
            };
        },
    },

    reportar_problema: {
        declaration: {
            name: "reportar_problema",
            description: "Levanta un reclamo por un problema con un pedido. El sistema decide con reglas fijas si se aprueba al instante o pasa a revisión.",
            parameters: {
                type: "object",
                properties: {
                    pedido: PEDIDO_PARAM,
                    tipo: {
                        type: "string",
                        enum: ["missing_item", "wrong_item", "quality", "late", "other"],
                        description: "missing_item=faltó algo, wrong_item=llegó otra cosa, quality=mal estado/frío/etc., late=llegó tarde, other=otro",
                    },
                    productos: {
                        type: "array",
                        description: "Productos afectados, con el nombre como aparece en el pedido.",
                        items: {
                            type: "object",
                            properties: { nombre: { type: "string" }, cantidad: { type: "integer" } },
                        },
                    },
                    descripcion: { type: "string", description: "Qué pasó, en palabras del cliente." },
                    reembolso: {
                        type: "string",
                        enum: ["saldo", "tarjeta"],
                        description: "saldo = saldo a favor inmediato; tarjeta = devolución a la tarjeta (la procesa el equipo).",
                    },
                },
                required: ["tipo", "reembolso"],
            },
        },
        run: async (args, ctx) => {
            const order = await findCustomerOrder(ctx.customerId, args.pedido);
            if (!order) return { success: false, message: "No encontré pedidos en la cuenta del cliente." };
            const result = await fileClaim({
                req: ctx.req,
                customerId: ctx.customerId,
                orderId: order._id,
                type: args.tipo,
                items: (args.productos || []).map((p) => ({ name: p.nombre, quantity: p.cantidad })),
                description: args.descripcion,
                resolution: args.reembolso === "tarjeta" ? "card_refund" : "credit",
            });
            if (result.error) return { success: false, message: result.error };
            const claim = toPublicClaim(result.claim);
            ctx.cards.push({ type: "claim", claim, orderShortId: shortId(order._id) });
            return {
                success: true,
                yaExistia: !result.created,
                estado: claim.status,
                monto: claim.amount,
                reason: claim.reason,
            };
        },
    },

    enviar_mensaje_repartidor: {
        declaration: {
            name: "enviar_mensaje_repartidor",
            description: "Envía un mensaje corto al repartidor de un pedido a domicilio en curso.",
            parameters: {
                type: "object",
                properties: { pedido: PEDIDO_PARAM, mensaje: { type: "string", description: "Máximo 200 caracteres." } },
                required: ["mensaje"],
            },
        },
        run: async (args, ctx) => {
            const order = await findCustomerOrder(ctx.customerId, args.pedido);
            const result = await sendDriverMessage(order, args.mensaje, false);
            if (result.error) return { success: false, message: result.error };
            ctx.cards.push({ type: "driver_message", orderShortId: shortId(order._id), text: result.text });
            return { success: true, enviado: result.text, pedido: shortId(order._id) };
        },
    },

    lo_de_siempre: {
        declaration: {
            name: "lo_de_siempre",
            description: "Arma 'lo de siempre' del cliente (lo que más repite o su último pedido) para agregarlo al carrito.",
            parameters: { type: "object", properties: {} },
        },
        run: async (_args, ctx) => {
            const usual = await usualOrder(ctx.customerId);
            if (!usual || usual.items.length === 0) {
                return { success: false, message: usual ? "Ninguno de esos productos está disponible hoy." : "El cliente todavía no tiene pedidos." };
            }
            ctx.cards.push({ type: "usual", usual });
            return {
                success: true,
                etiqueta: usual.label,
                productos: usual.items.map((i) => `${i.quantity} × ${i.name}`),
                total: usual.total,
                noDisponibles: usual.unavailable,
                nota: "La app le muestra un botón para agregarlo al carrito; no se agrega solo.",
            };
        },
    },

    consultar_saldo: {
        declaration: {
            name: "consultar_saldo",
            description: "Saldo a favor del cliente y estado de sus reclamos recientes.",
            parameters: { type: "object", properties: {} },
        },
        run: async (_args, ctx) => {
            const [customer, claims] = await Promise.all([
                CustomerModel.findById(ctx.customerId).select("wallet").lean(),
                Claim.find({ customer: ctx.customerId }).sort({ createdAt: -1 }).limit(5),
            ]);
            return {
                success: true,
                saldo: customer?.wallet?.balance || 0,
                reclamos: claims.map((c) => ({
                    pedido: shortId(c.order),
                    tipo: CLAIM_TYPE_LABELS[c.type],
                    estado: c.status,
                    monto: c.amount,
                })),
            };
        },
    },
};

// Declaraciones que se le pasan a Gemini (también sirven para probarlas).
export const panchitaToolDeclarations = () => Object.values(TOOLS).map((t) => t.declaration);

// ── MENSAJES AL REPARTIDOR ───────────────────────────────────────────────

const MAX_DRIVER_MESSAGES = 10;

// Guarda el mensaje en el pedido y lo manda en tiempo real a los
// repartidores y al panel. Todavía no hay repartidor asignado por pedido, así
// que le llega a todos los empleados de tipo "delivery".
const sendDriverMessage = async (order, rawText, preset) => {
    if (!order) return { error: "No encontré un pedido en curso." };
    if (order.orderType !== "online" || !order.isDelivery) {
        return { error: "Ese pedido no es a domicilio, así que no lleva repartidor." };
    }
    if (!ACTIVE_ORDER_STATUSES.includes(order.status)) {
        return { error: `El pedido #${shortId(order._id)} ya no está en camino.` };
    }
    const text = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (text.length < 2) return { error: "El mensaje está vacío." };
    if ((order.driverMessages || []).length >= MAX_DRIVER_MESSAGES) {
        return { error: "Ya enviaste varios mensajes en este pedido. Si es urgente, llama al local." };
    }

    const message = { text, preset: !!preset, createdAt: new Date() };
    await Order.updateOne({ _id: order._id }, { $push: { driverMessages: message } });

    const payload = {
        orderId: order._id,
        shortId: shortId(order._id),
        deliveryAddress: order.deliveryAddress,
        message,
    };
    emitToTypes(["delivery"], SOCKET_EVENTS.ORDER_DRIVER_MESSAGE, payload);
    emitToRoles(["admin"], SOCKET_EVENTS.ORDER_DRIVER_MESSAGE, payload);

    return { text };
};

// ── CHAT ─────────────────────────────────────────────────────────────────

// Recorta el historial sin partir una llamada a herramienta de su respuesta:
// siempre empieza en un mensaje de texto del cliente.
const trimContents = (contents) => {
    if (contents.length <= MAX_STORED_CONTENTS) return contents;
    let start = contents.length - MAX_STORED_CONTENTS;
    while (start < contents.length) {
        const turn = contents[start];
        if (turn?.role === "user" && turn.parts?.some((p) => typeof p.text === "string")) break;
        start += 1;
    }
    return contents.slice(start);
};

const publicMessages = (conversation) =>
    (conversation?.messages || []).map((m) => ({
        role: m.role,
        text: m.text,
        cards: m.cards || [],
        createdAt: m.createdAt,
    }));

// GET /panchita/chat — retoma la conversación guardada.
panchitaController.getConversation = async (req, res) => {
    try {
        const conversation = await PanchitaConversation.findOne({ customer: req.user.id }).lean();
        return res.status(200).json({ messages: publicMessages(conversation) });
    } catch (error) {
        console.error("panchitaController.getConversation:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo cargar la conversación." });
    }
};

// DELETE /panchita/chat — empezar de cero.
panchitaController.resetConversation = async (req, res) => {
    try {
        await PanchitaConversation.deleteOne({ customer: req.user.id });
        return res.status(200).json({ messages: [] });
    } catch (error) {
        console.error("panchitaController.resetConversation:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo reiniciar la conversación." });
    }
};

// POST /panchita/chat — { message }. Responde { reply, cards }.
panchitaController.chat = async (req, res) => {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ title: "Mensaje vacío", message: "Escríbele algo a Panchita." });
    if (message.length > 600) {
        return res.status(400).json({ title: "Mensaje muy largo", message: "Cuéntaselo a Panchita en pocas líneas." });
    }

    try {
        const conversation =
            (await PanchitaConversation.findOne({ customer: req.user.id })) ||
            new PanchitaConversation({ customer: req.user.id });

        const customer = await CustomerModel.findById(req.user.id).select("personalInfo.name").lean();
        const systemPrompt = `${SYSTEM_PROMPT}\n\nEl cliente se llama ${customer?.personalInfo?.name || "cliente"}. Fecha y hora actual: ${new Date().toISOString()} (El Salvador es UTC-6).`;

        const contents = [...(conversation.contents || []), { role: "user", parts: [{ text: message }] }];
        const ctx = { req, customerId: req.user.id, cards: [] };
        const declarations = panchitaToolDeclarations();

        let reply = null;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
            // Gemini a veces no responde a tiempo: se reintenta una vez.
            const content =
                (await generateWithTools({ contents, tools: declarations, systemPrompt })) ||
                (await generateWithTools({ contents, tools: declarations, systemPrompt }));
            if (!content?.parts?.length) break;
            contents.push(content);

            const calls = content.parts.filter((p) => p.functionCall);
            if (calls.length === 0) {
                reply = content.parts.map((p) => p.text || "").join("").trim() || null;
                break;
            }

            const responses = [];
            for (const part of calls) {
                const { name, args } = part.functionCall;
                const tool = TOOLS[name];
                let result;
                try {
                    result = tool ? await tool.run(args || {}, ctx) : { success: false, message: "Herramienta desconocida." };
                } catch (error) {
                    console.error(`panchitaController.tool(${name}):`, error);
                    result = { success: false, message: "Ocurrió un error al consultar eso." };
                }
                responses.push({ functionResponse: { name, response: result } });
            }
            contents.push({ role: "user", parts: responses });
        }

        const finalReply = reply || FALLBACK_REPLY;
        // Solo se guarda el hilo si Gemini respondió: un fallo no ensucia el historial.
        if (reply) conversation.contents = trimContents(contents);
        conversation.messages.push({ role: "user", text: message });
        conversation.messages.push({ role: "model", text: finalReply, cards: ctx.cards });
        if (conversation.messages.length > MAX_STORED_MESSAGES) {
            conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
        }
        conversation.markModified("contents");
        await conversation.save();

        return res.status(200).json({ reply: finalReply, cards: ctx.cards });
    } catch (error) {
        console.error("panchitaController.chat:", error);
        return res.status(200).json({ reply: FALLBACK_REPLY, cards: [] });
    }
};

// ── RESUMEN PARA LA APP ──────────────────────────────────────────────────

// Avisos que Panchita da por su cuenta. Cada uno lleva una `key` estable para
// que la app no repita el mismo aviso en cada consulta.
const buildAlerts = (order, eta) => {
    const ref = `#${shortId(order._id)}`;
    const alerts = [];
    const statusText = {
        preparing: `¡Ya están preparando tu pedido ${ref}! 🌮`,
        ready: order.isDelivery
            ? `Tu pedido ${ref} está listo y sale para tu casa.`
            : `Tu pedido ${ref} está listo: ya puedes pasar por él.`,
        atrasado: `Tu pedido ${ref} va más lento de lo normal en cocina. Ya estoy pendiente.`,
    }[order.status];
    if (statusText) alerts.push({ key: `${order._id}:status:${order.status}`, level: order.status === "atrasado" ? "warning" : "info", text: statusText });

    if (eta?.risk === "high") {
        const reason = eta.factors.find((f) => f.type === "weather")
            ? "por la lluvia"
            : eta.factors.find((f) => f.type === "traffic" && /tráfico|pico/.test(f.label))
                ? "por el tráfico"
                : "porque la cocina está llena";
        alerts.push({
            key: `${order._id}:late:${Math.floor(eta.lateBy / 10)}`,
            level: "warning",
            text: `Tu pedido ${ref} podría llegar unos ${eta.lateBy} min tarde ${reason}. Si llega fuera de tiempo, puedo compensarte.`,
        });
    }
    return alerts;
};

// GET /panchita/overview — pedidos en curso con su estimación, avisos,
// saldo, reclamos recientes y mensajes sugeridos para el repartidor.
panchitaController.getOverview = async (req, res) => {
    try {
        const [orders, customer, claims] = await Promise.all([
            Order.find({ customer: req.user.id, status: { $in: ACTIVE_ORDER_STATUSES } }).sort({ createdAt: -1 }).limit(5),
            CustomerModel.findById(req.user.id).select("wallet").lean(),
            Claim.find({ customer: req.user.id }).sort({ createdAt: -1 }).limit(5),
        ]);

        const activeOrders = [];
        const alerts = [];
        for (const order of orders) {
            const eta = await estimateOrder(order);
            activeOrders.push({
                ...summarizeOrder(order),
                eta,
                quickMessages: order.isDelivery ? suggestDriverMessages(order, eta) : [],
            });
            alerts.push(...buildAlerts(order, eta));
        }

        // Novedades de reclamos que resolvió una persona.
        for (const claim of claims) {
            if (claim.decidedBy === "admin" || claim.status === "refunded") {
                alerts.push({
                    key: `claim:${claim._id}:${claim.status}`,
                    level: claim.status === "rejected" ? "warning" : "info",
                    text: `Tu reclamo del pedido #${shortId(claim.order)}: ${claim.reason || claim.status}`,
                });
            }
        }

        return res.status(200).json({
            activeOrders,
            alerts,
            wallet: { balance: customer?.wallet?.balance || 0 },
            claims: claims.map(toPublicClaim),
        });
    } catch (error) {
        console.error("panchitaController.getOverview:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo cargar tu seguimiento." });
    }
};

// GET /panchita/usual — "lo de siempre", listo para el carrito.
panchitaController.getUsual = async (req, res) => {
    try {
        const usual = await usualOrder(req.user.id);
        return res.status(200).json({ usual });
    } catch (error) {
        console.error("panchitaController.getUsual:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo armar tu pedido de siempre." });
    }
};

// POST /panchita/orders/:id/driver-messages — { text, preset }
panchitaController.postDriverMessage = async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, customer: req.user.id });
        const result = await sendDriverMessage(order, req.body?.text, req.body?.preset);
        if (result.error) return res.status(400).json({ title: "No se envió", message: result.error });
        return res.status(201).json({ text: result.text });
    } catch (error) {
        console.error("panchitaController.postDriverMessage:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo enviar el mensaje." });
    }
};

// POST /panchita/claims — reclamo desde un formulario (sin pasar por el chat).
panchitaController.postClaim = async (req, res) => {
    try {
        const { orderId, type, items, description, resolution } = req.body || {};
        const result = await fileClaim({
            req,
            customerId: req.user.id,
            orderId,
            type,
            items,
            description,
            resolution,
        });
        if (result.error) return res.status(400).json({ title: "No se pudo reportar", message: result.error });
        return res.status(result.created ? 201 : 200).json({ claim: toPublicClaim(result.claim), created: result.created });
    } catch (error) {
        console.error("panchitaController.postClaim:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo reportar el problema." });
    }
};

// ── ADMIN: COLA DE RECLAMOS ──────────────────────────────────────────────

// GET /panchita/claims?status=in_review — para el panel.
panchitaController.listClaims = async (req, res) => {
    try {
        const filter = req.query.status ? { status: req.query.status } : {};
        const claims = await Claim.find(filter)
            .sort({ createdAt: -1 })
            .limit(100)
            .populate("customer", "personalInfo.name personalInfo.lastname loginInfo.email")
            .populate("order", "total items createdAt status payment.transactionId");
        return res.status(200).json(claims);
    } catch (error) {
        console.error("panchitaController.listClaims:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudieron obtener los reclamos." });
    }
};

// PATCH /panchita/claims/:id — { action, amount?, note? }
//   approve_credit → aprueba (con el monto indicado) y lo abona como saldo
//   approve_card   → aprueba para reembolsar a la tarjeta (queda pending_refund)
//   mark_refunded  → ya se reembolsó desde el panel de Wompi
//   reject         → se rechaza (la nota se le muestra al cliente)
panchitaController.resolveClaim = async (req, res) => {
    try {
        const { action, amount, note } = req.body || {};
        const claim = await Claim.findById(req.params.id);
        if (!claim) return res.status(404).json({ title: "Reclamo no encontrado", message: "Ese reclamo ya no existe." });

        const finalAmount = amount !== undefined ? Math.max(Number(amount) || 0, 0) : claim.amount;
        const allowed = {
            approve_credit: ["in_review"],
            approve_card: ["in_review"],
            mark_refunded: ["pending_refund"],
            reject: ["in_review", "pending_refund"],
        };
        if (!allowed[action]?.includes(claim.status)) {
            return res.status(400).json({ title: "Acción no válida", message: `No se puede "${action}" un reclamo en estado ${claim.status}.` });
        }

        claim.decidedBy = "admin";
        claim.adminNote = note ? String(note).slice(0, 300) : claim.adminNote;

        if (action === "approve_credit") {
            claim.amount = finalAmount;
            claim.resolution = "credit";
            claim.status = "approved";
            claim.reason = `Aprobado por el equipo: te abonamos $${finalAmount.toFixed(2)} de saldo a favor.`;
            claim.resolvedAt = new Date();
            await CustomerModel.updateOne({ _id: claim.customer }, { $inc: { "wallet.balance": finalAmount } });
        } else if (action === "approve_card") {
            claim.amount = finalAmount;
            claim.resolution = "card_refund";
            claim.status = "pending_refund";
            claim.reason = `Aprobado por el equipo: te reembolsaremos $${finalAmount.toFixed(2)} a tu tarjeta.`;
        } else if (action === "mark_refunded") {
            claim.status = "refunded";
            claim.reason = `Listo: reembolsamos $${claim.amount.toFixed(2)} a tu tarjeta. Según tu banco, puede tardar unos días en verse.`;
            claim.resolvedAt = new Date();
        } else {
            claim.status = "rejected";
            claim.reason = note ? `No pudimos aprobarlo: ${String(note).slice(0, 200)}` : "No pudimos aprobar este reclamo. Escríbenos si quieres más detalles.";
            claim.resolvedAt = new Date();
        }

        await claim.save();
        return res.status(200).json(claim);
    } catch (error) {
        console.error("panchitaController.resolveClaim:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo actualizar el reclamo." });
    }
};

export default panchitaController;
