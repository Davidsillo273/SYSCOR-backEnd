// A qué productos se le puede agregar cada extra.
//
// Cada extra guarda en `appliesTo` los tipos de platillo a los que aplica
// (las mismas categorías de los platillos, más "Bebidas"). Así "Extra kétchup"
// sale en las alitas y no en los tacos. Un extra sin tipos no se ofrece en
// ningún lado: es preferible no mostrarlo a ofrecer algo que no tiene sentido.
//
// La app de clientes aplica la misma regla para mostrar los extras
// (apps/customer/src/utils/extraTargets.js) y el checkout la vuelve a
// comprobar al cobrar.
import { SAUCER_CATEGORIES } from "../saucers/saucerCategoriesUtils.js";

export const DRINKS_TARGET = "Bebidas";
export const EXTRA_TARGETS = [...SAUCER_CATEGORIES, DRINKS_TARGET];

// Los tipos llegan como arreglo o, desde un FormData, como string JSON.
export const parseAppliesTo = (raw) => {
    let list = raw;
    if (typeof raw === "string") {
        try {
            list = JSON.parse(raw);
        } catch {
            list = raw.split(",");
        }
    }
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((t) => String(t).trim()).filter((t) => EXTRA_TARGETS.includes(t)))];
};

// Tipos de un producto del menú:
//   - platillo: su categoría
//   - combo: las categorías de los platillos que incluye (fijos u opcionales)
//   - bebida: "Bebidas"
// `product` es el documento ya poblado (en el combo, saucers/selectiveOptions
// con saucerId poblado).
export const targetsForProduct = (productType, product) => {
    if (productType === "drink") return [DRINKS_TARGET];
    if (productType === "saucer") return product?.category ? [product.category] : [];
    if (productType === "combo") {
        const saucers = [...(product?.saucers || []), ...(product?.selectiveOptions || [])];
        return [...new Set(saucers.map((s) => s?.saucerId?.category).filter(Boolean))];
    }
    return [];
};

export const extraFitsProduct = (extra, targets) =>
    (extra?.appliesTo || []).some((t) => targets.includes(t));

export default { DRINKS_TARGET, EXTRA_TARGETS, parseAppliesTo, targetsForProduct, extraFitsProduct };
