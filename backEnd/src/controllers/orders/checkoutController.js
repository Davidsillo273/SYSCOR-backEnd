// Pago en línea de la app de clientes con Wompi 3D Secure.
//
// Flujo:
//   1. POST /payments/checkout: se recalculan los precios con la base de datos,
//      se guarda un Checkout y se crea el cobro 3DS en Wompi. La app recibe
//      `paymentUrl` y lo abre para que el cliente complete la verificación.
//   2. Wompi redirige a /payments/wompi/return y/o llama al webhook. Ninguno
//      de los dos se cree tal cual: solo disparan una consulta a Wompi
//      (GET /TransaccionCompra/{id}), que es la fuente de verdad.
//   3. Si Wompi dice que está aprobada y el monto coincide, se crea el pedido
//      (ya pagado) y cocina lo recibe en tiempo real.
//   4. La app consulta GET /payments/checkout/:id para saber cómo terminó.
import Checkout from "../../models/orders/checkoutModel.js";
import Order from "../../models/orders/orderModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import Combos from "../../models/menu/combosModel.js";
import Drinks from "../../models/menu/drinksModel.js";
import Extras from "../../models/menu/extrasModel.js";
import Saucers from "../../models/menu/saucersModel.js";
import { config } from "../../../config.js";
import wompiClient, { WompiError } from "../../utils/payments/wompiClient.js";
import cardCryptoUtils from "../../utils/users/cardCryptoUtils.js";
import contactUtils, { normalizePhones } from "../../utils/users/customerContactUtils.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { targetsForProduct, extraFitsProduct } from "../../utils/extras/extraTargetsUtils.js";
import { includedDrinksOf, drinkSurchargeFor, HOUSE_DRINK_CATEGORY } from "../../utils/drinks/drinkUpgradeUtils.js";

const checkoutController = {};

const MAX_LINES = 50;
const MAX_QUANTITY = 50;
// Un cobro 3DS que nadie terminó en este tiempo se da por abandonado.
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

