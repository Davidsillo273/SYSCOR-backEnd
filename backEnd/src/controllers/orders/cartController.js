// Importamos los modelos de los carritos y de los productos (combos, bebidas, extras) para calcular precios
import CartModel from "../../models/orders/cartModel.js";
import CombosModel from "../../models/menu/combosModel.js";
import DrinksModel from "../../models/menu/drinksModel.js";
import ExtrasModel from "../../models/menu/extrasModel.js";
import TablesModel from "../../models/tables/tablesModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import { deductRecipe } from "../../utils/inventory/deductionUtils.js";

const cartController = {};

// Descuenta del inventario todo lo que trae la orden: los platillos de cada
// combo (vía su receta) y los ingredientes de cada extra pedido. Solo se
// descuentan los ingredientes con tracked:true/inventoryId (los "solo receta"
// como el agua se saltan). Nunca cancela la orden: junta lo que no alcanzó
// para que el llamador decida cómo avisarlo.
const deductOrderInventory = async (req, cart) => {
  const insufficient = [];

  for (const detail of cart.details || []) {
    for (const comboItem of detail.combos || []) {
      const combo = await CombosModel.findById(comboItem.comboId).populate("saucers.saucerId");
      if (!combo) continue;

      for (const saucerEntry of combo.saucers || []) {
        const saucer = saucerEntry.saucerId;
        if (!saucer?.recipe?.length) continue;

        const { insufficient: missing } = await deductRecipe({
          req,
          recipe: saucer.recipe,
          multiplier: comboItem.quantity || 1,
          origin: "order",
          originId: cart._id,
        });
        insufficient.push(...missing.map((m) => ({ ...m, from: saucer.name })));
      }
    }

    for (const extraItem of detail.extras || []) {
      const extra = await ExtrasModel.findById(extraItem.extraId);
      if (!extra?.ingredients?.length) continue;

      // Normalizamos al shape que espera deductRecipe: los ingredientes de un
      // extra siempre están ligados a un insumo real (no hay "solo receta" aquí)
      const normalizedRecipe = extra.ingredients.map((ing) => ({
        tracked: true,
        inventoryId: ing.ingredientId,
        quantity: ing.quantity,
        unit: ing.unit,
        name: extra.name,
      }));

      const { insufficient: missing } = await deductRecipe({
        req,
        recipe: normalizedRecipe,
        multiplier: extraItem.quantity || 1,
        origin: "extra",
        originId: extraItem.extraId,
      });
      insufficient.push(...missing.map((m) => ({ ...m, from: extra.name })));
    }
  }

  return insufficient;
};

// Traducciones de los estados del pedido para redactar las notificaciones en español
const STATUS_LABELS = {
  pending: "PENDIENTE",
  cooking: "PREPARANDO",
  ready: "LISTO",
  delivered: "ENTREGADO",
  paid: "PAGADO",
};

// Arma un identificador corto y legible del pedido, igual al que muestra el panel (#A3F2)
const buildOrderCode = (cartId) => `#${(cartId || "").toString().slice(-4).toUpperCase()}`;

// Busca el número de la mesa para poder decir "Mesa 5" en vez de mostrar un id
const buildTableLabel = async (tableId) => {
  if (!tableId) return null;
  try {
    const table = await TablesModel.findById(tableId).select("number");
    return table?.number ? `Mesa ${table.number}` : null;
  } catch (error) {
    return null;
  }
};

// Busca el nombre del cliente dueño del pedido, para los pedidos hechos en línea
const buildCustomerName = async (customerId) => {
  if (!customerId) return "un cliente";
  try {
    const customer = await CustomerModel.findById(customerId).select("personalInfo");
    const name = `${customer?.personalInfo?.name || ""} ${customer?.personalInfo?.lastname || ""}`.trim();
    return name || "un cliente";
  } catch (error) {
    return "un cliente";
  }
};

