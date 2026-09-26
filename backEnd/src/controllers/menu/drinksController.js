// Importamos el modelo de las bebidas, Cloudinary para imágenes y validaciones
import drinkModel from "../../models/menu/drinksModel.js";
import { v2 as cloudinary } from "cloudinary";
import validationsDrinks from "../../utils/drinks/validationsDrinksUtils.js";
// Utilidad para registrar los movimientos del menú como notificaciones
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import settingsUtils from "../../utils/settings/settingsUtils.js";
import CartModel from "../../models/orders/cartModel.js";
import { findByNameInsensitive } from "../../utils/common/duplicateNameUtils.js";

// Creamos un objeto para agrupar todas las funciones de bebidas
const drinksController = {};

// Busca si ya existe una bebida con ese nombre (sugerencia, no bloqueo)
drinksController.checkName = async (req, res) => {
  try {
    const existing = await findByNameInsensitive(drinkModel, req.query.name);
    return res.status(200).json({ existing: existing || null });
  } catch (error) {
    console.error("drinksController.checkName:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// La receta llega como FormData, así que el arreglo viaja como string JSON
const parseRecipe = (rawRecipe) => {
  if (!rawRecipe) return [];
  if (Array.isArray(rawRecipe)) return rawRecipe;
  try {
    const parsed = JSON.parse(rawRecipe);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Solo las bebidas 'tercero' llevan stock propio; revisa el umbral configurado en Ajustes
const notifyIfLowStock = async (req, drink) => {
  try {
    if (drink.category !== "tercero") return;

    const settings = await settingsUtils.getOrCreateSettings();
    const threshold = settings.operation?.lowStockThresholds?.drinks ?? 10;

    if (Number(drink.quantity) > threshold) return;

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "low_stock",
      title: "Alerta de stock",
      message: `Stock bajo: la bebida ${drink.name} quedó en ${drink.quantity} unidades (mínimo ${threshold})`,
      icon: "triangle-exclamation",
      severity: "warning",
      entity: { model: "Drinks", id: drink._id, label: drink.name },
    });
  } catch (error) {
    console.error("drinksController.notifyIfLowStock:", error);
  }
};

// Obtiene todas las bebidas guardadas en el menú
drinksController.getAllDrinks = async (req, res) => {
  try {
    const drinks = await drinkModel.find().sort({ createdAt: -1 });
    return res.status(200).json(drinks);
  } catch (error) {
    console.error("drinksController.getAllDrinks:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Obtiene solo las bebidas que están marcadas como activas
drinksController.getActiveDrinks = async (req, res) => {
  try {
    // El panel guarda "disponible" (el default del modelo); se aceptan las
    // mismas variantes que en combos y platillos.
    const drinks = await drinkModel.find({ status: { $in: ["disponible", "activo", "active", "Disponible", "Activo"] } });

    return res.status(200).json(drinks);
  } catch (error) {
    console.error("drinksController.getActiveDrinks:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};


// Ranking de bebidas más vendidas. Hoy las bebidas solo aparecen en el carrito
// anidadas dentro de un extra (details.extras[].drinks[]), así que el conteo
// se limita a ese caso; no hay todavía selección de bebida dentro de un combo.
drinksController.getBestSellers = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;

    const ranking = await CartModel.aggregate([
      { $unwind: "$details" },
      { $unwind: "$details.extras" },
      { $unwind: "$details.extras.drinks" },
      {
        $group: {
          _id: "$details.extras.drinks.drinkId",
          totalSold: { $sum: 1 },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "drinks",
          localField: "_id",
          foreignField: "_id",
          as: "drink",
        },
      },
      { $unwind: "$drink" },
      { $project: { _id: 0, drink: 1, totalSold: 1 } },
    ]);

    return res.status(200).json(ranking);
  } catch (error) {
    console.error("drinksController.getBestSellers:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Crea una nueva bebida en la base de datos (imagen y receta opcionales)
drinksController.insertDrink = async (req, res) => {
  try {
    const { name, price, quantity, status, category, subcategory, description } = req.body;
    const recipe = parseRecipe(req.body.recipe);

    let validation = validationsDrinks.validateName(name);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsDrinks.validatePrice(price);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsDrinks.validateCategory(category);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsDrinks.validateQuantity(quantity, category);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsDrinks.validateRecipe(recipe, category);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    // Nace disponible por default: el admin no crea algo pensado para estar deshabilitado
    const finalStatus = status || "disponible";
    validation = validationsDrinks.validateStatus(finalStatus);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    // Crear nuevo registro. La receta solo aplica a bebidas 'casa'; la imagen es opcional
    const newDrink = new drinkModel({
      name,
      price,
      category,
      subcategory,
      description: description || "",
      quantity: category === "tercero" ? quantity : undefined,
      status: finalStatus,
      recipe: category === "casa" ? recipe : [],
      ...(req.file ? { image: req.file.path, publicId: req.file.filename } : {}),
    });

    // Guardar en la base de datos
    await newDrink.save();

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "created",
      title: "Bebida agregada",
      message: (actor) =>
        `${actor.name} agregó la bebida ${newDrink.name} al menú ($${Number(newDrink.price).toFixed(2)})`,
      icon: "wine-glass",
      severity: "success",
      entity: { model: "Drinks", id: newDrink._id, label: newDrink.name },
    });

    await notifyIfLowStock(req, newDrink);

    return res.status(200).json({
      title: "Bebida agregada", message: "La bebida se guardó correctamente.",
    });
  } catch (error) {
    console.error("drinksController.insertDrink:", error);
    return res.status(500).json({title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde.",});
  }
};

// Elimina una bebida del menú y también borra su imagen de Cloudinary
drinksController.deleteDrink = async (req, res) => {
  try {
    const drinkFound = await drinkModel.findById(req.params.id);
    if (!drinkFound) {
      return res.status(404).json({ title: "Bebida no encontrada", message: "No se encontró la bebida solicitada." });
    }

    // Si tiene imagen asociada, la borramos de Cloudinary
    if (drinkFound.publicId) {
      await cloudinary.uploader.destroy(drinkFound.publicId);
    }

    await drinkModel.findByIdAndDelete(req.params.id);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "deleted",
      title: "Bebida eliminada",
      message: (actor) => `${actor.name} eliminó la bebida ${drinkFound.name} del menú`,
      icon: "trash",
      severity: "danger",
      entity: { model: "Drinks", id: drinkFound._id, label: drinkFound.name },
    });

    return res.status(200).json({ title: "Bebida eliminada", message: "La bebida se eliminó correctamente." });
  } catch (error) {
    console.error("drinksController.deleteDrink:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Actualiza los datos de una bebida (precio, nombre, o si sube una imagen nueva)
drinksController.updateDrink = async (req, res) => {
  try {
    const { name, price, quantity, status, category, subcategory, description } = req.body;
    const recipe = parseRecipe(req.body.recipe);

    // Validaciones
    let validation = validationsDrinks.validateName(name);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsDrinks.validatePrice(price);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsDrinks.validateCategory(category);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsDrinks.validateQuantity(quantity, category);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsDrinks.validateRecipe(recipe, category);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    validation = validationsDrinks.validateStatus(status);
    if (!validation.valid) return res.status(400).json({ message: validation.message });

    // Verificar que la bebida existe
    const drinkFound = await drinkModel.findById(req.params.id);
    if (!drinkFound) {
      return res.status(404).json({ title: "Bebida no encontrada", message: "No se encontró la bebida solicitada." });
    }

    const updatedData = {
      name,
      price,
      category,
      subcategory,
      description: description || "",
      status,
      quantity: category === "tercero" ? quantity : undefined,
      recipe: category === "casa" ? recipe : [],
    };

    // Si se envió una nueva imagen, borramos la anterior (si existía) y guardamos la nueva
    if (req.file) {
      if (drinkFound.publicId) {
        await cloudinary.uploader.destroy(drinkFound.publicId);
      }
      updatedData.image = req.file.path;
      updatedData.publicId = req.file.filename;
    }

    const updatedDrink = await drinkModel.findByIdAndUpdate(req.params.id, updatedData, { new: true });

    // El cambio de precio es el que más interesa reportar
    const priceChanged = Number(drinkFound.price) !== Number(price);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "updated",
      title: "Bebida actualizada",
      message: (actor) =>
        priceChanged
          ? `${actor.name} cambió el precio de ${name}: de $${Number(drinkFound.price).toFixed(2)} a $${Number(price).toFixed(2)}`
          : `${actor.name} actualizó la bebida ${name}`,
      icon: "wine-glass",
      severity: "info",
      entity: { model: "Drinks", id: drinkFound._id, label: name },
    });

    await notifyIfLowStock(req, updatedDrink);

    return res.status(200).json({ title: "Bebida actualizada", message: "La bebida se actualizó correctamente." });
  } catch (error) {
    console.error("drinksController.updateDrink:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default drinksController;