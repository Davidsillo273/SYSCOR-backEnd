// Endpoints de asistencia con IA (Gemini). Todo lo que devuelven es una
// SUGERENCIA editable: el admin siempre puede ignorarla, cambiarla o
// simplemente no usarla. Ninguna conversión de unidades ni descuento de
// inventario pasa por aquí — eso vive en unitsUtils/deductionUtils.
import { callGemini } from "../../utils/ai/geminiUtils.js";
import InventoryModel from "../../models/inventory/inventoryModel.js";
import CartModel from "../../models/orders/cartModel.js";
import SaucersModel from "../../models/menu/saucersModel.js";
import DrinksModel from "../../models/menu/drinksModel.js";
import CombosModel from "../../models/menu/combosModel.js";
import { MAX_PROMOTION_DAYS } from "../../models/menu/promotionsModel.js";
import { UNIT_LIST } from "../../utils/units/unitsUtils.js";

const aiController = {};

// Sugiere una receta estándar para un insumo compuesto nuevo, a partir de su
// nombre y la cantidad que se quiere producir. El admin la ve como punto de
// partida, no como valor definitivo.
aiController.suggestRecipe = async (req, res) => {
  try {
    const { name, quantity, unit } = req.body;

    if (!name || !quantity || !unit) {
      return res.status(400).json({ title: "Datos incompletos", message: "Se necesita nombre, cantidad y unidad." });
    }

    const prompt = `Eres un asistente de cocina para un restaurante mexicano en El Salvador.
El admin quiere crear el ingrediente compuesto: ${name}.
Sugiere una receta estándar con cantidades para producir ${quantity} ${unit} de este ingrediente.
Devuelve SOLO un JSON con este formato exacto, sin texto adicional:
{ "ingredients": [{ "name": string, "quantity": number, "unit": string }] }
Usa solo estas unidades (en español): ${UNIT_LIST.join(", ")}.`;

    const suggestion = await callGemini(prompt);

    if (!suggestion || !Array.isArray(suggestion.ingredients)) {
      // La IA no respondió o falló: no es un error, simplemente no hay sugerencia
      return res.status(200).json({ ingredients: [] });
    }

    // Intentamos casar cada nombre sugerido contra insumos ya existentes
    // (por nombre, sin distinguir mayúsculas), para que el front pueda
    // ofrecer "ya existe" en vez de crear todo de cero.
    const matched = await Promise.all(
      suggestion.ingredients.map(async (item) => {
        if (!item?.name) return null;
        const existing = await InventoryModel.findOne({
          itemType: "producto",
          name: { $regex: `^${String(item.name).trim()}$`, $options: "i" },
        });
        return {
          name: item.name,
          quantity: Number(item.quantity) || 0,
          unit: UNIT_LIST.includes(item.unit) ? item.unit : "unidad",
          inventoryId: existing?._id || null,
        };
      })
    );

    return res.status(200).json({ ingredients: matched.filter(Boolean) });
  } catch (error) {
    console.error("aiController.suggestRecipe:", error);
    // La sugerencia es un extra: si algo falla, el modal sigue funcionando sin ella
    return res.status(200).json({ ingredients: [] });
  }
};

// Proyección de qué insumos se van a agotar pronto, a partir del inventario
// actual y los pedidos de los últimos 7 días. Se cachea en memoria por el
// resto del día para no gastar cuota cada vez que alguien abre el dashboard.
let forecastCache = { date: null, data: null };

aiController.stockForecast = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const force = req.query.force === "true";

    if (!force && forecastCache.date === today && forecastCache.data) {
      return res.status(200).json(forecastCache.data);
    }

    const inventory = await InventoryModel
      .find({ itemType: "producto", status: { $ne: "Agotado" } })
      .select("name quantity unit lowStockAlert")
      .lean();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentOrders = await CartModel
      .find({ createdAt: { $gte: sevenDaysAgo } })
      .select("details createdAt")
      .populate("details.combos.comboId", "name")
      .populate("details.extras.extraId", "name")
      .lean();

    // Resumen simple: cuántas veces se pidió cada combo/extra en la semana
    const ordersSummary = {};
    for (const cart of recentOrders) {
      for (const detail of cart.details || []) {
        for (const c of detail.combos || []) {
          const label = c.comboId?.name || "Combo";
          ordersSummary[label] = (ordersSummary[label] || 0) + (c.quantity || 1);
        }
        for (const e of detail.extras || []) {
          const label = e.extraId?.name || "Extra";
          ordersSummary[label] = (ordersSummary[label] || 0) + (e.quantity || 1);
        }
      }
    }

    const prompt = `Dado este inventario actual: ${JSON.stringify(inventory)}
y estos pedidos de los últimos 7 días: ${JSON.stringify(ordersSummary)},
¿qué ingredientes proyectás que se agotarán en los próximos 3 días?
Devuelve SOLO un JSON:
{ "alerts": [{ "ingredient": string, "currentStock": number, "unit": string, "projectedDaysLeft": number, "recommendation": string }] }`;

    const forecast = await callGemini(prompt);
    const data = { alerts: Array.isArray(forecast?.alerts) ? forecast.alerts : [] };

    forecastCache = { date: today, data };

    return res.status(200).json(data);
  } catch (error) {
    console.error("aiController.stockForecast:", error);
    // Sin proyección no pasa nada: el panel simplemente no muestra alertas
    return res.status(200).json({ alerts: [] });
  }
};

