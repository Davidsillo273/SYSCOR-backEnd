import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import CustomerModel from "../../../models/users/customerModel.js";
import cookieConfig from "../../../config/cookieConfig.js";
import { config } from "../../../../config.js";

// Comprar sin registrarse: el cliente solo da nombre y apellidos y se le crea
// una cuenta de invitado (isGuest) con su sesión normal. Así el carrito, el
// pago, "Mis pedidos", el seguimiento y el chat con el repartidor funcionan
// igual que con una cuenta registrada.
//
// La cuenta no tiene correo ni contraseña reales: el correo es interno (el
// campo es obligatorio y único) y la contraseña, aleatoria. Nadie puede
// iniciar sesión con ella; la sesión vive en la cookie del teléfono.
const guestCustomerController = {};

const NAME_PATTERN = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{2,40}$/;
const cleanName = (value) => String(value || "").replace(/\s+/g, " ").trim();

// POST /auth/customers/guest  { name, lastname }
guestCustomerController.createGuest = async (req, res) => {
    try {
        const name = cleanName(req.body?.name);
        const lastname = cleanName(req.body?.lastname);

        if (!NAME_PATTERN.test(name)) {
            return res.status(400).json({ title: "Revisa tu nombre", message: "Escribe tu nombre (solo letras, de 2 a 40)." });
        }
        if (!NAME_PATTERN.test(lastname)) {
            return res.status(400).json({ title: "Revisa tus apellidos", message: "Escribe tus apellidos (solo letras, de 2 a 40)." });
        }

        const id = crypto.randomBytes(8).toString("hex");
        const guest = await CustomerModel.create({
            personalInfo: { name, lastname },
            loginInfo: {
                email: `invitado-${id}@invitado.syscor`,
                password: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10),
                isVerified: true,
            },
            isGuest: true,
        });

        // Mismo contenido que el token de processLogin (loginUtils).
        const token = jwt.sign(
            { id: guest._id, role: "customer", permissions: [], tokenVersion: 0 },
            config.jwt.secret,
            { expiresIn: "30d" },
        );
        res.cookie("authCookie", token, cookieConfig);

        return res.status(201).json({ title: "Listo", message: `¡Hola, ${name}! Ya puedes hacer tu pedido.` });
    } catch (error) {
        console.error("guestCustomerController.createGuest:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No pudimos iniciar tu pedido. Intenta de nuevo." });
    }
};

export default guestCustomerController;