const MODELS = { combo: Combos, drink: Drinks, saucer: Saucers };
const ACTIVE_STATUS_WORDS = ["disponible", "activo", "active"];
const isActive = (doc) => ACTIVE_STATUS_WORDS.includes(String(doc?.status || "").toLowerCase());
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// URL pública de este backend, a donde Wompi redirige y manda el webhook.
// En producción debe venir de APP_URL (ej. https://syscor-mll9.onrender.com);
// en desarrollo se deduce de la petición.
const publicBaseUrl = (req) => (config.appUrl || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
const apiPrefix = () => (process.env.API_URL || "/api").replace(/\/+$/, "");

// Convierte el carrito de la app en líneas de pedido con precios del servidor.
// Los extras van como líneas propias (así cocina los ve y el total cuadra);
// salsas, bebida del combo, opciones elegidas e ingredientes quitados van en
// las notas. Si el cliente cambió la bebida del combo por una de la casa que
// no viene incluida, la diferencia se suma al precio de la línea del combo.
const buildItems = async (cartItems) => {
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
        return { error: "Tu carrito está vacío." };
    }
    if (cartItems.length > MAX_LINES) return { error: "Tu pedido tiene demasiados productos." };

    const items = [];
    for (const cartItem of cartItems) {
        const model = MODELS[cartItem?.productType];
        if (!model) return { error: "Hay un producto que no se puede pedir en línea." };

        const quantity = Number(cartItem.quantity) || 1;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
            return { error: "Revisa las cantidades de tu pedido." };
        }

        // La categoría (o las de los platillos del combo) decide qué extras le tocan.
        let query = model.findById(cartItem.productId).select("name price status category saucers selectiveOptions drinkPolicy");
        if (cartItem.productType === "combo") {
            query = query
                .populate("saucers.saucerId", "category")
                .populate("selectiveOptions.saucerId", "category")
                .populate({ path: "drinkPolicy.drinkSetIds", select: "drinkIds", populate: { path: "drinkIds", select: "price" } })
                .populate("drinkPolicy.thirdPartyDrinkIds", "price");
        }
        const product = await query;
        if (!product || !isActive(product)) {
            return { error: `${cartItem.name || "Un producto"} ya no está disponible. Quítalo del carrito.` };
        }

        const notes = [];
        if (Array.isArray(cartItem.selectedSauces) && cartItem.selectedSauces.length > 0) {
            notes.push(`Salsas: ${cartItem.selectedSauces.slice(0, 10).join(", ")}`);
        }
        let drinkSurcharge = 0;
        if (cartItem.selectedDrinkId) {
            const drink = await Drinks.findById(cartItem.selectedDrinkId).select("name price category status");
            if (drink && cartItem.productType === "combo") {
                const included = includedDrinksOf(product);
                const isIncluded = included.some((d) => String(d._id) === String(drink._id));
                if (!isIncluded) {
                    // Fuera de las incluidas solo se aceptan las de la casa, con recargo.
                    if (drink.category !== HOUSE_DRINK_CATEGORY || !isActive(drink) || included.length === 0) {
                        return { error: `${drink.name} no se puede elegir en ${product.name}. Cambia la bebida.` };
                    }
                    drinkSurcharge = drinkSurchargeFor(included, drink);
                }
            }
            if (drink) {
                notes.push(drinkSurcharge > 0 ? `Bebida: ${drink.name} (+$${drinkSurcharge.toFixed(2)})` : `Bebida: ${drink.name}`);
            }
        }
        if (Array.isArray(cartItem.selectedSelectiveItems) && cartItem.selectedSelectiveItems.length > 0) {
            const picks = cartItem.selectedSelectiveItems
                .map((pick) => (typeof pick === "string" ? pick : pick?.name))
                .filter(Boolean)
                .slice(0, 10);
            if (picks.length > 0) notes.push(`Elegido: ${picks.join(", ")}`);
        }
        // [{ saucer, ingredients }]: "Taco al pastor: sin cebolla, cilantro".
        const removals = (Array.isArray(cartItem.removedIngredients) ? cartItem.removedIngredients : [])
            .slice(0, 10)
            .map((group) => {
                const list = (Array.isArray(group?.ingredients) ? group.ingredients : [])
                    .filter((name) => typeof name === "string" && name.trim())
                    .slice(0, 15)
                    .map((name) => name.trim().toLowerCase())
                    .join(", ");
                if (!list) return null;
                return typeof group.saucer === "string" && group.saucer ? `${group.saucer}: sin ${list}` : `Sin ${list}`;
            })
            .filter(Boolean);
        if (removals.length > 0) notes.push(removals.join("; "));

        items.push({
            itemType: cartItem.productType,
            itemId: product._id,
            name: product.name,
            price: round2((Number(product.price) || 0) + drinkSurcharge),
            quantity,
            notes: notes.join(" · ").slice(0, 300),
        });

        for (const selected of Array.isArray(cartItem.selectedExtras) ? cartItem.selectedExtras.slice(0, 20) : []) {
            const extra = await Extras.findById(selected?.extraId).select("name price status appliesTo");
            if (!extra || !isActive(extra)) {
                return { error: `El extra ${selected?.name || ""} ya no está disponible.`.replace("  ", " ") };
            }
            if (!extraFitsProduct(extra, targetsForProduct(cartItem.productType, product))) {
                return { error: `${extra.name} no se puede agregar a ${product.name}. Quítalo del carrito.` };
            }
            items.push({
                itemType: "extra",
                itemId: extra._id,
                name: extra.name,
                price: Number(extra.price) || 0,
                quantity,
                // En un combo, el platillo al que va: "Para: Combo Taquero · Taco al pastor".
                notes: `Para: ${product.name}${typeof selected?.forSaucer === "string" && selected.forSaucer ? ` · ${selected.forSaucer.slice(0, 80)}` : ""}`,
            });
        }
    }

    const subtotal = round2(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
    if (subtotal <= 0) return { error: "El total del pedido no es válido." };
    return { items, subtotal };
};

