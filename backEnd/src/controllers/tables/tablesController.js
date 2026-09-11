const tablesController = {};

// Importamos el modelo de las mesas para interactuar con la base de datos
import TablesModel from "../../models/tables/tablesModel.js";
import Order from "../../models/orders/orderModel.js";
// Utilidad para registrar los movimientos como notificaciones del sistema
import notificationUtils from "../../utils/notifications/notificationUtils.js";
// Tiempo real: el panel de mesas se actualiza solo cuando una mesa se ocupa,
// se desocupa o pasa a limpieza, sin recargar ni sondear cada 30 segundos.
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";

// Quiénes ven los cambios de mesas en vivo. Es el mismo público que ya define
// notificationUtils para la categoría "tables", reutilizado a propósito para
// no tener dos criterios distintos de "quién puede ver qué".
const TABLES_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.tables;
const ORDERS_AUDIENCE = notificationUtils.AUDIENCE_BY_CATEGORY.orders;

// Liberar u ordenar la limpieza de una mesa cancela sus comandas activas.
// Ese cambio ocurre en la colección de pedidos, no en la de mesas, así que
// hay que avisarlo por el canal de órdenes: si no, la pantalla de pedidos
// seguiría mostrando comandas de una mesa que ya se desocupó.
const emitCancelledOrdersOfTables = async (tableIds) => {
  if (!tableIds || tableIds.length === 0) return;

  const cancelledOrders = await Order.find({
    table: { $in: tableIds },
    status: 'cancelled',
  })
    .populate('table', 'number status')
    .populate('waiter', 'name lastname')
    .populate('customer', 'personalInfo');

  for (const order of cancelledOrders) {
    emitToRoles(ORDERS_AUDIENCE, SOCKET_EVENTS.ORDER_UPDATED, { order: order.toObject() });
  }
};

