// Nombre y precio son reglas idénticas en todos los ítems de menú, ver
// utils/common/duplicateNameUtils.js para la implementación compartida.
import { validateItemName, validateItemPrice } from "../common/duplicateNameUtils.js";

const validateName = validateItemName;

import { SAUCER_CATEGORIES } from "./saucerCategoriesUtils.js";

const validateCategory = (category) => {
  if (!category || !SAUCER_CATEGORIES.includes(category)) {
    return {
      valid: false,
      message: "La categoría debe ser una de: " + SAUCER_CATEGORIES.join(", "),
    };
  }

  return { valid: true };
};

const validatePrice = validateItemPrice;

const validateStatus = (status) => {
  if (!status || typeof status !== "string") {
    return {
      valid: false,
      message: "El estado es requerido.",
    };
  }

  const validStatus = ["Activo", "Inactivo"];

  if (!validStatus.includes(status)) {
    return {
      valid: false,
      message: "El estado debe ser Activo o Inactivo.",
    };
  }

  return { valid: true };
};

// La imagen es opcional: si no se manda, el frontend usa un placeholder
const validateImage = () => ({ valid: true });

// Si la categoría es "Tacos", la cantidad por orden solo puede ser 3, 4 o 5
const validateTacoQuantity = (category, quantity) => {
  if (category !== "Tacos") return { valid: true };

  const qty = Number(quantity);
  if (![3, 4, 5].includes(qty)) {
    return {
      valid: false,
      message: "Para platillos de tacos, la cantidad debe ser 3, 4 o 5.",
    };
  }

  return { valid: true };
};

// La receta ya no es opcional: todo platillo necesita al menos un ingrediente
const validateRecipe = (recipe) => {
  if (!Array.isArray(recipe) || recipe.length === 0) {
    return {
      valid: false,
      message: "La receta es obligatoria: agrega al menos un ingrediente.",
    };
  }

  return { valid: true };
};

export default {
  validateName,
  validateCategory,
  validatePrice,
  validateStatus,
  validateImage,
  validateTacoQuantity,
  validateRecipe,
};