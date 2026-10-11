// ¿La caja está cobrando en este momento? Sistema de caja encendido y al
// menos un turno abierto. Con la caja abierta, los meseros no cobran las
// mesas: las mandan a caja.
import SettingsModel from "../../models/settings/settingsModel.js";
import CashSession from "../../models/cashier/cashSessionModel.js";

export const isCashierOpen = async () => {
    const settings = await SettingsModel.findOne().select("cashier.enabled").lean();
    if (!settings?.cashier?.enabled) return false;
    return Boolean(await CashSession.exists({ status: "open" }));
};

export default { isCashierOpen };