// Datos de la tarjeta con la que se cobra: una guardada (se descifra aquí) o
// una nueva. El CVV llega en cada compra y no se guarda en ningún lado.
const resolveCard = (customer, card) => {
    const cvv = String(card?.cvv || "");
    if (!/^\d{3,4}$/.test(cvv)) return { error: "Escribe el CVV de tu tarjeta." };

    if (card.savedCardIndex !== undefined && card.savedCardIndex !== null) {
        const saved = customer.personalInfo?.cards?.[Number(card.savedCardIndex)];
        if (!saved) return { error: "Esa tarjeta ya no está guardada. Elige otra." };
        let number;
        try {
            number = cardCryptoUtils.decrypt(saved.token);
        } catch {
            return { error: "No pudimos usar esa tarjeta. Elimínala y vuelve a agregarla." };
        }
        return {
            wompiCard: {
                numeroTarjeta: number,
                cvv,
                mesVencimiento: saved.expiryMonth,
                anioVencimiento: 2000 + Number(saved.expiryYear),
            },
        };
    }

    const validation = contactUtils.validateCardInput(card);
    if (!validation.valid) return { error: validation.message };
    return {
        wompiCard: {
            numeroTarjeta: validation.digits,
            cvv,
            mesVencimiento: validation.month,
            anioVencimiento: 2000 + validation.year,
        },
        newCard: {
            token: cardCryptoUtils.encrypt(validation.digits),
            lastFour: validation.digits.slice(-4),
            brand: contactUtils.detectCardBrand(validation.digits),
            cardHolder: String(card.cardHolder).trim(),
            expiryMonth: validation.month,
            expiryYear: validation.year,
        },
    };
};

const publicCheckout = (checkout) => ({
    id: checkout._id,
    status: checkout.status,
    amount: checkout.amount,
    creditApplied: checkout.creditApplied || 0,
    chargeAmount: checkout.chargeAmount,
    orderId: checkout.order || null,
    message: checkout.wompi?.message || null,
});

// Pasa la tarjeta nueva a la cuenta del cliente (si pidió guardarla), sin
// repetirla si ya la tenía.
const savePendingCard = async (checkout) => {
    const card = checkout.pendingCard;
    if (!card?.token) return;
    const customer = await CustomerModel.findById(checkout.customer).select("personalInfo.cards");
    if (!customer) return;
    const cards = customer.personalInfo.cards || [];
    const number = cardCryptoUtils.decrypt(card.token);
    const exists = cards.some((c) => {
        try {
            return c.lastFour === card.lastFour && cardCryptoUtils.decrypt(c.token) === number;
        } catch {
            return false;
        }
    });
    if (!exists && cards.length < contactUtils.MAX_CARDS) {
        cards.push({ ...card, isDefault: false });
        contactUtils.ensureSingleDefault(cards, cards.length === 1 ? 0 : null);
        customer.personalInfo.cards = cards;
        await customer.save();
    }
};

// Crea el pedido de un checkout aprobado. Solo una llamada gana el paso
// pending → processing, así que el pedido no se duplica aunque la
// redirección, el webhook y la app pregunten a la vez.
const createOrderFromCheckout = async (checkoutId, transaction) => {
    const checkout = await Checkout.findOneAndUpdate(
        { _id: checkoutId, status: "pending" },
        { $set: { status: "processing" } },
        { new: true },
    );
    if (!checkout) return Checkout.findById(checkoutId);

    try {
        const customer = await CustomerModel.findById(checkout.customer).select("personalInfo loginInfo.email");
        const order = await Order.create({
            orderType: "online",
            customer: checkout.customer,
            contact: {
                name: customer?.personalInfo?.name || "",
                lastname: customer?.personalInfo?.lastname || "",
                email: customer?.loginInfo?.email || "",
            },
            isDelivery: checkout.isDelivery,
            deliveryAddress: checkout.isDelivery ? checkout.deliveryAddress : undefined,
            paymentMethod: "online",
            paymentStatus: "paid",
            items: checkout.items,
            total: checkout.subtotal,
            payment: {
                // Todo con saldo a favor no pasa por Wompi.
                provider: checkout.chargeAmount > 0 ? "wompi" : "credit",
                transactionId: checkout.wompi?.transactionId || null,
                authorizationCode: transaction.codigoAutorizacion || null,
                amount: checkout.chargeAmount,
                creditApplied: checkout.creditApplied || 0,
                checkout: checkout._id,
            },
            status: "pending",
            statusHistory: [{ status: "pending", changedAt: new Date() }],
        });

        checkout.status = "approved";
        checkout.order = order._id;
        checkout.set("wompi.authorizationCode", transaction.codigoAutorizacion || null);
        checkout.set("wompi.message", null);
        await checkout.save();

        try {
            await savePendingCard(checkout);
        } catch (error) {
            console.error("checkoutController.savePendingCard:", error.message);
        }
        await Checkout.updateOne({ _id: checkout._id }, { $unset: { pendingCard: 1 } });

        const populated = await Order.findById(order._id).populate("customer", "personalInfo");
        emitToRoles(notificationUtils.AUDIENCE_BY_CATEGORY.orders, SOCKET_EVENTS.ORDER_CREATED, {
            order: populated.toObject(),
        });

        return checkout;
    } catch (error) {
        // Se cobró pero no se pudo crear el pedido: se deja marcado para que un
        // admin lo vea (y no se vuelva a intentar crear a ciegas).
        console.error("checkoutController.createOrderFromCheckout:", error);
        checkout.status = "error";
        checkout.set("wompi.message", "Pago aprobado, pero el pedido no se pudo registrar. Contacta a soporte.");
        await checkout.save();
        return checkout;
    }
};