// Obtiene todas las mesas registradas en el restaurante
tablesController.getTables = async (req, res) => {
  try {
    const tables = await TablesModel.find();
    return res.status(200).json(tables);
  } catch (error) {
    console.error("tablesController.getTables:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Crea o registra una nueva mesa en el sistema
tablesController.insertTable = async (req, res) => {
  try {
    let { number, status } = req.body;

    
    // Preparamos la nueva mesa para guardarla
    const newTable = new TablesModel({
      number,
      status,
    });

    // Guardamos la mesa en la base de datos
    await newTable.save();

    await notificationUtils.createNotification({
      req,
      category: "tables",
      action: "created",
      title: "Nueva mesa",
      message: (actor) => `${actor.name} habilitó la Mesa ${newTable.number}`,
      icon: "chair",
      severity: "success",
      entity: { model: "Tables", id: newTable._id, label: `Mesa ${newTable.number}` },
    });

    emitToRoles(TABLES_AUDIENCE, SOCKET_EVENTS.TABLE_CREATED, { table: newTable.toObject() });

    return res.status(201).json({ title: "Mesa agregada", message: "La mesa se guardó correctamente." });
  } catch (error) {
    console.error("tablesController.insertTable:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Elimina una mesa existente usando su ID
tablesController.deleteTable = async (req, res) => {
  try {
    const deletedTable = await TablesModel.findByIdAndDelete(req.params.id);

    // Si no encuentra la mesa, devuelve un error 404 (No encontrado)
    if (!deletedTable) {
      return res.status(404).json({ title: "Mesa no encontrada", message: "No se encontró la mesa solicitada." });
    }

    await notificationUtils.createNotification({
      req,
      category: "tables",
      action: "deleted",
      title: "Mesa eliminada",
      message: (actor) => `${actor.name} eliminó la Mesa ${deletedTable.number}`,
      icon: "trash",
      severity: "danger",
      entity: { model: "Tables", id: deletedTable._id, label: `Mesa ${deletedTable.number}` },
    });

    emitToRoles(TABLES_AUDIENCE, SOCKET_EVENTS.TABLE_DELETED, { tableId: String(deletedTable._id) });

    return res.status(200).json({ title: "Mesa eliminada", message: "La mesa se eliminó correctamente." });
  } catch (error) {
    console.error("tablesController.deleteTable:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Actualiza los datos de una mesa (por ejemplo, para cambiarla de libre a ocupada)
tablesController.updateTable = async (req, res) => {
  try {
    const { number, status } = req.body;

    // Validar que el estado sea uno de los permitidos
    const validStatuses = ['libre', 'ocupada', 'limpieza', 'reservada'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ message: "Estado no válido" });
    }

    const previousTable = await TablesModel.findById(req.params.id).select("status");
    if (!previousTable) {
      return res.status(404).json({ message: "Mesa no encontrada" });
    }

    const tableUpdated = await TablesModel.findByIdAndUpdate(
      req.params.id,
      { number, status },
      { new: true }
    );

    // Si la mesa pasa a 'libre' o 'limpieza', cancelar todas las órdenes activas
    if (status && ['libre', 'limpieza'].includes(status) && previousTable.status !== status) {
      await Order.updateMany(
        { table: tableUpdated._id, status: { $in: ['pending', 'preparing', 'ready'] } },
        { $set: { status: 'cancelled' } }
      );

      await emitCancelledOrdersOfTables([tableUpdated._id]);
    }

    // Notificación (tu lógica existente)
    await notificationUtils.createNotification({
      req,
      category: "tables",
      action: status && previousTable.status !== status ? "status_changed" : "updated",
      title: status ? "Mesa cambió de estado" : "Mesa actualizada",
      message: (actor) =>
        status
          ? `${actor.name} cambió la Mesa ${tableUpdated.number} a ${tableUpdated.status}`
          : `${actor.name} actualizó los datos de la Mesa ${tableUpdated.number}`,
      icon: "chair",
      severity: "info",
      entity: { model: "Tables", id: tableUpdated._id, label: `Mesa ${tableUpdated.number}` },
    });

    // Mandamos la mesa completa para que el frontend reemplace solo ese
    // registro en su lista, sin volver a pedir todas las mesas.
    emitToRoles(TABLES_AUDIENCE, SOCKET_EVENTS.TABLE_UPDATED, { table: tableUpdated.toObject() });

    return res.status(200).json({ message: "Mesa actualizada", data: tableUpdated });
  } catch (error) {
    console.error("tablesController.updateTable:", error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
};

// Pone el mismo estado a TODAS las mesas de una vez (ej. "poner disponibles
// todas las mesas" al abrir el local). Igual que updateTable, si el nuevo
// estado es 'libre' o 'limpieza' se cancelan los pedidos activos de las
// mesas que estaban ocupadas, para no dejar comandas huérfanas.
tablesController.bulkUpdateStatus = async (req, res) => {
  try {
    const { status } = req.body;

    const validStatuses = ['libre', 'ocupada', 'limpieza', 'reservada'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ title: "Estado inválido", message: "El estado no es válido." });
    }

    const tables = await TablesModel.find().select("_id status");
    if (tables.length === 0) {
      return res.status(200).json({ title: "Sin mesas", message: "No hay mesas registradas.", data: { updated: 0 } });
    }

    if (['libre', 'limpieza'].includes(status)) {
      const tableIdsChanging = tables.filter((t) => t.status !== status).map((t) => t._id);
      if (tableIdsChanging.length > 0) {
        await Order.updateMany(
          { table: { $in: tableIdsChanging }, status: { $in: ['pending', 'preparing', 'ready'] } },
          { $set: { status: 'cancelled' } }
        );

        await emitCancelledOrdersOfTables(tableIdsChanging);
      }
    }

    await TablesModel.updateMany({}, { $set: { status } });

    await notificationUtils.createNotification({
      req,
      category: "tables",
      action: "status_changed",
      title: "Todas las mesas actualizadas",
      message: (actor) => `${actor.name} puso todas las mesas en estado "${status}"`,
      icon: "chair",
      severity: "info",
      entity: { model: "Tables", id: null, label: "Todas las mesas" },
    });

    // En el cambio masivo sí conviene que el frontend recargue: cambiaron
    // todas las mesas y, posiblemente, muchas comandas a la vez.
    emitToRoles(TABLES_AUDIENCE, SOCKET_EVENTS.TABLES_BULK_UPDATED, { status });

    return res.status(200).json({ title: "Mesas actualizadas", message: "Se actualizó el estado de todas las mesas.", data: { updated: tables.length } });
  } catch (error) {
    console.error("tablesController.bulkUpdateStatus:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default tablesController;