// Historial del saldo a favor (ver models/users/walletMovementModel.js).
//
// El saldo se sigue moviendo con $inc sobre customer.wallet.balance donde ya
// se hacía (reclamos, checkout); aquí solo se deja el registro. Registrar
// nunca debe tumbar la operación de dinero: si falla, se avisa en el log.
import WalletMovement from "../../models/users/walletMovementModel.js";
import CustomerModel from "../../models/users/customerModel.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Código corto de un pedido, igual que en la app: "#A1B2C".
export const orderRef = (id) => `#${String(id || "").slice(-5).toUpperCase()}`;

export const logWalletMovement = async ({ customer, type, amount, description, order, checkout, claim }) => {
    try {
        await WalletMovement.create({
            customer,
            type,
            amount: round2(amount),
            description,
            order: order || null,
            checkout: checkout || null,
            claim: claim || null,
        });
    } catch (error) {
        console.error("walletUtils.logWalletMovement:", error.message);
    }
};

// Abona saldo y lo registra.
export const creditWallet = async ({ customer, amount, ...movement }) => {
    const value = round2(amount);
    if (!(value > 0)) return;
    await CustomerModel.updateOne({ _id: customer }, { $inc: { "wallet.balance": value } });
    await logWalletMovement({ customer, amount: value, ...movement });
};

export default { logWalletMovement, creditWallet, orderRef };
