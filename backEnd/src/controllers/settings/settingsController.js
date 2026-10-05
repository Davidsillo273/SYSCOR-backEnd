// Importamos la utilidad que obtiene (o crea) el documento único de ajustes
// y la utilidad de notificaciones para avisar cuando la configuración cambia
import settingsUtils from "../../utils/settings/settingsUtils.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
// Sistema de Cocina: las pantallas se enteran al instante de sus tiempos
import { emitToRoles, SOCKET_EVENTS } from "../../config/socket.js";

const settingsController = {};

// Límites de los tiempos de alerta de los tickets de cocina (en minutos)
const KITCHEN_MINUTES_RANGE = { min: 1, max: 180 };

// Devuelve la configuración actual del sistema.
// Si todavía no existe, se crea con los valores por defecto.
settingsController.getSettings = async (req, res) => {
  try {
    const settings = await settingsUtils.getOrCreateSettings();
    return res.status(200).json(settings);
  } catch (error) {
    console.error("settingsController.getSettings:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

// Actualiza la configuración. Solo llegan aquí los administradores.
// Se aceptan cambios parciales: lo que no venga en el body se queda como estaba.
settingsController.updateSettings = async (req, res) => {
  try {
    const { operation, notifications, kitchen } = req.body;
    const settings = await settingsUtils.getOrCreateSettings();

    // Si cambiaron los tiempos de cocina, se avisa a las pantallas al final
    let kitchenChanged = false;

    if (operation) {
      const { lowStockThresholds, autoRefreshDashboard, dashboardRefreshSeconds } = operation;

      if (lowStockThresholds) {
        // Cada sección tiene su propio umbral; solo se tocan las que vengan en el body.
        // "inventory" no está aquí: desde que el umbral es obligatorio por insumo, ya
        // no existe un umbral general configurable para esa sección.
        const sections = ["drinks", "saucers", "extras", "combos"];
        for (const section of sections) {
          if (lowStockThresholds[section] !== undefined) {
            const threshold = Number(lowStockThresholds[section]);
            if (isNaN(threshold) || threshold < 0) {
              return res.status(400).json({ title: "Umbral inválido", message: `El umbral de stock bajo para ${section} debe ser un número positivo.` });
            }
            settings.operation.lowStockThresholds[section] = threshold;
          }
        }
      }

      if (autoRefreshDashboard !== undefined) {
        settings.operation.autoRefreshDashboard = Boolean(autoRefreshDashboard);
      }

      if (dashboardRefreshSeconds !== undefined) {
        const seconds = Number(dashboardRefreshSeconds);
        // Menos de 10 segundos saturaría el servidor con recargas innecesarias
        if (isNaN(seconds) || seconds < 10) {
          return res.status(400).json({ title: "Intervalo inválido", message: "El intervalo de actualización debe ser de al menos 10 segundos." });
        }
        settings.operation.dashboardRefreshSeconds = seconds;
      }
    }

    if (notifications) {
      // Recorremos solo las categorías que existen en el schema para que nadie
      // pueda inyectar llaves nuevas desde el frontend
      const categories = ["orders", "staff", "inventory", "tables", "menu", "clients"];
      for (const category of categories) {
        if (notifications[category] !== undefined) {
          settings.notifications[category] = Boolean(notifications[category]);
        }
      }
    }

    // Del Sistema de Cocina aquí solo se cambian los tiempos de alerta.
    // Encenderlo y apagarlo se hace en /kitchen/devices/pair y /kitchen/disable,
    // porque implica emparejar o revocar pantallas (kitchenController); un
    // "enabled" que llegue aquí se ignora.
    if (kitchen) {
      const { warningMinutes, maxMinutes } = kitchen;

      // Se validan ambos tiempos juntos: el amarillo tiene que llegar antes
      // que el rojo, así que el que no venga se toma del valor guardado.
      const nextWarning = warningMinutes !== undefined ? Number(warningMinutes) : settings.kitchen.warningMinutes;
      const nextMax = maxMinutes !== undefined ? Number(maxMinutes) : settings.kitchen.maxMinutes;
      const { min, max } = KITCHEN_MINUTES_RANGE;
      const inRange = (value) => Number.isInteger(value) && value >= min && value <= max;

      if (!inRange(nextWarning) || !inRange(nextMax)) {
        return res.status(400).json({ title: "Tiempo inválido", message: `Los tiempos de alerta de cocina deben ser minutos enteros entre ${min} y ${max}.` });
      }
      if (nextWarning >= nextMax) {
        return res.status(400).json({ title: "Tiempo inválido", message: "La advertencia (amarillo) debe llegar antes que el tiempo máximo (rojo)." });
      }

      if (nextWarning !== settings.kitchen.warningMinutes || nextMax !== settings.kitchen.maxMinutes) {
        settings.kitchen.warningMinutes = nextWarning;
        settings.kitchen.maxMinutes = nextMax;
        kitchenChanged = true;
      }
    }

    await settings.save();

    if (kitchenChanged) {
      // Panel (otras pestañas) y pantallas de cocina (socket.js lo reenvía a
      // su namespace) ven los tiempos nuevos al instante.
      emitToRoles(["admin", "employee"], SOCKET_EVENTS.KITCHEN_STATUS_CHANGED, {
        kitchen: settings.toObject().kitchen,
      });
    }

    await notificationUtils.createNotification({
      req,
      category: "settings",
      action: "updated",
      title: "Ajustes actualizados",
      message: (actor) => `${actor.name} actualizó la configuración general del sistema`,
      icon: "cog",
      severity: "info",
      entity: { model: "Settings", id: settings._id, label: "Ajustes" },
    });

    return res.status(200).json({ title: "Ajustes actualizados", message: "La configuración se actualizó correctamente.", data: settings });
  } catch (error) {
    console.error("settingsController.updateSettings:", error);
    return res.status(500).json({ title: "Error del servidor", message: "Ocurrió un problema interno. Intenta de nuevo más tarde." });
  }
};

export default settingsController;