// Obtiene todos los carritos registrados y expande los detalles del cliente y productos
cartController.getAllCarts = async (req, res) => {
  try {
    const carts = await CartModel
      .find()
      .populate("customerId", "personalInfo loginInfo.email")
      .populate("table", "number status")
      .populate("details.combos.comboId", "name price")
      .populate("details.extras.extraId", "name price")
      .populate("details.extras.drinks.drinkId", "name price");
    return res.status(200).json(carts);
  } catch (error) {
    console.error("cartController.getAllCarts:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};


// Obtiene un carrito específico por su ID, mostrando toda su información detallada
cartController.getCartById = async (req, res) => {
  try {
    const cart = await CartModel
      .findById(req.params.id)
      .populate("customerId", "personalInfo loginInfo.email")
      .populate("table", "number status")
      .populate("details.combos.comboId", "name price")
      .populate("details.extras.extraId", "name price")
      .populate("details.extras.drinks.drinkId", "name price");

    if (!cart) return res.status(404).json({ title: "Carrito no encontrado", message: "No se encontró el carrito solicitado." });

    return res.status(200).json(cart);
  } catch (error) {
    console.error("cartController.getCartById:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};


// Registra un nuevo carrito, calculando matemáticamente los subtotales y el total general de los productos
cartController.insertCart = async (req, res) => {
  try {
    const { customerId, table, details, status } = req.body;

    let totalGeneral = 0;
    let processedDetails = [];

    for (let detail of details) {
      let subTotalDetail = 0;


      if (detail.combos && detail.combos.length > 0) {
        for (let comboItem of detail.combos) {
          const comboFound = await CombosModel.findById(comboItem.comboId);
          if (comboFound) {
            subTotalDetail += comboFound.price * (comboItem.quantity || 1);
          }
        }
      }


      if (detail.extras && detail.extras.length > 0) {
        for (let extraItem of detail.extras) {
          let totalExtraItem = 0;


          const extraFound = await ExtrasModel.findById(extraItem.extraId);
          if (extraFound) {
            totalExtraItem += extraFound.price;
          }


          if (extraItem.drinks && extraItem.drinks.length > 0) {
            for (let drinkItem of extraItem.drinks) {
              const drinkFound = await DrinksModel.findById(drinkItem.drinkId);
              if (drinkFound) {
                totalExtraItem += drinkFound.price;
              }
            }
          }

          subTotalDetail += totalExtraItem * (extraItem.quantity || 1);
        }
      }


      totalGeneral += subTotalDetail;

      let detailObject = {
        combos: detail.combos || [],
        subTotal: subTotalDetail
      };

      if (detail.extras) {
        detailObject.extras = detail.extras;
      }

      processedDetails.push(detailObject);
    }

    const newCart = new CartModel({
      customerId,
      table: table || null,
      details: processedDetails,
      total: totalGeneral,
      status,
      statusHistory: [{ status: status || 'pending', changedAt: new Date() }]
    });

    await newCart.save();

    // Avisamos del nuevo pedido. Si vino de alguien con sesión (mesero, cajero)
    // se menciona a esa persona; si no, se trata como un pedido hecho en línea.
    const tableLabel = await buildTableLabel(newCart.table);
    const customerName = await buildCustomerName(newCart.customerId);
    const orderCode = buildOrderCode(newCart._id);
    const totalLabel = `$${(newCart.total || 0).toFixed(2)}`;

    await notificationUtils.createNotification({
      req,
      category: "orders",
      action: "created",
      title: "Nueva orden",
      message: (actor) =>
        actor.role === "admin" || actor.role === "employee"
          ? `${actor.name} creó una nueva orden ${orderCode} en la ${tableLabel || "barra"} por ${totalLabel}`
          : `Nuevo pedido en línea ${orderCode} de ${customerName} por ${totalLabel}`,
      icon: "receipt",
      severity: "success",
      entity: { model: "Cart", id: newCart._id, label: orderCode },
    });

    return res.status(201).json({ title: "Carrito creado", message: "El carrito se guardó correctamente.", data: newCart });
  } catch (error) {
    console.error("cartController.insertCart:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};


// Actualiza un carrito (por ejemplo, si agregaron más productos), recalculando el total desde cero
cartController.updateCart = async (req, res) => {
  try {
    const { customerId, table, details, status } = req.body;

    const updateData = {};
    if (customerId !== undefined) updateData.customerId = customerId;
    if (table !== undefined) updateData.table = table;
    if (status !== undefined) updateData.status = status;

    // Solo recalculamos details/total cuando el cliente manda details
    // (ej. useOrders.updateOrderStatus solo manda { status } para mover el pedido de pestaña)
    if (details !== undefined) {
      let totalGeneral = 0;
      let processedDetails = [];

      for (let detail of details) {
        let subTotalDetail = 0;

        if (detail.combos && detail.combos.length > 0) {
          for (let comboItem of detail.combos) {
            const comboFound = await CombosModel.findById(comboItem.comboId);
            if (comboFound) {
              subTotalDetail += comboFound.price * (comboItem.quantity || 1);
            }
          }
        }

        if (detail.extras && detail.extras.length > 0) {
          for (let extraItem of detail.extras) {
            let totalExtraItem = 0;

            const extraFound = await ExtrasModel.findById(extraItem.extraId);
            if (extraFound) {
              totalExtraItem += extraFound.price;
            }

            if (extraItem.drinks && extraItem.drinks.length > 0) {
              for (let drinkItem of extraItem.drinks) {
                const drinkFound = await DrinksModel.findById(drinkItem.drinkId);
                if (drinkFound) {
                  totalExtraItem += drinkFound.price;
                }
              }
            }

            subTotalDetail += totalExtraItem * (extraItem.quantity || 1);
          }
        }

        totalGeneral += subTotalDetail;

        let detailObject = {
          combos: detail.combos || [],
          subTotal: subTotalDetail
        };

        if (detail.extras) {
          detailObject.extras = detail.extras;
        }

        processedDetails.push(detailObject);
      }

      updateData.details = processedDetails;
      updateData.total = totalGeneral;
    }

    // Guardamos el estado anterior para poder detectar si el pedido cambió de fase
    const previousCart = await CartModel.findById(req.params.id).select("status table inventoryDeducted");

    // Cuando el estado cambia, dejamos rastro en statusHistory para poder calcular
    // después el tiempo promedio de preparación (cooking -> ready) y el tráfico por hora
    const mongoUpdate = { $set: updateData };
    // Reenviar "cooking" sobre un pedido que ya se cocinaba reinicia su tiempo
    // en preparación (acción "Continuar" de cocina sobre una comanda retrasada).
    const restartsCooking = status === 'cooking' && previousCart?.status === 'cooking';
    if (status !== undefined && (previousCart?.status !== status || restartsCooking)) {
      mongoUpdate.$push = { statusHistory: { status, changedAt: new Date() } };
    }

    const updatedCart = await CartModel.findByIdAndUpdate(
      req.params.id,
      mongoUpdate,
      { new: true }
    );

    if (!updatedCart) return res.status(404).json({ title: "Carrito no encontrado", message: "No se encontró el carrito solicitado." });

    const orderCode = buildOrderCode(updatedCart._id);
    const statusChanged = status !== undefined && previousCart?.status !== status;

    // Cocina confirma que empieza a preparar la orden: aquí se descuenta el
    // inventario, y solo aquí (inventoryDeducted evita que un vaivén de
    // estados cooking->ready->cooking lo haga dos veces)
    let insufficientIngredients = [];
    if (statusChanged && status === "cooking" && !previousCart?.inventoryDeducted) {
      insufficientIngredients = await deductOrderInventory(req, updatedCart);
      await CartModel.findByIdAndUpdate(req.params.id, { inventoryDeducted: true });

      if (insufficientIngredients.length > 0) {
        const names = [...new Set(insufficientIngredients.map((i) => i.name || i.from))].join(", ");
        await notificationUtils.createNotification({
          req,
          category: "inventory",
          action: "insufficient_stock",
          title: "Stock insuficiente al preparar una orden",
          message: `La orden ${orderCode} necesitó más stock del disponible: ${names}. Revisa y reabastece.`,
          icon: "triangle-exclamation",
          severity: "warning",
          entity: { model: "Cart", id: updatedCart._id, label: orderCode },
        });
      }
    }

    if (statusChanged) {
      // El cambio de estado es el movimiento más interesante para la cocina y el salón
      const statusLabel = STATUS_LABELS[status] || (status || "").toUpperCase();

      await notificationUtils.createNotification({
        req,
        category: "orders",
        action: "status_changed",
        title: "Orden actualizada",
        message: (actor) =>
          actor.role === "admin" || actor.role === "employee"
            ? `${actor.name} marcó la orden ${orderCode} como ${statusLabel}`
            : `La orden ${orderCode} pasó a ${statusLabel}`,
        icon: "circle-check",
        severity: status === "delivered" || status === "paid" ? "success" : "info",
        entity: { model: "Cart", id: updatedCart._id, label: orderCode },
      });
    } else {
      const tableLabel = await buildTableLabel(updatedCart.table);

      await notificationUtils.createNotification({
        req,
        category: "orders",
        action: "updated",
        title: "Orden modificada",
        message: (actor) =>
          `${actor.name} modificó la orden ${orderCode}${tableLabel ? ` de la ${tableLabel}` : ""}`,
        icon: "pen-to-square",
        severity: "info",
        entity: { model: "Cart", id: updatedCart._id, label: orderCode },
      });
    }

    return res.status(200).json({
      title: "Carrito actualizado", message: "El carrito se actualizó correctamente.",
      data: updatedCart,
      insufficientIngredients,
    });
  } catch (error) {
    console.error("cartController.updateCart:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Elimina un carrito de compras usando su ID
cartController.deleteCart = async (req, res) => {
  try {
    const cart = await CartModel.findByIdAndDelete(req.params.id);
    if (!cart) {
      return res.status(404).json({ title: "Carrito no encontrado", message: "No se encontró el carrito solicitado." });
    }

    const orderCode = buildOrderCode(cart._id);
    const tableLabel = await buildTableLabel(cart.table);

    await notificationUtils.createNotification({
      req,
      category: "orders",
      action: "deleted",
      title: "Orden cancelada",
      message: (actor) =>
        `${actor.name} canceló la orden ${orderCode}${tableLabel ? ` de la ${tableLabel}` : ""}`,
      icon: "trash",
      severity: "danger",
      entity: { model: "Cart", id: cart._id, label: orderCode },
    });

    return res.status(200).json({ title: "Carrito eliminado", message: "El carrito se eliminó correctamente." });
  } catch (error) {
    console.error("cartController.deleteCart:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default cartController;