// Contenido del QR de cada mesa. Ahora es un enlace a la página de la mesa
// (https://<sitio>/mesa/<token>), para que cualquier cámara lo abra sin la
// app. Se siguen aceptando el formato anterior "syscor-mesa:<token>" y el
// token solo, para que la app registre la llegada con cualquiera.
const TOKEN = "[A-Za-z0-9_-]{6,64}";

export const tokenFromCode = (code) => {
    const text = String(code || "").trim();
    const fromUrl = text.match(new RegExp(`/mesa/(${TOKEN})/?(?:[?#].*)?$`));
    if (fromUrl) return fromUrl[1];
    const legacy = text.match(new RegExp(`^syscor-mesa:(${TOKEN})$`));
    if (legacy) return legacy[1];
    return new RegExp(`^${TOKEN}$`).test(text) ? text : null;
};

export default { tokenFromCode };