// Devuelve al cliente el saldo que había apartado un pago que no se completó.
// `creditReleased` evita devolverlo dos veces.
const releaseCredit = async (checkout) => {
    if (!checkout?.creditApplied) return;
    const released = await Checkout.findOneAndUpdate(
        { _id: checkout._id, creditReleased: false },
        { $set: { creditReleased: true } },
    );
    if (released) {
        await CustomerModel.updateOne({ _id: checkout.customer }, { $inc: { "wallet.balance": checkout.creditApplied } });
    }
};

// Consulta a Wompi cómo va el cobro y actúa. `final` indica que el flujo 3DS
// ya terminó (redirección, webhook, cancelación o abandono): si no está
// aprobada en ese punto, se marca como rechazada.
const settleCheckout = async (checkout, { final = false } = {}) => {
    if (checkout.status !== "pending" || !checkout.wompi?.transactionId) return checkout;

    const { ok, data } = await wompiClient.getTransaction(checkout.wompi.transactionId);
    if (!ok) return checkout; // Wompi no respondió: se reintenta en la próxima consulta

    const approved = data?.esAprobada === true;
    const amountMatches = Math.abs(Number(data?.monto) - checkout.chargeAmount) < 0.01;

    if (approved && amountMatches) return createOrderFromCheckout(checkout._id, data);

    if (approved && !amountMatches) {
        console.error("checkoutController: monto distinto al esperado", checkout._id, data?.monto, checkout.chargeAmount);
    }

    const abandoned = Date.now() - new Date(checkout.createdAt).getTime() > ABANDONED_AFTER_MS;
    if (final || abandoned || (approved && !amountMatches)) {
        return Checkout.findOneAndUpdate(
            { _id: checkout._id, status: "pending" },
            {
                $set: {
                    status: "rejected",
                    "wompi.message": data?.mensaje || "El banco no aprobó el pago.",
                },
                $unset: { pendingCard: 1 },
            },
            { new: true },
        ).then(async (updated) => {
            if (updated) await releaseCredit(updated);
            return updated || Checkout.findById(checkout._id);
        });
    }

    return checkout;
};

// Lo que dice Wompi cuando rechaza un cobro (el formato cambia según el error).
const wompiRejectionText = (data) => {
    if (!data || typeof data !== "object") return "";
    const list = Array.isArray(data.mensajes) ? data.mensajes : [];
    return String(data.mensaje || data.message || list.join(" ") || data.title || "").slice(0, 200);
};

// Motivo que ve el cliente cuando el cobro no se pudo ni empezar. Sin datos
// sensibles, pero lo bastante claro para saber dónde buscar.
const describeStartError = (error) => {
    if (error instanceof WompiError) {
        if (error.code === "WOMPI_UNREACHABLE") {
            return { status: 504, title: "Pagos sin respuesta", message: "El servicio de pagos no respondió. Intenta de nuevo en un momento." };
        }
        return {
            status: 503,
            title: "Pagos en línea no disponibles",
            message: `El restaurante tiene un problema con su cuenta de pagos. Intenta más tarde. (${[error.code, error.detail].filter(Boolean).join(" ")})`,
        };
    }
    if (/CARD_ENCRYPTION_KEY/.test(error?.message || "")) {
        return { status: 503, title: "Pagos en línea no disponibles", message: "Falta configurar el cifrado de tarjetas en el servidor. (CARD_KEY)" };
    }
    if (error?.name === "ValidationError") {
        const fields = Object.keys(error.errors || {}).slice(0, 3).join(", ") || "VALIDATION";
        return { status: 500, title: "No se pudo iniciar el pago", message: `El pedido no se pudo guardar. (${fields})` };
    }
    return { status: 500, title: "No se pudo iniciar el pago", message: `Error inesperado del servidor. (${error?.name || "ERROR"})` };
};

