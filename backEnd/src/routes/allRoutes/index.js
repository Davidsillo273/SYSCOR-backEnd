import { Router } from "express";

import cartRoutes from "../orders/cartRoutes.js";
import extrasRouters from "../menu/extrasRoutes.js";
import drinksRouters from "../menu/drinksRoutes.js";
import saucerRouters from "../menu/saucersRoutes.js";
import combosRouters from "../menu/combosRoutes.js";
import drinkSetsRouters from "../menu/drinkSetsRoutes.js";
import promotionsRouters from "../menu/promotionsRoutes.js";
import inventoryRoutes from "../inventory/inventoryRoutes.js";
import customerRoutes from "../users/customerRoutes.js";
import employeeRoutes from "../users/employeeRoutes.js";
import adminRoutes from "../users/adminRoutes.js";
import payrollRoutes from "../users/payrollRoutes.js";
import duiScanRoutes from "../users/duiScanRoutes.js";
import wompiRoutes from "../orders/wompiRoutes.js"
import checkoutRoutes from "../orders/checkoutRoutes.js";
import panchitaRoutes from "../chat/panchitaRoutes.js";
import tablesRoutes from "../tables/tablesRoutes.js"
import notificationsRoutes from "../notifications/notificationsRoutes.js";
import settingsRoutes from "../settings/settingsRoutes.js";
import aiRoutes from "../ai/aiRoutes.js";
import assistantChatRoutes from "../chat/assistantChatRoutes.js";
import loginHelpRoutes from "../chat/loginHelpRoutes.js";
import orderRoutes from "../orders/orderRoutes.js";
import invoiceRoutes from "../orders/invoiceRoutes.js";
import purchaseInvoiceRoutes from "../orders/purchaseInvoiceRoutes.js";




// Aquí importamos todas las rutas de cada módulo

//auth - customers
import loginCustomerRoutes from "../auth/customers/loginCustomerRoutes.js";
import registerCustomerRoutes from "../auth/customers/registerCustomerRoutes.js";
//auth - employees
import inviteEmployeeRoutes from "../auth/employees/inviteEmployeeRoutes.js";
import loginEmployeeRoutes from "../auth/employees/loginEmployeeRoutes.js";
//auth - admins
import inviteAdminRoutes from "../auth/admins/inviteAdminRoutes.js";
import loginAdminRoutes from "../auth/admins/loginAdminRoutes.js";

//auth - logout
import logoutRoutes from "../auth/logoutRoutes.js";
//auth - recovery password
import recoveryPasswordRoutes from "../auth/recoveryPasswordRoutes.js";
//auth - change password (con sesión activa)
import changePasswordRoutes from "../auth/changePasswordRoutes.js";

//Midleware de autenticación
import { validateAuthCookie } from "../../middlewares/auth/authMiddleware.js"; 
import authMeRoutes from "../auth/authMeRoutes.js";
import walletRoutes from "../users/walletRoutes.js";

const router = Router();

//Nombres de los endpoints
// Menú: todo lo que el cliente puede pedir vive bajo /menu
router.use("/menu/extras", extrasRouters);
router.use("/menu/drinks", drinksRouters);
router.use("/menu/saucers", saucerRouters);
router.use("/menu/combos", combosRouters);
router.use("/menu/drink-sets", drinkSetsRouters);
// Promociones de hoy: ofertas temporales que combinan productos del menú
router.use("/menu/promotions", promotionsRouters);

// Pedidos: carrito (borrador de compra), pedidos (comandas) y pagos viven bajo /orders.
// La facturación (colección "invoices", generada automáticamente cuando un
// pedido se entrega) vive aparte, en /invoices.
router.use("/orders/carts", cartRoutes);
router.use("/orders", orderRoutes);
router.use("/orders/wompi", wompiRoutes);
// Pago en línea de la app de clientes (Wompi 3DS). Crea el pedido al aprobarse.
router.use("/payments", checkoutRoutes);
// Chef Panchita en la app de clientes (seguimiento, reclamos, repartidor).
router.use("/panchita", panchitaRoutes);
router.use("/invoices", invoiceRoutes);
// Facturas de COMPRA (las que suben desde los proveedores) y el reporte de
// IVA que las cruza contra las ventas. Contabilidad, no operaciones.
router.use("/purchase-invoices", purchaseInvoiceRoutes);

// Usuarios administrativos: admins, empleados y clientes viven bajo /users
router.use("/users/customers", customerRoutes);
router.use("/wallet", walletRoutes);
router.use("/users/employees", employeeRoutes);
router.use("/users/admins", adminRoutes);
// Planilla: se calcula a partir de la ficha de los empleados, por eso vive
// bajo /users, pero con su propio permiso ("payroll") por lo sensible del dato.
router.use("/users/payroll", payrollRoutes);
// Escaneo del DUI al invitar empleados (incluye la captura desde el celular)
router.use("/users/dui-scan", duiScanRoutes);

router.use("/inventory", inventoryRoutes);
router.use("/tables", tablesRoutes);
router.use("/notifications", notificationsRoutes);
router.use("/settings", settingsRoutes);
router.use("/ai", aiRoutes);
router.use("/chat", assistantChatRoutes);
// Ayuda del login: pública, porque quien pregunta aún no tiene sesión.
router.use("/chat", loginHelpRoutes);

//auth - customers
router.use("/auth/customers/register", registerCustomerRoutes);
router.use("/auth/customers/login", loginCustomerRoutes);
//auth - employees
router.use("/auth/employees/invite", inviteEmployeeRoutes);
router.use("/auth/employees/login", loginEmployeeRoutes);
//auth - admins
router.use("/auth/admins/invite", inviteAdminRoutes);
router.use("/auth/admins/login", loginAdminRoutes);

//auth - logout
router.use("/auth/logout", logoutRoutes);
//auth - recovery password
router.use("/auth/recovery-password", recoveryPasswordRoutes);
//auth - change password (con sesión activa)
router.use("/auth", changePasswordRoutes);
//auth - authMe
router.use("/auth", authMeRoutes)

export default router;
