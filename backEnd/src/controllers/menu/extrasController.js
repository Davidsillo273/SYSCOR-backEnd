const extrasController = {};

// Importamos el modelo de los extras (complementos, ej. "guacamole extra") y sus validaciones
import ExtrasModel from "../../models/menu/extrasModel.js";
import validationsExtras from "../../utils/extras/validationsExtrasUtils.js";
import { v2 as cloudinary } from "cloudinary";
// Utilidad para registrar los movimientos del menú como notificaciones
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import CartModel from "../../models/orders/cartModel.js";
import { findByNameInsensitive } from "../../utils/common/duplicateNameUtils.js";
import { parseAppliesTo } from "../../utils/extras/extraTargetsUtils.js";

// Busca si ya existe un extra con ese nombre (sugerencia, no bloqueo)
extrasController.checkName = async (req, res) => {
  try {
    const existing = await findByNameInsensitive(ExtrasModel, req.query.name);
    return res.status(200).json({ existing: existing || null });
  } catch (error) {
    console.log("error" + error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Los ingredientes (usados solo cuando isCompound es true) llegan como
// FormData, así que viajan como string JSON
const parseIngredients = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Obtiene todos los complementos (extras) del menú, sin importar su estado
extrasController.getExtras = async (req, res) => {
  try {
    const extras = await ExtrasModel.find().sort({ createdAt: -1 }).populate("ingredients.ingredientId", "name unit");
    return res.status(200).json(extras);
  } catch (error) {
    console.log("error" + error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Obtiene solo los complementos que están activos (disponibles para venta)
extrasController.getActiveExtras = async (req, res) => {
  try {
    const extras = await ExtrasModel.find({ status: "DISPONIBLE" });
    return res.status(200).json(extras);
  } catch (error) {
    console.error("extrasController.getActiveExtras:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Ranking de extras más pedidos, contando cuántas unidades se han pedido
// en todos los carritos registrados
extrasController.getBestSellers = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;

    const ranking = await CartModel.aggregate([
      { $unwind: "$details" },
      { $unwind: "$details.extras" },
      {
        $group: {
          _id: "$details.extras.extraId",
          totalSold: { $sum: "$details.extras.quantity" },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "extras",
          localField: "_id",
          foreignField: "_id",
          as: "extra",
        },
      },
      { $unwind: "$extra" },
      { $project: { _id: 0, extra: 1, totalSold: 1 } },
    ]);

    return res.status(200).json(ranking);
  } catch (error) {
    console.error("extrasController.getBestSellers:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Crea un nuevo complemento en el menú
extrasController.insertExtras = async (req, res) => {
  try {
    let { name, price, status, category, isCompound } = req.body;
    const ingredients = parseIngredients(req.body.ingredients);
    const compound = isCompound === true || isCompound === "true";

    // Validamos que el nombre, precio y estado tengan el formato correcto
    let validation = validationsExtras.validateName(name);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    validation = validationsExtras.validatePrice(price);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    validation = validationsExtras.validateStatus(status);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    validation = validationsExtras.validateImage(req.file);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    // Si es compuesto (depende de insumos, ej. guacamole = aguacate + limón +
    // sal), exige al menos un ingrediente; si no, no aplica esta regla
    validation = validationsExtras.validateIngredients(ingredients, compound);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    // Creamos el nuevo complemento (imagen e ingredientes de inventario opcionales)
    const newExtra = new ExtrasModel({
      name,
      price,
      category,
      // A qué tipos de platillo se le puede agregar (ver extraTargetsUtils)
      appliesTo: parseAppliesTo(req.body.appliesTo),
      status,
      isCompound: compound,
      ingredients: compound ? ingredients : [],
      ...(req.file ? { image: req.file.path, publicId: req.file.filename } : {}),
    });

    // Guardamos en la base de datos
    await newExtra.save();

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "created",
      title: "Extra agregado",
      message: (actor) =>
        `${actor.name} agregó el extra ${newExtra.name} al menú ($${Number(newExtra.price).toFixed(2)})`,
      icon: "star",
      severity: "success",
      entity: { model: "Extras", id: newExtra._id, label: newExtra.name },
    });

    return res.status(201).json({ title: "Extra agregado", message: "El extra se guardó correctamente." });
  } catch (error) {
    console.log("error" + error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Elimina un complemento del menú
extrasController.deleteExtra = async (req, res) => {
  try {
    const extraFound = await ExtrasModel.findById(req.params.id);
    if (!extraFound) {
      return res.status(404).json({ title: "Extra no encontrado", message: "No se encontró el extra solicitado." });
    }

    if (extraFound.publicId) {
      await cloudinary.uploader.destroy(extraFound.publicId);
    }

    const deletedExtra = await ExtrasModel.findByIdAndDelete(req.params.id);

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "deleted",
      title: "Extra eliminado",
      message: (actor) => `${actor.name} eliminó el extra ${deletedExtra.name} del menú`,
      icon: "trash",
      severity: "danger",
      entity: { model: "Extras", id: deletedExtra._id, label: deletedExtra.name },
    });

    return res.status(200).json({ title: "Extra eliminado", message: "El extra se eliminó correctamente." });
  } catch (error) {
    console.log("error" + error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Actualiza un complemento existente (por ejemplo, cambiarle el precio)
extrasController.updateExtra = async (req, res) => {
  try {
    let { name, price, status, category, isCompound } = req.body;
    const ingredients = parseIngredients(req.body.ingredients);
    const compound = isCompound === true || isCompound === "true";

    // Validamos los datos nuevos
    let validation = validationsExtras.validateName(name);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    validation = validationsExtras.validatePrice(price);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    validation = validationsExtras.validateStatus(status);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    validation = validationsExtras.validateIngredients(ingredients, compound);
    if (!validation.valid) return res.status(400).json({message: validation.message});

    const extraFound = await ExtrasModel.findById(req.params.id);
    if (!extraFound) {
      return res.status(404).json({ title: "Extra no encontrado", message: "No se encontró el extra solicitado." });
    }

    const updatedData = { name, price, category, status, isCompound: compound, ingredients: compound ? ingredients : [] };
    // Solo se toca si viene en la petición: quien edite el extra sin conocer
    // este campo (p. ej. el asistente del panel) no lo borra.
    if (req.body.appliesTo !== undefined) updatedData.appliesTo = parseAppliesTo(req.body.appliesTo);

    // Si hay una nueva imagen, borramos la antigua y registramos la nueva
    if (req.file) {
      if (extraFound.publicId) {
        await cloudinary.uploader.destroy(extraFound.publicId);
      }
      updatedData.image = req.file.path;
      updatedData.publicId = req.file.filename;
    }

    // Buscamos y actualizamos el complemento
    const extraUpdated = await ExtrasModel.findByIdAndUpdate(
      req.params.id,
      updatedData,
      { new: true } // Para que nos devuelva el objeto ya actualizado
    );

    await notificationUtils.createNotification({
      req,
      category: "menu",
      action: "updated",
      title: "Extra actualizado",
      message: (actor) =>
        `${actor.name} actualizó el extra ${extraUpdated.name} ($${Number(extraUpdated.price).toFixed(2)})`,
      icon: "star",
      severity: "info",
      entity: { model: "Extras", id: extraUpdated._id, label: extraUpdated.name },
    });

    return res.status(200).json({ title: "Extra actualizado", message: "El extra se actualizó correctamente." });
  } catch (error) {
    console.log("error found" + error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default extrasController;