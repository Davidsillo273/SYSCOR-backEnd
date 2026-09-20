// Promociones de hoy: ofertas temporales que combinan productos que ya
// existen en el menú (ej. "4 tacos + 1 burrito + refresco") a un precio
// especial y con una vigencia corta (máximo 3 días, ver MAX_PROMOTION_DAYS).
//
// La promoción NO duplica productos: solo referencia los que ya están en
// Saucers/Drinks/Combos/Extras. Por eso el precio original (lo que costaría
// comprar lo mismo suelto) siempre se recalcula acá contra los precios
// vigentes; nunca se confía en lo que mande el front.
import PromotionsModel, {
  MAX_PROMOTION_DAYS,
  PROMOTION_ITEM_MODELS,
} from "../../models/menu/promotionsModel.js";
import SaucersModel from "../../models/menu/saucersModel.js";
import DrinksModel from "../../models/menu/drinksModel.js";
import CombosModel from "../../models/menu/combosModel.js";
import ExtrasModel from "../../models/menu/extrasModel.js";
import { v2 as cloudinary } from "cloudinary";
import validationsPromotions from "../../utils/promotions/validationsPromotionsUtils.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { findByNameInsensitive } from "../../utils/common/duplicateNameUtils.js";

const promotionsController = {};

// Modelo de Mongoose por tipo de ítem, para poder leer el precio de cada
// línea sin un if encadenado en cada función
const MODELS_BY_ITEM_TYPE = {
  saucer: SaucersModel,
  drink: DrinksModel,
  combo: CombosModel,
  extra: ExtrasModel,
};

// items, y las listas de ingredientes dentro de cada item, viajan como string
// JSON cuando el admin sube una imagen (FormData no sabe de objetos)
const parseJsonField = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

// Normaliza las líneas que manda el admin: fija el itemModel que necesita
// refPath y limpia cantidades e ingredientes.
const normalizeItems = (items) =>
  items.map((item) => ({
    itemType: item.itemType,
    refId: item.refId,
    itemModel: PROMOTION_ITEM_MODELS[item.itemType],
    quantity: Math.max(1, Number(item.quantity ?? 1)),
    removedIngredients: Array.isArray(item.removedIngredients)
      ? item.removedIngredients.filter(Boolean)
      : [],
    addedIngredients: Array.isArray(item.addedIngredients)
      ? item.addedIngredients
          .filter((added) => added?.name || added?.extraId)
          .map((added) => ({ name: added.name || "", extraId: added.extraId || null }))
      : [],
  }));

/**
 * Cuánto costaría comprar por separado todo lo que incluye la promoción.
 * Se lee el precio actual de cada producto referenciado; si alguno ya no
 * existe se cuenta como 0 en vez de reventar (la promo sigue siendo válida,
 * simplemente el "antes" queda más bajo).
 */
const computeOriginalPrice = async (items) => {
  let total = 0;

  for (const item of items) {
    const Model = MODELS_BY_ITEM_TYPE[item.itemType];
    if (!Model) continue;

    const found = await Model.findById(item.refId).select("price").lean();
    total += (Number(found?.price) || 0) * (Number(item.quantity) || 1);
  }

  return Number(total.toFixed(2));
};

// Marca como "expirada" toda promo activa cuya ventana ya pasó. Se llama al
// leer en vez de con un cron: evita depender de un proceso aparte y el costo
// es una sola escritura el día que vence.
const expireFinishedPromotions = async () => {
  try {
    await PromotionsModel.updateMany(
      { status: "activa", endsAt: { $lt: new Date() } },
      { $set: { status: "expirada" } }
    );
  } catch (error) {
    // Que falle el barrido no puede impedir listar las promociones
    console.error("promotionsController.expireFinishedPromotions:", error);
  }
};

const populatePromotion = (query) =>
  query.populate("items.refId").populate("items.addedIngredients.extraId");