// Sugiere promociones del día a partir del menú real. La IA nunca inventa
// productos: recibe el catálogo activo con sus IDs y solo puede combinar de
// ahí; todo ID que devuelva y no exista en el catálogo se descarta acá.
//
// Como todo en este archivo, es una SUGERENCIA: el admin la ve precargada en
// el modal de "Promociones de hoy" y decide si la guarda, la edita o la tira.
aiController.suggestPromotion = async (req, res) => {
  try {
    const { idea, maxSuggestions } = req.body;
    const limit = Math.min(Math.max(Number(maxSuggestions) || 3, 1), 5);

    // Solo lo que hoy se puede vender: no tiene sentido proponer una promo
    // con un platillo que está fuera de carta.
    const [saucers, drinks, combos] = await Promise.all([
      SaucersModel.find({ status: "Activo" }).select("name category subcategory price").lean(),
      DrinksModel.find({ status: "disponible" }).select("name category price").lean(),
      CombosModel.find({ status: "disponible" }).select("name category price").lean(),
    ]);

    if (saucers.length === 0 && combos.length === 0) {
      // Sin catálogo no hay nada que combinar: no es un error, simplemente
      // el admin todavía no tiene productos activos
      return res.status(200).json({ suggestions: [] });
    }

    // Catálogo compacto (solo lo que la IA necesita para decidir), con el ID
    // que después usaremos para validar lo que devuelva
    const catalog = {
      saucer: saucers.map((s) => ({ id: String(s._id), name: s.name, category: s.category, price: s.price })),
      drink: drinks.map((d) => ({ id: String(d._id), name: d.name, price: d.price })),
      combo: combos.map((c) => ({ id: String(c._id), name: c.name, price: c.price })),
    };

    const prompt = `Eres el encargado de marketing de una taquería mexicana en El Salvador.
Arma ${limit} promociones temporales atractivas combinando ÚNICAMENTE productos de este catálogo:
${JSON.stringify(catalog)}
${idea ? `El administrador quiere algo en esta línea: "${idea}".` : ""}
Reglas:
- Cada promoción combina entre 2 y 4 productos (ej. 4 tacos + 1 burrito + 1 bebida).
- Usa exactamente los "id" del catálogo, nunca inventes productos ni IDs.
- El precio promocional debe ser menor que la suma de los precios sueltos, con un descuento entre 10% y 30%.
- Los precios son en dólares estadounidenses.
- "removedIngredients" es opcional: ingredientes que la promo quita del platillo.
- Duran como máximo ${MAX_PROMOTION_DAYS} días.
Devuelve SOLO un JSON con este formato exacto, sin texto adicional:
{ "suggestions": [{ "name": string, "description": string, "price": number, "durationDays": number, "items": [{ "itemType": "saucer" | "drink" | "combo", "refId": string, "quantity": number, "removedIngredients": [string] }] }] }`;

    const suggestion = await callGemini(prompt);

    if (!suggestion || !Array.isArray(suggestion.suggestions)) {
      // La IA no respondió o falló: el modal sigue sirviendo para armar la
      // promoción a mano
      return res.status(200).json({ suggestions: [] });
    }

    // Índice id -> producto real, para quedarnos solo con lo que existe y
    // recalcular nosotros el precio suelto (el número que dé la IA no manda)
    const byId = new Map();
    for (const [itemType, list] of Object.entries(catalog)) {
      for (const item of list) byId.set(`${itemType}:${item.id}`, item);
    }

    const suggestions = suggestion.suggestions
      .map((promo) => {
        const items = (Array.isArray(promo?.items) ? promo.items : [])
          .map((item) => {
            const found = byId.get(`${item?.itemType}:${item?.refId}`);
            if (!found) return null;

            return {
              itemType: item.itemType,
              refId: found.id,
              name: found.name,
              quantity: Math.max(1, Number(item.quantity) || 1),
              removedIngredients: Array.isArray(item.removedIngredients)
                ? item.removedIngredients.filter(Boolean)
                : [],
            };
          })
          .filter(Boolean);

        // Una sugerencia de la que no sobrevivió ningún producto real no sirve
        if (items.length === 0) return null;

        const originalPrice = Number(
          items.reduce((sum, item) => {
            const found = byId.get(`${item.itemType}:${item.refId}`);
            return sum + (Number(found?.price) || 0) * item.quantity;
          }, 0).toFixed(2)
        );

        const price = Number(promo?.price);
        // Si la IA propuso un precio absurdo (mayor o igual al normal, o no
        // numérico), caemos a un 20% de descuento, que es el punto medio del
        // rango que le pedimos
        const finalPrice =
          Number.isFinite(price) && price > 0 && price < originalPrice
            ? Number(price.toFixed(2))
            : Number((originalPrice * 0.8).toFixed(2));

        // La vigencia nunca puede salirse del máximo del módulo
        const durationDays = Math.min(
          Math.max(Number(promo?.durationDays) || 1, 1),
          MAX_PROMOTION_DAYS
        );

        return {
          name: promo?.name || "Promoción del día",
          description: promo?.description || "",
          items,
          originalPrice,
          price: finalPrice,
          discountPercent:
            originalPrice > 0 ? Math.round(((originalPrice - finalPrice) / originalPrice) * 100) : 0,
          durationDays,
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    return res.status(200).json({ suggestions, maxDays: MAX_PROMOTION_DAYS });
  } catch (error) {
    console.error("aiController.suggestPromotion:", error);
    // La sugerencia es un extra: si algo falla, el admin arma la promo a mano
    return res.status(200).json({ suggestions: [] });
  }
};

export default aiController;
