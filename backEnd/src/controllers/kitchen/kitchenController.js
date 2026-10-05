// Sistema de Cocina (KDS): emparejamiento de pantallas y la API que ellas usan.
//
// Dos públicos distintos, nunca mezclados:
//   - Administrador (cookie de sesión): empareja pantallas, las desvincula y
//     apaga el sistema (kill switch).
//   - Pantalla de cocina (token de dispositivo): lee sus comandas y cambia su
//     estado entre "En cocina" y "Lista". Todo lo que se le devuelve pasa por
//     kitchenOrderView: sin totales, pagos ni datos de contacto.
import Order from "../../models/orders/orderModel.js";
import Saucers from "../../models/menu/saucersModel.js";
import Combos from "../../models/menu/combosModel.js";
import Drinks from "../../models/menu/drinksModel.js";
import Extras from "../../models/menu/extrasModel.js";
import KitchenDeviceModel from "../../models/kitchen/kitchenDeviceModel.js";
import settingsUtils from "../../utils/settings/settingsUtils.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { WAITER_POPULATE } from "../../utils/orders/waiterPopulate.js";
import { releaseExpiredHolds } from "../../utils/orders/orderHoldUtils.js";
import { requestKitchenSync } from "../../utils/orders/kitchenQueueUtils.js";
import { signDeviceToken } from "../../utils/kitchen/deviceTokenUtils.js";
import { revokeKitchenDevices, publicDevice } from "../../utils/kitchen/kitchenDeviceUtils.js";
import { toKitchenOrder } from "../../utils/kitchen/kitchenOrderView.js";
import { nextKitchenNumber } from "../../utils/orders/orderCodeUtils.js";
import { applyOrderStatus, flagDelayedOrders } from "../orders/orderController.js";
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";
import { findPairing, deliverDeviceToken, disconnectKitchenDevices } from "../../config/kitchenSocket.js";
import { KITCHEN_DEVICE_STATUSES } from "../../constants/kitchenDevice.js";

const kitchenController = {};