// Busca si ya existe una promoción con ese nombre (sugerencia, no bloqueo)
promotionsController.checkName = async (req, res) => {
  try {
    const existing = await findByNameInsensitive(PromotionsModel, req.query.name);
    return res.status(200).json({ existing: existing || null });
  } catch (error) {
    console.error("promotionsController.checkName:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Todas las promociones (incluidas pausadas y expiradas): es la tabla del panel
promotionsController.getAllPromotions = async (req, res) => {
  try {
    await expireFinishedPromotions();

    const promotions = await populatePromotion(PromotionsModel.find().sort({ createdAt: -1 }));

    return res.status(200).json(promotions);
  } catch (error) {
    console.error("promotionsController.getAllPromotions:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// "Promociones de hoy": solo las vigentes en este momento. Es lo que consume
// la app del cliente, por eso no exige rol de admin.
promotionsController.getTodayPromotions = async (req, res) => {
  try {
    await expireFinishedPromotions();

    const now = new Date();
    const promotions = await populatePromotion(
      PromotionsModel.find({
        status: "activa",
        startsAt: { $lte: now },
        endsAt: { $gte: now },
      }).sort({ endsAt: 1 })
    );

    return res.status(200).json(promotions);
  } catch (error) {
    console.error("promotionsController.getTodayPromotions:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

promotionsController.getPromotionById = async (req, res) => {
  try {
    const promotion = await populatePromotion(PromotionsModel.findById(req.params.id));

    if (!promotion) {
      return res.status(404).json({ title: "Promoción no encontrada", message: "No se encontró la promoción solicitada." });
    }

    return res.status(200).json(promotion);
  } catch (error) {
    console.error("promotionsController.getPromotionById:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Crea una promoción temporal (imagen opcional)
promotionsController.insertPromotion = async (req, res) => {
  try {
    const { name, description, price, startsAt, endsAt, aiSuggested } = req.body;
    const items = parseJsonField(req.body.items, []);

    let validation = validationsPromotions.validateName(name);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsPromotions.validateDescription(description);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsPromotions.validateItems(items);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsPromotions.validatePrice(price);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    const window = validationsPromotions.validateWindow(startsAt, endsAt);
    if (!window.valid) return res.status(400).json({ message: window.message });

    const normalizedItems = normalizeItems(items);
    const originalPrice = await computeOriginalPrice(normalizedItems);

    const newPromotion = new PromotionsModel({
      name,
      description,
      items: normalizedItems,
      price: Number(price),
      originalPrice,
      startsAt: window.start,
      endsAt: window.end,
      status: "activa",
      aiSuggested: aiSuggested === "true" || aiSuggested === true,
      ...(req.file ? { image: req.file.path, publicId: req.file.filename } : {}),
    });

    await newPromotion.save();

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "created",
      title: "Promoción creada",
      message: (actor) =>
        `${actor.name} creó la promoción ${newPromotion.name} a $${Number(newPromotion.price).toFixed(2)}, vigente hasta el ${window.end.toLocaleDateString("es-SV")}`,
      icon: "tag",
      severity: "success",
      entity: { model: "Promotions", id: newPromotion._id, label: newPromotion.name },
    });

    return res.status(201).json({
      title: "Promoción creada",
      message: "La promoción se guardó correctamente.",
      newPromotion,
    });
  } catch (error) {
    console.error("promotionsController.insertPromotion:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Actualiza una promoción (composición, precio, vigencia y/o imagen)
promotionsController.updatePromotion = async (req, res) => {
  try {
    const { name, description, price, startsAt, endsAt, status } = req.body;
    const items = parseJsonField(req.body.items, []);

    let validation = validationsPromotions.validateName(name);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsPromotions.validateDescription(description);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsPromotions.validateItems(items);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsPromotions.validatePrice(price);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    const window = validationsPromotions.validateWindow(startsAt, endsAt);
    if (!window.valid) return res.status(400).json({ message: window.message });

    const finalStatus = status || "activa";
    validation = validationsPromotions.validateStatus(finalStatus);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    const promotionFound = await PromotionsModel.findById(req.params.id);
    if (!promotionFound) {
      return res.status(404).json({ title: "Promoción no encontrada", message: "No se encontró la promoción solicitada." });
    }

    const normalizedItems = normalizeItems(items);

    const updatedData = {
      name,
      description,
      items: normalizedItems,
      price: Number(price),
      originalPrice: await computeOriginalPrice(normalizedItems),
      startsAt: window.start,
      endsAt: window.end,
      status: finalStatus,
    };

    // Imagen nueva: borramos la anterior de Cloudinary para no dejar basura
    if (req.file) {
      if (promotionFound.publicId) {
        await cloudinary.uploader.destroy(promotionFound.publicId);
      }
      updatedData.image = req.file.path;
      updatedData.publicId = req.file.filename;
    }

    const updatedPromotion = await PromotionsModel.findByIdAndUpdate(req.params.id, updatedData, { new: true });

    const priceChanged = Number(promotionFound.price) !== Number(price);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "updated",
      title: "Promoción actualizada",
      message: (actor) =>
        priceChanged
          ? `${actor.name} cambió el precio de la promoción ${updatedPromotion.name}: de $${Number(promotionFound.price).toFixed(2)} a $${Number(price).toFixed(2)}`
          : `${actor.name} actualizó la promoción ${updatedPromotion.name}`,
      icon: "tag",
      severity: "info",
      entity: { model: "Promotions", id: updatedPromotion._id, label: updatedPromotion.name },
    });

    return res.status(200).json({
      title: "Promoción actualizada",
      message: "La promoción se actualizó correctamente.",
      updatedPromotion,
    });
  } catch (error) {
    console.error("promotionsController.updatePromotion:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Pausar o reanudar sin tener que reenviar toda la promoción. Es el botón que
// el admin necesita cuando se acaba el producto a media tarde.
promotionsController.setStatus = async (req, res) => {
  try {
    const { status } = req.body;

    const validation = validationsPromotions.validateStatus(status);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    const promotionFound = await PromotionsModel.findById(req.params.id);
    if (!promotionFound) {
      return res.status(404).json({ title: "Promoción no encontrada", message: "No se encontró la promoción solicitada." });
    }

    // Reactivar una promo cuya ventana ya venció no tendría efecto: quedaría
    // "activa" pero invisible. Mejor decirlo que dejar al admin adivinando.
    if (status === "activa" && promotionFound.endsAt && new Date(promotionFound.endsAt) < new Date()) {
      return res.status(400).json({
        title: "Promoción vencida",
        message: "Esta promoción ya terminó. Edita su vigencia para volver a activarla.",
      });
    }

    promotionFound.status = status;
    await promotionFound.save();

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "updated",
      title: status === "pausada" ? "Promoción pausada" : "Promoción reactivada",
      message: (actor) =>
        status === "pausada"
          ? `${actor.name} pausó la promoción ${promotionFound.name}`
          : `${actor.name} reactivó la promoción ${promotionFound.name}`,
      icon: "tag",
      severity: status === "pausada" ? "warning" : "success",
      entity: { model: "Promotions", id: promotionFound._id, label: promotionFound.name },
    });

    return res.status(200).json({
      title: "Estado actualizado",
      message: `La promoción quedó como ${status}.`,
      promotion: promotionFound,
    });
  } catch (error) {
    console.error("promotionsController.setStatus:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Elimina una promoción y su imagen alojada en Cloudinary
promotionsController.deletePromotion = async (req, res) => {
  try {
    const promotionFound = await PromotionsModel.findById(req.params.id);

    if (!promotionFound) {
      return res.status(404).json({ title: "Promoción no encontrada", message: "No se encontró la promoción solicitada." });
    }

    if (promotionFound.publicId) {
      await cloudinary.uploader.destroy(promotionFound.publicId);
    }

    await PromotionsModel.findByIdAndDelete(req.params.id);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "deleted",
      title: "Promoción eliminada",
      message: (actor) => `${actor.name} eliminó la promoción ${promotionFound.name}`,
      icon: "trash",
      severity: "danger",
      entity: { model: "Promotions", id: promotionFound._id, label: promotionFound.name },
    });

    return res.status(200).json({ title: "Promoción eliminada", message: "La promoción se eliminó correctamente." });
  } catch (error) {
    console.error("promotionsController.deletePromotion:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Vista previa de precios: dado un armado, devuelve cuánto costaría suelto.
// El panel la llama mientras el admin agrega productos, para que vea el
// ahorro en vivo antes de guardar nada.
promotionsController.previewPricing = async (req, res) => {
  try {
    const items = parseJsonField(req.body.items, []);

    const validation = validationsPromotions.validateItems(items);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    const originalPrice = await computeOriginalPrice(normalizeItems(items));
    const price = Number(req.body.price);
    const hasPrice = Number.isFinite(price) && price > 0;

    return res.status(200).json({
      originalPrice,
      price: hasPrice ? price : null,
      savings: hasPrice ? Number((originalPrice - price).toFixed(2)) : null,
      discountPercent:
        hasPrice && originalPrice > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0,
      maxDays: MAX_PROMOTION_DAYS,
    });
  } catch (error) {
    console.error("promotionsController.previewPricing:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default promotionsController;
export { computeOriginalPrice, MODELS_BY_ITEM_TYPE };
