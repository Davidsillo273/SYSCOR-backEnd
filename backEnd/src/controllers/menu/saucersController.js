// Importamos el modelo de los platillos, Cloudinary para imágenes y validaciones
import SaucersModel from "../../models/menu/saucersModel.js";
import { v2 as cloudinary } from "cloudinary";
import validationsSaucers from "../../utils/saucers/validationsSaucersUtils.js";
// Utilidad para registrar los movimientos del menú como notificaciones
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import CartModel from "../../models/orders/cartModel.js";
import { findByNameInsensitive } from "../../utils/common/duplicateNameUtils.js";
import { cascadeDisableCombos } from "../../utils/menu/cascadeUtils.js";
import { CATEGORIES_WITHOUT_SUBCATEGORY } from "../../utils/saucers/saucerCategoriesUtils.js";

// Objeto para agrupar todas las funciones de los platillos
const saucersController = {};

// Busca si ya existe un platillo con ese nombre (sugerencia, no bloqueo)
saucersController.checkName = async (req, res) => {
  try {
    const existing = await findByNameInsensitive(SaucersModel, req.query.name);
    return res.status(200).json({ existing: existing || null });
  } catch (error) {
    console.error("saucersController.checkName:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// La receta llega como FormData, así que viaja como string JSON
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

// Obtiene todos los platillos sin importar su estado
saucersController.getAllSaucers = async (req, res) => {
  try {
    const saucers = await SaucersModel.find().sort({ createdAt: -1 });
    return res.status(200).json(saucers);
  } catch (error) {
    console.error("saucersController.getAllSaucers:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Obtiene solo los platillos que están activos (disponibles para venta)
saucersController.getActiveSaucers = async (req, res) => {
  try {
    const saucers = await SaucersModel.find({ status: "Activo" });

    return res.status(200).json(saucers);
  } catch (error) {
    console.error("saucersController.getActiveSaucers:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Ranking de platillos más vendidos. Los platillos no están referenciados
// directo en el carrito (solo a través de los combos que los incluyen), así
// que hace falta un doble $lookup: carrito -> combo -> platillo.
saucersController.getBestSellers = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;

    const ranking = await CartModel.aggregate([
      { $unwind: "$details" },
      { $unwind: "$details.combos" },
      {
        $lookup: {
          from: "combos",
          localField: "details.combos.comboId",
          foreignField: "_id",
          as: "combo",
        },
      },
      { $unwind: "$combo" },
      { $unwind: "$combo.saucers" },
      {
        $group: {
          _id: "$combo.saucers.saucerId",
          totalSold: { $sum: "$details.combos.quantity" },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "saucers",
          localField: "_id",
          foreignField: "_id",
          as: "saucer",
        },
      },
      { $unwind: "$saucer" },
      { $project: { _id: 0, saucer: 1, totalSold: 1 } },
    ]);

    return res.status(200).json(ranking);
  } catch (error) {
    console.error("saucersController.getBestSellers:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Crea un nuevo platillo en el menú (imagen y receta opcionales)
saucersController.insertSaucer = async (req, res) => {
  try {
    const { name, category, price, status, description, subcategory, quantity } = req.body;
    const recipe = parseRecipe(req.body.recipe);
    const taco = category === "Tacos";

    let validation = validationsSaucers.validateName(name);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateCategory(category);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validatePrice(price);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateTacoQuantity(category, quantity);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateRecipe(recipe);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    // Nace 'Activo' por default: el admin no crea algo pensado para estar deshabilitado
    const finalStatus = status || "Activo";
    validation = validationsSaucers.validateStatus(finalStatus);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    const subcategoryApplies = !CATEGORIES_WITHOUT_SUBCATEGORY.includes(category);

    const newSaucer = new SaucersModel({
      name,
      category,
      description: description || "",
      subcategory: subcategoryApplies ? (subcategory || "") : "",
      quantity: taco ? Number(quantity) : null,
      price,
      status: finalStatus,
      recipe,
      ...(req.file ? { image: req.file.path, publicId: req.file.filename } : {}),
    });

    await newSaucer.save();

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "created",
      title: "Platillo agregado",
      message: (actor) =>
        `${actor.name} agregó el platillo ${newSaucer.name} al menú ($${Number(newSaucer.price).toFixed(2)})`,
      icon: "utensils",
      severity: "success",
      entity: { model: "Saucers", id: newSaucer._id, label: newSaucer.name },
    });

    return res.status(200).json({title: "Platillo agregado", message: "El platillo se guardó correctamente.",});
  } catch (error) {
    console.error("saucersController.insertSaucer:", error);
    return res.status(500).json({title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde."});
  }
};

// Elimina un platillo del menú y borra la imagen asociada de Cloudinary
saucersController.deleteSaucer = async (req, res) => {
  try {
    const saucerFound = await SaucersModel.findById(req.params.id);
    if (!saucerFound) {
      return res.status(404).json({ title: "Platillo no encontrado", message: "No se encontró el platillo solicitado." });
    }

    // Solo intenta borrar la imagen si existe publicId
    if (saucerFound.publicId) {
      await cloudinary.uploader.destroy(saucerFound.publicId);
    }

    await SaucersModel.findByIdAndDelete(req.params.id);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "deleted",
      title: "Platillo eliminado",
      message: (actor) => `${actor.name} eliminó el platillo ${saucerFound.name} del menú`,
      icon: "trash",
      severity: "danger",
      entity: { model: "Saucers", id: saucerFound._id, label: saucerFound.name },
    });

    return res.status(200).json({ title: "Platillo eliminado", message: "El platillo se eliminó correctamente." });
  } catch (error) {
    console.error("saucersController.deleteSaucer:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Actualiza un platillo (nombre, categoría, precio, estado, receta y/o imagen)
saucersController.updateSaucer = async (req, res) => {
  try {
    const { name, category, price, status, description, subcategory, quantity } = req.body;
    const recipe = parseRecipe(req.body.recipe);
    const taco = category === "Tacos";

    let validation = validationsSaucers.validateName(name);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateCategory(category);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validatePrice(price);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateTacoQuantity(category, quantity);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateRecipe(recipe);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    validation = validationsSaucers.validateStatus(status);
    if (!validation.valid) {
      return res.status(400).json({message: validation.message,});
    }

    const saucerFound = await SaucersModel.findById(req.params.id);

    const subcategoryApplies = !CATEGORIES_WITHOUT_SUBCATEGORY.includes(category);

    const updatedData = {
      name,
      category,
      description: description || "",
      subcategory: subcategoryApplies ? (subcategory || "") : "",
      quantity: taco ? Number(quantity) : null,
      price,
      status,
      recipe,
    };

    // Si hay una nueva imagen, borramos la antigua y registramos la nueva
    if (req.file) {
      if (saucerFound?.publicId) {
        await cloudinary.uploader.destroy(saucerFound.publicId);
      }

      updatedData.image = req.file.path;
      updatedData.publicId = req.file.filename;
    }

    await SaucersModel.findByIdAndUpdate(req.params.id, updatedData, {
      new: true,
    });

    // Reportamos explícitamente el cambio de precio, que es lo más sensible del menú
    const priceChanged = Number(saucerFound?.price) !== Number(price);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "updated",
      title: "Platillo actualizado",
      message: (actor) =>
        priceChanged
          ? `${actor.name} cambió el precio de ${name}: de $${Number(saucerFound?.price || 0).toFixed(2)} a $${Number(price).toFixed(2)}`
          : `${actor.name} actualizó el platillo ${name}`,
      icon: "utensils",
      severity: "info",
      entity: { model: "Saucers", id: req.params.id, label: name },
    });

    if (status !== "Activo") {
      await cascadeDisableCombos(req, req.params.id, name);
    }

    return res.status(200).json({title: "Platillo actualizado", message: "El platillo se actualizó correctamente.",});
  } catch (error) {
    console.error("saucersController.updateSaucer:", error);
    return res.status(500).json({title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde.",});
  }
};

export default saucersController;