const SERVER_ERROR = { title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." };

// Lo que necesita saber una pantalla del sistema (nunca quién lo cambió)
const publicKitchen = (kitchen) => ({
    enabled: Boolean(kitchen?.enabled),
    warningMinutes: kitchen?.warningMinutes,
    maxMinutes: kitchen?.maxMinutes,
});

// Avisa al panel y a las pantallas de que cambió el sistema o sus pantallas
const broadcastKitchen = (settings, { devicesChanged = true, statusChanged = false } = {}) => {
    if (statusChanged) {
        emitToRoles(["admin", "employee"], SOCKET_EVENTS.KITCHEN_STATUS_CHANGED, { kitchen: settings.toObject().kitchen });
    }
    if (devicesChanged) emitToRoles(["admin"], SOCKET_EVENTS.KITCHEN_DEVICES_CHANGED, {});
};

// Comandas que ve cocina: las activas y las que se marcaron listas hace poco
const READY_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["pending", "preparing", "atrasado"];

// ======================== Administrador ========================

// Pantallas emparejadas y estado del sistema
kitchenController.listDevices = async (req, res) => {
    try {
        const [settings, devices] = await Promise.all([
            settingsUtils.getOrCreateSettings(),
            KitchenDeviceModel.find().sort({ active: -1, pairedAt: -1 }).limit(50).lean(),
        ]);
        return res.status(200).json({ kitchen: settings.toObject().kitchen, devices: devices.map(publicDevice) });
    } catch (error) {
        console.error("kitchenController.listDevices:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// Emparejar: el admin escribe el código que muestra la pantalla. Habilita el
// sistema (si estaba apagado), crea el token de esa pantalla y se lo entrega
// por socket SOLO a ella.
kitchenController.pairDevice = async (req, res) => {
    try {
        const code = String(req.body?.code || "").replace(/\D/g, "");
        const pairing = findPairing(code);
        if (!pairing) {
            return res.status(404).json({ title: "Código no encontrado", message: "Ese código no corresponde a ninguna pantalla esperando, o ya venció. Revisa el código que muestra la pantalla de cocina." });
        }

        const actor = await notificationUtils.resolveActor(req);
        const device = await KitchenDeviceModel.findOneAndUpdate(
            { deviceId: pairing.deviceId },
            {
                $set: {
                    active: true,
                    userAgent: pairing.userAgent || null,
                    pairedBy: { id: req.user.id, name: actor.name },
                    pairedAt: new Date(),
                    revokedAt: null,
                    lastSeenAt: new Date(),
                },
                // Emparejar otra vez invalida cualquier token anterior de esta pantalla
                $inc: { tokenVersion: 1 },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        const settings = await settingsUtils.getOrCreateSettings();
        const wasEnabled = Boolean(settings.kitchen.enabled);
        if (!wasEnabled) {
            settings.kitchen.enabled = true;
            settings.kitchen.changedAt = new Date();
            settings.kitchen.changedBy = actor.name;
            await settings.save();
        }

        const delivered = deliverDeviceToken(pairing, {
            token: signDeviceToken(device),
            deviceId: device.deviceId,
            kitchen: publicKitchen(settings.kitchen),
        });
        if (!delivered) {
            // La pantalla se fue entre que mostró el código y ahora: ese
            // emparejamiento no debe quedar vivo sin nadie que lo use.
            await revokeKitchenDevices({ deviceId: device.deviceId });
            return res.status(409).json({ title: "Pantalla desconectada", message: "La pantalla de cocina se desconectó antes de recibir el acceso. Recárgala y usa el código nuevo." });
        }

        broadcastKitchen(settings, { statusChanged: !wasEnabled });
        if (!wasEnabled) requestKitchenSync();

        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "updated",
            title: "Pantalla de cocina emparejada",
            message: (who) => `${who.name} emparejó una pantalla de cocina${wasEnabled ? "" : " y habilitó el sistema de cocina"}`,
            icon: "utensils",
            severity: "info",
            entity: { model: "KitchenDevice", id: device._id, label: "Sistema de cocina" },
        });

        return res.status(200).json({
            title: "Pantalla emparejada",
            message: "La pantalla de cocina ya está recibiendo comandas.",
            data: { kitchen: settings.toObject().kitchen, device: publicDevice(device) },
        });
    } catch (error) {
        console.error("kitchenController.pairDevice:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// Desvincular una pantalla (kill switch individual)
kitchenController.unpairDevice = async (req, res) => {
    try {
        const revoked = await revokeKitchenDevices({ deviceId: req.params.deviceId });
        if (revoked.length === 0) {
            return res.status(404).json({ title: "Pantalla no encontrada", message: "Esa pantalla no está emparejada." });
        }
        disconnectKitchenDevices(revoked, { reason: "revoked", message: "Un administrador desvinculó esta pantalla." });
        emitToRoles(["admin"], SOCKET_EVENTS.KITCHEN_DEVICES_CHANGED, {});

        await notificationUtils.createNotification({
            req,
            category: "settings",
            action: "updated",
            title: "Pantalla de cocina desvinculada",
            message: (who) => `${who.name} desvinculó una pantalla de cocina`,
            icon: "utensils",
            severity: "warning",
            entity: { model: "KitchenDevice", label: "Sistema de cocina" },
        });

        return res.status(200).json({ title: "Pantalla desvinculada", message: "La pantalla volvió al lobby." });
    } catch (error) {
        console.error("kitchenController.unpairDevice:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// Apagar el sistema de cocina (kill switch general): todas las pantallas
// pierden su token al instante y vuelven al lobby.
kitchenController.disableKitchen = async (req, res) => {
    try {
        const settings = await settingsUtils.getOrCreateSettings();
        const wasEnabled = Boolean(settings.kitchen.enabled);
        if (wasEnabled) {
            const actor = await notificationUtils.resolveActor(req);
            settings.kitchen.enabled = false;
            settings.kitchen.changedAt = new Date();
            settings.kitchen.changedBy = actor.name;
            await settings.save();
        }

        const revoked = await revokeKitchenDevices();
        disconnectKitchenDevices(revoked, { reason: "disabled", message: "El sistema de cocina se deshabilitó." });
        broadcastKitchen(settings, { statusChanged: wasEnabled });

        if (wasEnabled) {
            await notificationUtils.createNotification({
                req,
                category: "settings",
                action: "updated",
                title: "Sistema de cocina deshabilitado",
                message: (who) => `${who.name} deshabilitó el sistema de cocina`,
                icon: "utensils",
                severity: "warning",
                entity: { model: "Settings", id: settings._id, label: "Sistema de cocina" },
            });
        }

        return res.status(200).json({
            title: "Sistema de cocina deshabilitado",
            message: "Las pantallas de cocina volvieron al lobby.",
            data: { kitchen: settings.toObject().kitchen, revokedDevices: revoked.length },
        });
    } catch (error) {
        console.error("kitchenController.disableKitchen:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// ======================== Pantalla de cocina ========================

kitchenController.getStatus = async (req, res) => {
    try {
        const settings = await settingsUtils.getOrCreateSettings();
        return res.status(200).json({ deviceId: req.kitchenDevice.deviceId, kitchen: publicKitchen(settings.kitchen) });
    } catch (error) {
        console.error("kitchenController.getStatus:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

kitchenController.getOrders = async (req, res) => {
    try {
        // Igual que el listado del panel: antes de responder se marcan las
        // atrasadas y se liberan las pausas vencidas.
        await flagDelayedOrders();
        await releaseExpiredHolds();

        const from = new Date(Date.now() - READY_LOOKBACK_MS);
        const orders = await Order.find({
            $or: [
                { status: { $in: ACTIVE_STATUSES } },
                { status: "ready", createdAt: { $gte: from } },
            ],
        })
            .populate("table", "number")
            .populate(WAITER_POPULATE)
            .populate("customer", "personalInfo.name personalInfo.lastname")
            .sort({ createdAt: 1 });

        // Pedidos de antes de que existiera el número de cocina (o creados por
        // un camino que no lo asignó): se les da uno ahora, en el orden en que
        // se pidieron y con el contador de su día. Se guarda solo si sigue
        // vacío, así dos pantallas a la vez no le dan dos números distintos.
        for (const order of orders) {
            if (order.kitchenNumber) continue;
            const number = await nextKitchenNumber(order.createdAt || new Date());
            const saved = await Order.findOneAndUpdate(
                { _id: order._id, kitchenNumber: null },
                { $set: { kitchenNumber: number } },
                { new: true, projection: { kitchenNumber: 1 } },
            );
            order.kitchenNumber = saved?.kitchenNumber ?? (await Order.findById(order._id).select("kitchenNumber").lean())?.kitchenNumber;
        }
        orders.reverse();

        return res.status(200).json({ orders: orders.map(toKitchenOrder) });
    } catch (error) {
        console.error("kitchenController.getOrders:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// Lo del menú que cocina necesita para preparar: categoría (color de la
// estación) y receta. Sin precios, existencias ni imágenes.
const pickRecipe = (recipe = []) => recipe.map(({ name, quantity, unit }) => ({ name, quantity, unit }));
const pickSaucer = (saucer) =>
    saucer && { _id: saucer._id, name: saucer.name, category: saucer.category, quantity: saucer.quantity, recipe: pickRecipe(saucer.recipe) };

kitchenController.getMenu = async (req, res) => {
    try {
        const [saucers, combos, drinks, extras] = await Promise.all([
            Saucers.find().select("name category quantity recipe").lean(),
            Combos.find()
                .select("name selective selectiveMaxPicks saucers selectiveOptions")
                .populate("saucers.saucerId", "name category quantity recipe")
                .populate("selectiveOptions.saucerId", "name category quantity recipe")
                .lean(),
            Drinks.find().select("name recipe").lean(),
            Extras.find().select("name ingredients").populate("ingredients.ingredientId", "name unit").lean(),
        ]);

        return res.status(200).json({
            saucers: saucers.map(pickSaucer),
            combos: combos.map((combo) => ({
                _id: combo._id,
                name: combo.name,
                selective: combo.selective,
                selectiveMaxPicks: combo.selectiveMaxPicks,
                saucers: (combo.saucers || []).map((entry) => ({ saucerId: pickSaucer(entry.saucerId) })),
                selectiveOptions: (combo.selectiveOptions || []).map((entry) => ({ saucerId: pickSaucer(entry.saucerId) })),
            })),
            drinks: drinks.map((drink) => ({ _id: drink._id, name: drink.name, recipe: pickRecipe(drink.recipe) })),
            extras: extras.map((extra) => ({
                _id: extra._id,
                name: extra.name,
                ingredients: (extra.ingredients || []).map((ingredient) => ({
                    ingredientId: ingredient.ingredientId
                        ? { name: ingredient.ingredientId.name, unit: ingredient.ingredientId.unit }
                        : null,
                    quantity: ingredient.quantity,
                    unit: ingredient.unit,
                })),
            })),
        });
    } catch (error) {
        console.error("kitchenController.getMenu:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

// "En cocina" o "Lista": las únicas transiciones de una pantalla de cocina.
// Las reglas son las de siempre (applyOrderStatus): no se empieza un 2º
// tiempo que el mesero no ha marchado ni un pedido con el cliente agregando.
kitchenController.updateOrderStatus = async (req, res) => {
    try {
        const { status } = req.body || {};
        if (!KITCHEN_DEVICE_STATUSES.includes(status)) {
            return res.status(403).json({
                code: "DEVICE_FORBIDDEN",
                title: "Estado no permitido",
                message: "Una pantalla de cocina solo puede pasar comandas a En cocina o a Lista.",
            });
        }

        // Solo comandas que están en manos de cocina (ni entregadas ni canceladas)
        const current = await Order.findById(req.params.id).select("status").lean();
        if (!current) return res.status(404).json({ title: "Comanda no encontrada", message: "Esta comanda ya no existe." });
        if (![...ACTIVE_STATUSES, "ready"].includes(current.status)) {
            return res.status(409).json({ title: "Comanda cerrada", message: "Esta comanda ya se entregó o se canceló." });
        }

        const result = await applyOrderStatus({ orderId: req.params.id, status, user: null });
        if (result.code !== 200) return res.status(result.code).json(result.body);
        return res.status(200).json({ message: result.body.message, data: toKitchenOrder(result.order) });
    } catch (error) {
        console.error("kitchenController.updateOrderStatus:", error);
        return res.status(500).json(SERVER_ERROR);
    }
};

export default kitchenController;
