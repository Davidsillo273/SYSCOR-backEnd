// Precarga a qué tipos de platillo aplica cada extra (campo `appliesTo`).
//
// Es una propuesta inicial según el nombre del extra, para que el admin no
// empiece de cero: después se revisa y corrige desde el panel (Extras).
// Solo toca los extras que todavía no tienen tipos, así que correrlo de nuevo
// no pisa lo que el admin ya configuró. Con --dry-run solo muestra qué haría.
//
//   node scripts/prefillExtraTargets.js --dry-run
//   node scripts/prefillExtraTargets.js
import mongoose from "mongoose";
import { config } from "../config.js";
import ExtrasModel from "../src/models/menu/extrasModel.js";
import { EXTRA_TARGETS } from "../src/utils/extras/extraTargetsUtils.js";

const DRY_RUN = process.argv.includes("--dry-run");

const MAIN = ["Tacos", "Burritos", "Tortas", "Quesadillas", "Nachos", "Antojitos"];
const PLATES = ["A la plancha", "Especiales"];

// Palabra clave del nombre (sin tildes, en minúsculas) -> tipos de platillo.
// Van de lo más específico a lo más general: gana la primera que coincida.
const RULES = [
    ["aderezo cheddar", ["Nachos", "Alitas", "Burritos"]],
    ["aderezo", ["Alitas", "Nachos", "Burritos", "Tortas"]],
    ["aguacate", [...MAIN, "A la plancha", "Sopas"]],
    ["arroz", ["Burritos", ...PLATES]],
    ["carne", MAIN],
    ["casamiento", PLATES],
    ["cilantro cebolla", ["Tacos", "Burritos", "Quesadillas", "Nachos", "Antojitos", "Sopas"]],
    ["cebolla", [...MAIN, "A la plancha", "Sopas"]],
    ["chirmol", ["Tacos", "Antojitos", ...PLATES]],
    ["chorizo", [...MAIN, "A la plancha"]],
    ["cilantro", ["Tacos", "Burritos", "Quesadillas", "Nachos", "Antojitos", "Sopas"]],
    ["crema", ["Tacos", "Burritos", "Quesadillas", "Nachos", "Antojitos", "Sopas"]],
    ["ensalada de papa", [...PLATES, "Alitas"]],
    ["ensalada", PLATES],
    ["frijol", ["Burritos", "Tortas", "Nachos", "Antojitos", "A la plancha"]],
    ["hielo", ["Bebidas"]],
    ["ketchup", ["Alitas", "Tortas"]],
    ["limon", ["Tacos", "Sopas", "Alitas", "Especiales", "Bebidas"]],
    ["nachos", ["Sopas", "Nachos"]],
    ["papa", PLATES],
    ["pina", ["Tacos", "Tortas"]],
    ["quesillo", MAIN],
    ["queso", ["Tacos", "Burritos", "Quesadillas", "Nachos", "Antojitos"]],
    ["salsa", [...MAIN, "Alitas"]],
    ["tortilla de taco", ["Tacos"]],
    ["tortilla", ["Antojitos", "Sopas", ...PLATES]],
];

const normalize = (text) =>
    String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const suggest = (name) => {
    const n = normalize(name);
    const rule = RULES.find(([keyword]) => n.includes(keyword));
    return rule ? rule[1].filter((t) => EXTRA_TARGETS.includes(t)) : [];
};

await mongoose.connect(config.db.uri);
const extras = await ExtrasModel.find({}).select("name appliesTo").lean();

let updated = 0;
const unmatched = [];
for (const extra of extras.sort((a, b) => a.name.localeCompare(b.name))) {
    if (extra.appliesTo?.length) {
        console.log(`= ${extra.name}: ya configurado (${extra.appliesTo.join(", ")})`);
        continue;
    }
    const targets = suggest(extra.name);
    if (targets.length === 0) {
        unmatched.push(extra.name);
        console.log(`? ${extra.name}: sin propuesta, configúralo en el panel`);
        continue;
    }
    console.log(`${DRY_RUN ? "~" : "+"} ${extra.name}: ${targets.join(", ")}`);
    if (!DRY_RUN) {
        await ExtrasModel.updateOne({ _id: extra._id }, { $set: { appliesTo: targets } });
        updated += 1;
    }
}

console.log(`\n${DRY_RUN ? "(simulación) " : ""}Actualizados: ${updated} de ${extras.length}. Sin propuesta: ${unmatched.length}.`);
await mongoose.disconnect();
