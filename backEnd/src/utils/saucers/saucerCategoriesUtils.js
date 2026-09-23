// Categorías de los platillos (Saucers). Única fuente de verdad: la usan el
// modelo, las validaciones, el controlador y el asistente de chat.
//
// "Especiales" queda solo para platos fuera de lo común (parrillada, mariscos);
// antes juntaba antojitos, nachos, carnes, alitas y postres.
export const SAUCER_CATEGORIES = [
  "Tacos",
  "Burritos",
  "Tortas",
  "Quesadillas",
  "Antojitos",
  "Nachos",
  "A la plancha",
  "Alitas",
  "Sopas",
  "Postres",
  "Especiales",
];

// Categorías donde la subcategoría de proteína (Al pastor, Pollo, Carne...) no
// aplica y se guarda vacía.
export const CATEGORIES_WITHOUT_SUBCATEGORY = [
  "A la plancha",
  "Alitas",
  "Sopas",
  "Postres",
  "Especiales",
];
