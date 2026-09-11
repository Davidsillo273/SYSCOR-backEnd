import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../../../config.js";

// Lógica de login compartida por Admin, Employee y Customer: solo cambia el
// Model que se le pasa y el "role" que se guarda en el token. Centralizarla
// acá evita que cada rol implemente su propio manejo de intentos fallidos.
const processLogin = async (Model, email, password, role) => {

    const userFound = await Model.findOne({ "loginInfo.email": email });

    // 1. Usuario no encontrado
    if (!userFound) {
        return {
            error: true,
            status: 404,
            title: "Usuario no encontrado",
            message: "No existe ninguna cuenta asociada a este correo electrónico."
        };
    }

    // 2. Cuenta desactivada por un administrador.
    // Solo los clientes tienen este campo (los empleados usan
    // workInfo.status, que se valida en processLoginByAccessCode y en el
    // middleware). Se comprueba ANTES de la contraseña porque un cliente
    // dado de baja no debe poder entrar aunque la sepa; si el modelo no
    // tiene "status", esta condición nunca se cumple y no afecta a nadie.
    if (userFound.status === "inactive") {
        return {
            error: true,
            status: 403,
            title: "Cuenta desactivada",
            message: "Tu cuenta está desactivada. Contacta al restaurante para reactivarla."
        };
    }

    // 3. Cuenta bloqueada actualmente por tiempo
    if (userFound.loginInfo.timeOut && userFound.loginInfo.timeOut > Date.now()) {
        return {
            error: true,
            status: 403,
            title: "Cuenta bloqueada",
            message: "Cuenta bloqueada por múltiples intentos fallidos. Por favor, inténtelo de nuevo más tarde."
        };
    }

    const isMatch = await bcrypt.compare(password, userFound.loginInfo.password);

    // 4. Contraseña incorrecta e incremento de intentos
    if (!isMatch) {
        userFound.loginInfo.loginAttempts = (userFound.loginInfo.loginAttempts || 0) + 1;

        // Regla de negocio: al quinto intento fallido seguido se bloquea la
        // cuenta 15 minutos (mitiga ataques de fuerza bruta). El contador se
        // reinicia junto con el bloqueo, así que el bloqueo siempre dispara
        // exactamente en múltiplos de 5 intentos.
        if (userFound.loginInfo.loginAttempts >= 5) {
            userFound.loginInfo.timeOut = Date.now() + 15 * 60 * 1000;
            userFound.loginInfo.loginAttempts = 0;
            await userFound.save();

            return {
                error: true,
                status: 403,
                title: "Demasiados intentos fallidos",
                message: "Su cuenta ha sido bloqueada temporalmente por 15 minutos."
            };
        }

        await userFound.save();
        return {
            error: true,
            status: 401,
            title: "Contraseña incorrecta",
            message: "Por favor, verifique e inténtelo de nuevo."
        };
    }

    // 4. Éxito: Reiniciar intentos y timeout
    userFound.loginInfo.loginAttempts = 0;
    userFound.loginInfo.timeOut = null;
    await userFound.save();

    // El token lleva permisos y tokenVersion embebidos para que el middleware
    // de autenticación no tenga que consultar la DB en cada petición; por eso
    // cuando un admin cambia los permisos de un empleado se incrementa
    // tokenVersion (ver employeeController.updateEmployee), invalidando los
    // tokens viejos que ya circulan.
    const tokenPayload = {
        id: userFound._id,
        role: role,
        permissions: userFound.permissions || [],
        tokenVersion: userFound.tokenVersion || 0
    };

    const token = jwt.sign(
        tokenPayload,
        process.env.JWT_SECRET || config.jwt.secret,
        { expiresIn: "30d" }
    );

    return {
        error: false,
        status: 200,
        token,
        message: "Inicio de sesión exitoso"
    };
};

// Login alterno para empleados con permisos: en vez de correo, usan el
// "código de acceso" único que el sistema les mandó por correo la primera
// vez que se les otorgó un permiso (ver employeeController.updateEmployee e
// inviteEmployeeController.acceptInvitation). Comparte toda la lógica de
// intentos/bloqueo de processLogin, solo cambia cómo se busca al usuario.
const processLoginByAccessCode = async (Model, accessCode, password) => {
    const userFound = await Model.findOne({ "loginInfo.accessCode": accessCode });

    if (!userFound) {
        return {
            error: true,
            status: 404,
            title: "Código inválido",
            message: "El código de acceso no corresponde a ningún empleado."
        };
    }

    // A diferencia de processLogin, acá se exige explícitamente que el
    // empleado esté activo: el código de acceso es un atajo pensado solo
    // para personal que trabaja actualmente, no para cuentas dadas de baja.
    if (userFound.workInfo?.status !== "active") {
        return {
            error: true,
            status: 403,
            title: "Cuenta inactiva",
            message: "Esta cuenta no está activa. Contacta a un administrador."
        };
    }

    if (userFound.loginInfo.timeOut && userFound.loginInfo.timeOut > Date.now()) {
        return {
            error: true,
            status: 403,
            title: "Cuenta bloqueada",
            message: "Cuenta bloqueada por múltiples intentos fallidos. Por favor, inténtelo de nuevo más tarde."
        };
    }

    const isMatch = await bcrypt.compare(password, userFound.loginInfo.password);

    if (!isMatch) {
        userFound.loginInfo.loginAttempts = (userFound.loginInfo.loginAttempts || 0) + 1;

        if (userFound.loginInfo.loginAttempts >= 5) {
            userFound.loginInfo.timeOut = Date.now() + 15 * 60 * 1000;
            userFound.loginInfo.loginAttempts = 0;
            await userFound.save();

            return {
                error: true,
                status: 403,
                title: "Demasiados intentos fallidos",
                message: "Su cuenta ha sido bloqueada temporalmente por 15 minutos."
            };
        }

        await userFound.save();
        return {
            error: true,
            status: 401,
            title: "Contraseña incorrecta",
            message: "Por favor, verifique e inténtelo de nuevo."
        };
    }

    userFound.loginInfo.loginAttempts = 0;
    userFound.loginInfo.timeOut = null;
    await userFound.save();

    const tokenPayload = {
        id: userFound._id,
        role: "employee",
        permissions: userFound.permissions || [],
        tokenVersion: userFound.tokenVersion || 0
    };

    const token = jwt.sign(
        tokenPayload,
        process.env.JWT_SECRET || config.jwt.secret,
        { expiresIn: "30d" }
    );

    return {
        error: false,
        status: 200,
        token,
        message: "Inicio de sesión exitoso"
    };
};

// Verifica que un código de acceso exista y esté activo, sin loguear a nadie
// todavía (paso previo del login: primero el código, luego se pide la
// contraseña). Devuelve el nombre para saludar, no el email (no hace falta
// exponerlo).
const findByAccessCode = async (Model, accessCode) => {
    const userFound = await Model.findOne({ "loginInfo.accessCode": accessCode }).select("personalInfo.name workInfo.status");
    if (!userFound || userFound.workInfo?.status !== "active") return null;
    return userFound;
};

export default processLogin;
export { processLoginByAccessCode, findByAccessCode };