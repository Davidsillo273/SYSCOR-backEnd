// Teléfonos y tarjetas guardadas del cliente: validación y forma en que se le
// devuelven a la app. Lo usan customerController, authMeController y el
// registro de clientes.

// ── TELÉFONOS ───────────────────────────────────────────────────────────

export const MAX_PHONES = 3;
export const PHONE_TYPES = ["mobile", "landline", "work", "other"];

// Deja solo los 8 dígitos (formato de El Salvador), sin guiones ni +503.
const cleanPhone = (value) =>
    String(value || "").replace(/[\s\-()]/g, "").replace(/^\+?503/, "");

// Los clientes registrados antes de que existieran los tipos tienen sus
// teléfonos guardados como texto plano. Aquí se llevan a la forma actual
// ({ number, type, isDefault }) para que la app y el panel reciban siempre lo
// mismo, y se garantiza que exactamente uno sea el predeterminado.
export const normalizePhones = (phones) => {
    const list = (Array.isArray(phones) ? phones : [])
        .map((phone) => {
            if (typeof phone === "string") return { number: cleanPhone(phone), type: "mobile", isDefault: false };
            if (!phone || typeof phone !== "object") return null;
            return {
                number: cleanPhone(phone.number),
                type: PHONE_TYPES.includes(phone.type) ? phone.type : "mobile",
                isDefault: phone.isDefault === true,
            };
        })
        .filter((phone) => phone && phone.number);

    if (list.length > 0) {
        const defaultIndex = Math.max(list.findIndex((phone) => phone.isDefault), 0);
        list.forEach((phone, index) => {
            phone.isDefault = index === defaultIndex;
        });
    }

    return list;
};

// Valida la lista completa que manda la app al editar sus teléfonos.
export const validatePhoneList = (phones) => {
    if (!Array.isArray(phones)) {
        return { valid: false, message: "La lista de teléfonos no es válida." };
    }
    if (phones.length > MAX_PHONES) {
        return { valid: false, message: `Puedes registrar hasta ${MAX_PHONES} teléfonos.` };
    }

    const seen = new Set();
    for (const phone of phones) {
        const number = cleanPhone(phone?.number);
        if (!/^\d{8}$/.test(number)) {
            return { valid: false, message: "Cada teléfono debe tener 8 dígitos (formato de El Salvador)." };
        }
        if (!PHONE_TYPES.includes(phone?.type)) {
            return { valid: false, message: "Elige un tipo válido para cada teléfono." };
        }
        if (seen.has(number)) {
            return { valid: false, message: "Hay un teléfono repetido en la lista." };
        }
        seen.add(number);
    }

    return { valid: true };
};

// ── TARJETAS ────────────────────────────────────────────────────────────

export const MAX_CARDS = 5;

// Marca según el prefijo (BIN). Los valores son los del enum de customerModel.
export const detectCardBrand = (digits) => {
    if (/^4/.test(digits)) return "VISA";
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "MASTERCARD";
    if (/^3[47]/.test(digits)) return "AMEX";
    if (/^3(0[0-5]|[68])/.test(digits)) return "DINERS";
    return "OTHER";
};

const isValidLuhn = (digits) => {
    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let digit = Number(digits[i]);
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
};

// Valida los datos de una tarjeta nueva. No recibe CVV: nunca se guarda.
export const validateCardInput = ({ cardHolder, cardNumber, expiryMonth, expiryYear }) => {
    const digits = String(cardNumber || "").replace(/\D/g, "");
    const month = Number(expiryMonth);
    const year = Number(expiryYear);

    if (!cardHolder || typeof cardHolder !== "string" || cardHolder.trim().length < 3) {
        return { valid: false, message: "Escribe el nombre tal como aparece en la tarjeta." };
    }
    if (digits.length < 15 || digits.length > 19 || !isValidLuhn(digits)) {
        return { valid: false, message: "El número de tarjeta no es válido." };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 0 || year > 99) {
        return { valid: false, message: "La fecha de vencimiento no es válida." };
    }

    const now = new Date();
    const currentYear = now.getFullYear() % 100;
    const currentMonth = now.getMonth() + 1;
    if (year < currentYear || (year === currentYear && month < currentMonth)) {
        return { valid: false, message: "La tarjeta está vencida." };
    }

    return { valid: true, digits, month, year };
};

// Lo que la app puede ver de una tarjeta: nunca el token cifrado.
export const toPublicCard = (card, index) => ({
    index,
    brand: card.brand,
    lastFour: card.lastFour,
    cardHolder: card.cardHolder,
    expiryMonth: card.expiryMonth ?? null,
    expiryYear: card.expiryYear ?? null,
    isDefault: !!card.isDefault,
});

// Deja exactamente una tarjeta como predeterminada (misma regla que las direcciones).
export const ensureSingleDefault = (list, preferredIndex = null) => {
    if (list.length === 0) return list;
    const target =
        preferredIndex !== null && list[preferredIndex]
            ? preferredIndex
            : list.findIndex((item) => item.isDefault);
    const defaultIndex = target >= 0 ? target : 0;
    list.forEach((item, index) => {
        item.isDefault = index === defaultIndex;
    });
    return list;
};

export default {
    MAX_PHONES,
    PHONE_TYPES,
    MAX_CARDS,
    normalizePhones,
    validatePhoneList,
    detectCardBrand,
    validateCardInput,
    toPublicCard,
    ensureSingleDefault,
};
