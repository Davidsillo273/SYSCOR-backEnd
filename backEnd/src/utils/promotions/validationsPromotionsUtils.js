// Reglas de una promoción del día. El nombre y el precio siguen las mismas
// reglas que cualquier ítem del menú (ver utils/common/duplicateNameUtils.js);
// lo propio de este módulo son la composición y la ventana de tiempo.
import { validateItemName, validateItemPrice } from "../common/duplicateNameUtils.js";
import { MAX_PROMOTION_DAYS, PROMOTION_ITEM_TYPES } from "../../models/menu/promotionsModel.js";

const validateName = validateItemName;

const validateDescription = (description) => {
  if (!description || typeof description !== "string" || !description.trim()) {
    return { valid: false, message: "La descripción es requerida." };
  }
  return { valid: true };
};

// Una promo sin nada adentro no es una promo. Cada línea debe decir qué
// producto es, de qué tipo y cuántas unidades entran.
const validateItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, message: "La promoción debe incluir al menos un producto." };
  }

  for (const item of items) {
    if (!item?.refId) {
      return { valid: false, message: "Cada producto de la promoción debe estar seleccionado." };
    }
    if (!PROMOTION_ITEM_TYPES.includes(item?.itemType)) {
      return {
        valid: false,
        message: `El tipo de producto debe ser uno de: ${PROMOTION_ITEM_TYPES.join(", ")}.`,
      };
    }
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity < 1) {
      return { valid: false, message: "La cantidad de cada producto debe ser al menos 1." };
    }
  }

  return { valid: true };
};

// El precio existe (regla compartida) y además tiene que ser un número
// positivo: regalar la promo sería un error de dedo, no un descuento.
const validatePrice = (price) => {
  const base = validateItemPrice(price);
  if (!base.valid) return base;

  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) {
    return { valid: false, message: "El precio de la promoción debe ser mayor que cero." };
  }
  return { valid: true };
};

/**
 * Ventana de vigencia. Es la regla central del módulo: una promoción es
 * temporal por definición, así que no puede durar más de MAX_PROMOTION_DAYS
 * días. Devuelve además las fechas ya normalizadas a Date para que el
 * controller no tenga que volver a parsearlas.
 */
const validateWindow = (startsAt, endsAt) => {
  const start = startsAt ? new Date(startsAt) : new Date();
  if (Number.isNaN(start.getTime())) {
    return { valid: false, message: "La fecha de inicio no es válida." };
  }

  if (!endsAt) {
    return { valid: false, message: "Indica hasta cuándo estará vigente la promoción." };
  }

  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) {
    return { valid: false, message: "La fecha de fin no es válida." };
  }

  if (end <= start) {
    return { valid: false, message: "La promoción debe terminar después de haber empezado." };
  }

  const maxMs = MAX_PROMOTION_DAYS * 24 * 60 * 60 * 1000;
  if (end.getTime() - start.getTime() > maxMs) {
    return {
      valid: false,
      message: `Una promoción puede durar como máximo ${MAX_PROMOTION_DAYS} días.`,
    };
  }

  return { valid: true, start, end };
};

const validateStatus = (status) => {
  if (!["activa", "pausada", "expirada"].includes(status)) {
    return { valid: false, message: "El estado debe ser 'activa', 'pausada' o 'expirada'." };
  }
  return { valid: true };
};

export default {
  validateName,
  validateDescription,
  validateItems,
  validatePrice,
  validateWindow,
  validateStatus,
};
