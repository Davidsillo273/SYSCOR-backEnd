// Cambio de bebida dentro de un combo.
//
// Un combo incluye sin costo las bebidas que el admin eligió en su política
// (conjuntos + bebidas sueltas). Además siempre se ofrecen las bebidas de la
// casa (horchata, jamaica...) pagando la diferencia; otras bebidas no:
//
//   recargo = precio de la bebida elegida − precio de la incluida más barata
//
// Nunca es negativo: si la elegida cuesta lo mismo o menos, no se cobra nada.
// La app de clientes calcula lo mismo para mostrarlo
// (apps/customer/src/utils/drinkUpgrade.js); el checkout lo vuelve a calcular
// aquí con los precios de la base de datos.

export const HOUSE_DRINK_CATEGORY = "casa";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Bebidas que el combo incluye. Requiere el combo con
// drinkPolicy.drinkSetIds.drinkIds y drinkPolicy.thirdPartyDrinkIds poblados.
export const includedDrinksOf = (combo) => {
    const policy = combo?.drinkPolicy || {};
    const fromSets = (policy.drinkSetIds || []).flatMap((set) => set?.drinkIds || []);
    return [...fromSets, ...(policy.thirdPartyDrinkIds || [])].filter((drink) => drink && drink._id);
};

export const drinkSurchargeFor = (includedDrinks, drink) => {
    const prices = (includedDrinks || []).map((d) => Number(d.price) || 0);
    if (prices.length === 0) return 0;
    return Math.max(0, round2((Number(drink?.price) || 0) - Math.min(...prices)));
};
