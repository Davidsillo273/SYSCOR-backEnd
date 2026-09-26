import CustomerModel from "../../models/users/customerModel.js";
import WalletMovement from "../../models/users/walletMovementModel.js";
import Claim from "../../models/orders/claimModel.js";

const walletController = {};

const MOVEMENTS_LIMIT = 50;

// GET /wallet/mine — "Mi saldo" en la app: saldo actual, sus movimientos y
// los reembolsos a tarjeta (que no pasan por el saldo, pero el cliente los
// quiere seguir en el mismo lugar).
walletController.getMyWallet = async (req, res) => {
    try {
        const [customer, movements, refunds] = await Promise.all([
            CustomerModel.findById(req.user.id).select("wallet").lean(),
            WalletMovement.find({ customer: req.user.id }).sort({ createdAt: -1 }).limit(MOVEMENTS_LIMIT).lean(),
            Claim.find({ customer: req.user.id, resolution: "card_refund", status: { $in: ["pending_refund", "refunded"] } })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
        ]);
        if (!customer) return res.status(404).json({ title: "Cuenta no encontrada", message: "Vuelve a iniciar sesión." });

        return res.status(200).json({
            balance: Math.round((Number(customer.wallet?.balance) || 0) * 100) / 100,
            movements: movements.map((m) => ({
                id: m._id,
                type: m.type,
                amount: m.amount,
                description: m.description,
                orderId: m.order,
                createdAt: m.createdAt,
            })),
            cardRefunds: refunds.map((c) => ({
                id: c._id,
                orderId: c.order,
                amount: c.amount,
                status: c.status,
                reason: c.reason,
                createdAt: c.createdAt,
                resolvedAt: c.resolvedAt,
            })),
        });
    } catch (error) {
        console.error("walletController.getMyWallet:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo consultar tu saldo." });
    }
};

export default walletController;
