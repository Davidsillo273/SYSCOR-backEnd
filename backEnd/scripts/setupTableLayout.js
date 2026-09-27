// Ubica las mesas del comedor según los croquis del local y les pone
// capacidad, planta, zona y el token de su código QR.
//
//   Planta baja (comedor):          Planta alta (terraza):
//     [1]  [ 5 ]  [9]                 [13] [14] [15]
//     [2]  [ 6 ]  [10]                [16] [17] [18]
//     [3]  [ 7 ]  [11]                [19] [20]
//     [4]  [ 8 ]  [12]                [21] [22]   escalera · baño
//                                     [23] [24]
//
// 1–4 y 9–12 van junto al ventanal (4 personas), 5–8 son las mesas dobles del
// salón central (8 personas) y 13–24 están en la terraza (4 personas).
//
// Las mesas que ya existen conservan su estado y sus datos de ocupación;
// las que faltan se crean libres. El QR solo se genera si la mesa no tiene
// uno, así que correrlo de nuevo no invalida los códigos ya impresos.
// Con --dry-run solo muestra qué haría.
//
//   node scripts/setupTableLayout.js --dry-run
//   node scripts/setupTableLayout.js
import mongoose from "mongoose";
import { config } from "../config.js";
import TablesModel, { newQrToken } from "../src/models/tables/tablesModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

// Posición en porcentaje del plano de cada planta (x, y, ancho, alto).
const FLOOR_1_ROWS = [35, 49, 63, 78];
const FLOOR_2_ROWS = [7, 25, 45, 63, 81];

const LAYOUT = [
    // Planta baja: columna izquierda, dobles del centro, columna derecha.
    ...FLOOR_1_ROWS.map((y, i) => ({ number: 1 + i, zone: "ventanal", capacity: 4, position: { x: 3, y, w: 16, h: 9 } })),
    ...FLOOR_1_ROWS.map((y, i) => ({ number: 5 + i, zone: "salon_central", capacity: 8, position: { x: 35, y, w: 31, h: 9 } })),
    ...FLOOR_1_ROWS.map((y, i) => ({ number: 9 + i, zone: "ventanal", capacity: 4, position: { x: 81, y, w: 16, h: 9 } })),
    // Terraza: tres columnas en las dos primeras filas y dos en el resto
    // (a la derecha están la escalera y el baño).
    ...[
        [13, 0, 0], [14, 1, 0], [15, 2, 0],
        [16, 0, 1], [17, 1, 1], [18, 2, 1],
        [19, 0, 2], [20, 1, 2],
        [21, 0, 3], [22, 1, 3],
        [23, 0, 4], [24, 1, 4],
    ].map(([number, col, row]) => ({
        number,
        zone: "terraza",
        capacity: 4,
        position: { x: [2, 32, 66][col], y: FLOOR_2_ROWS[row], w: 19, h: 9.5 },
    })),
];

const FLOOR_OF = { ventanal: 1, salon_central: 1, terraza: 2 };

await mongoose.connect(config.db.uri);

let created = 0;
let updated = 0;
for (const spec of LAYOUT) {
    // lean(): sin él Mongoose rellena qrToken con uno nuevo al leer y parecería
    // que la mesa ya tenía código.
    const existing = await TablesModel.findOne({ number: spec.number }).lean();
    const fields = { capacity: spec.capacity, floor: FLOOR_OF[spec.zone], zone: spec.zone, position: spec.position };
    const label = `Mesa ${String(spec.number).padStart(2)} → planta ${fields.floor}, ${spec.zone}, ${spec.capacity} personas`;

    if (existing) {
        console.log(`${DRY_RUN ? "[dry-run] " : ""}actualizar ${label}${existing.qrToken ? "" : " + QR nuevo"}`);
        if (!DRY_RUN) {
            await TablesModel.updateOne(
                { _id: existing._id },
                { $set: { ...fields, ...(existing.qrToken ? {} : { qrToken: newQrToken() }) } },
            );
        }
        updated += 1;
    } else {
        console.log(`${DRY_RUN ? "[dry-run] " : ""}crear      ${label}`);
        if (!DRY_RUN) await TablesModel.create({ number: spec.number, status: "libre", ...fields });
        created += 1;
    }
}

const others = await TablesModel.find({ number: { $nin: LAYOUT.map((t) => t.number) } }).select("number");
if (others.length > 0) {
    console.log(`Mesas fuera del croquis (no se tocaron): ${others.map((t) => t.number).join(", ")}`);
}
console.log(`${DRY_RUN ? "[dry-run] " : ""}${updated} actualizadas, ${created} creadas.`);

await mongoose.disconnect();