// POST /payments/checkout
checkoutController.createCheckout = async (req, res) => {
    try {
        const { items: cartItems, isDelivery, deliveryAddress, card, saveCard, useCredit } = req.body || {};

        const built = await buildItems(cartItems);
        if (built.error) return res.status(400).json({ title: "Revisa tu pedido", message: built.error });

        if (isDelivery && (!deliveryAddress || String(deliveryAddress).trim().length < 5)) {
            return res.status(400).json({ title: "Falta la dirección", message: "Elige a dónde llevamos tu pedido." });
        }

        const customer = await CustomerModel.findById(req.user.id).select("personalInfo loginInfo.email wallet");
        if (!customer) return res.status(404).json({ title: "Cuenta no encontrada", message: "Vuelve a iniciar sesión." });

        // Sin propina: se cobra lo consumido.
        const amount = built.subtotal;

        // Saldo a favor: se aparta ahora (descuento atómico) y se devuelve si
        // el pago no se completa.
        const balance = round2(customer.wallet?.balance || 0);
        const creditApplied = useCredit ? round2(Math.min(balance, amount)) : 0;
        const chargeAmount = round2(amount - creditApplied);

        // Si el saldo cubre todo, no hace falta tarjeta.
        const resolved = chargeAmount > 0 ? resolveCard(customer, card) : {};
        if (resolved.error) return res.status(400).json({ title: "Revisa tu tarjeta", message: resolved.error });

        if (creditApplied > 0) {
            const reserved = await CustomerModel.updateOne(
                { _id: customer._id, "wallet.balance": { $gte: creditApplied } },
                { $inc: { "wallet.balance": -creditApplied } },
            );
            if (reserved.modifiedCount === 0) {
                return res.status(409).json({ title: "Tu saldo cambió", message: "Vuelve a abrir la pantalla de pago." });
            }
        }

        const checkout = await Checkout.create({
            customer: customer._id,
            items: built.items,
            subtotal: built.subtotal,
            amount,
            creditApplied,
            chargeAmount,
            isDelivery: !!isDelivery,
            deliveryAddress: isDelivery ? String(deliveryAddress).trim() : undefined,
            pendingCard: saveCard && resolved.newCard ? resolved.newCard : undefined,
        });

        // Pagado por completo con saldo: el pedido se crea de una vez.
        if (chargeAmount === 0) {
            const settled = await createOrderFromCheckout(checkout._id, {});
            return res.status(201).json({ ...publicCheckout(settled), paymentUrl: null, returnUrlPrefix: null });
        }

        const info = customer.personalInfo || {};
        const phone =
            normalizePhones(info.phones).find((p) => p.isDefault)?.number || "22222222";
        const defaultAddress = (info.addresses || []).find((a) => a.isDefault)?.details;
        const base = publicBaseUrl(req);

        // Si el cobro no arranca, queda en error y se devuelve el saldo apartado.
        const failCheckout = async (message) => {
            checkout.status = "error";
            checkout.wompi = { message };
            checkout.pendingCard = undefined;
            await checkout.save();
            await releaseCredit(checkout);
        };

        let wompiResponse;
        try {
            wompiResponse = await wompiClient.createTransaction3DS({
            monto: chargeAmount,
            email: customer.loginInfo?.email,
            nombre: info.name,
            apellido: info.lastname,
            ciudad: "San Salvador",
            direccion: (checkout.deliveryAddress || defaultAddress || "San Salvador").slice(0, 200),
            idPais: "SV",
            idRegion: "SV-SS",
            codigoPostal: "01101",
            telefono: phone,
            urlRedirect: `${base}${apiPrefix()}/payments/wompi/return?checkout=${checkout._id}`,
            tarjetaCreditoDebido: resolved.wompiCard,
            configuracion: {
                urlWebhook: `${base}${apiPrefix()}/payments/wompi/webhook`,
                notificarTransaccionCliente: true,
            },
            datosAdicionales: { checkoutId: String(checkout._id) },
            });
        } catch (error) {
            console.error("checkoutController.createCheckout: Wompi", error);
            await failCheckout(error.message);
            const described = describeStartError(error);
            return res.status(described.status).json({ title: described.title, message: described.message });
        }
        const { ok, status, data } = wompiResponse;

        if (!ok || !data?.urlCompletarPago3Ds || !data?.idTransaccion) {
            const reason = wompiRejectionText(data);
            await failCheckout(reason || "Wompi no aceptó el cobro.");
            console.error("checkoutController.createCheckout: Wompi", status, JSON.stringify(data).slice(0, 500));
            return res.status(502).json({
                title: "No se pudo iniciar el pago",
                message: reason
                    ? `Wompi no aceptó el cobro: ${reason}`
                    : `Wompi no aceptó el cobro (${status}). Revisa los datos de tu tarjeta o intenta con otra.`,
            });
        }

        checkout.wompi = { transactionId: data.idTransaccion, isReal: !!data.esReal };
        await checkout.save();

        return res.status(201).json({
            ...publicCheckout(checkout),
            paymentUrl: data.urlCompletarPago3Ds,
            // La app cierra la verificación cuando la vista navega aquí.
            returnUrlPrefix: `${base}${apiPrefix()}/payments/wompi/return`,
        });
    } catch (error) {
        console.error("checkoutController.createCheckout:", error);
        const described = describeStartError(error);
        return res.status(described.status).json({ title: described.title, message: described.message });
    }
};

