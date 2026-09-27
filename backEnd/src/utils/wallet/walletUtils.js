// Historial del saldo a favor (ver models/users/walletMovementModel.js).
//
// El saldo se sigue moviendo con $inc sobre customer.wallet.balance donde ya
// se hacía (reclamos, checkout); aquí solo se deja el registro. Registrar
// nunca debe tumbar la operación de dinero: si falla, se avisa en el log.
import WalletMovement from "../../models/users/walletMovementModel.js";
import CustomerModel from "../../models/users/customerModel.js";
import { orderCode } from "../orders/orderCodeUtils.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Código de orden para los textos ("AD27-01"). Recibe el pedido; con solo el
// id, usar findOrderCode de orderCodeUtils.
export const orderRef = (order) => orderCode(order);

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