// GET /payments/checkout/:id — la app pregunta cómo terminó su pago.
checkoutController.getCheckout = async (req, res) => {
    try {
        const checkout = await Checkout.findById(req.params.id);
        if (!checkout || String(checkout.customer) !== String(req.user.id)) {
            return res.status(404).json({ title: "Pago no encontrado", message: "No encontramos ese pago." });
        }
        const settled = await settleCheckout(checkout);
        return res.status(200).json(publicCheckout(settled));
    } catch (error) {
        console.error("checkoutController.getCheckout:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo consultar el pago." });
    }
};

// POST /payments/checkout/:id/cancel — el cliente cerró la verificación.
// Si en realidad sí se aprobó (cerró justo al final), se respeta el pago.
checkoutController.cancelCheckout = async (req, res) => {
    try {
        const checkout = await Checkout.findById(req.params.id);
        if (!checkout || String(checkout.customer) !== String(req.user.id)) {
            return res.status(404).json({ title: "Pago no encontrado", message: "No encontramos ese pago." });
        }
        const settled = await settleCheckout(checkout, { final: true });
        return res.status(200).json(publicCheckout(settled));
    } catch (error) {
        console.error("checkoutController.cancelCheckout:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo cancelar el pago." });
    }
};

// GET /payments/wompi/return — a donde Wompi manda al cliente tras el 3DS.
// La app intercepta esta URL y cierra la vista; esta página es solo por si
// se abrió en un navegador.
checkoutController.wompiReturn = async (req, res) => {
    try {
        const checkout = req.query.checkout ? await Checkout.findById(req.query.checkout) : null;
        if (checkout) await settleCheckout(checkout, { final: true });
    } catch (error) {
        console.error("checkoutController.wompiReturn:", error);
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
        '<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;text-align:center;padding:40px">' +
            "<h2>Listo</h2><p>Ya puedes volver a la app de Taquería El Corral.</p></body>",
    );
};

// POST /payments/wompi/webhook — aviso de Wompi. Solo se usa el id de la
// transacción para volver a consultarla: un webhook falso no puede aprobar nada.
checkoutController.wompiWebhook = async (req, res) => {
    try {
        const transactionId = req.body?.IdTransaccion || req.body?.idTransaccion;
        if (transactionId) {
            const checkout = await Checkout.findOne({ "wompi.transactionId": String(transactionId) });
            if (checkout) await settleCheckout(checkout, { final: true });
        }
    } catch (error) {
        console.error("checkoutController.wompiWebhook:", error);
    }
    // Siempre 200: si no, Wompi reintenta indefinidamente.
    return res.status(200).json({ received: true });
};

export default checkoutController;
