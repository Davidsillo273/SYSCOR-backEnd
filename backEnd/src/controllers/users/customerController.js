// Importamos el modelo y utilidades para poder gestionar a los clientes (customers)
import CustomerModel from "../../models/users/customerModel.js";
import crudUtils from "../../utils/users/crudUtils.js";
import validationUtils from "../../utils/auth/validationsUsersUtils.js";
import notificationUtils from "../../utils/notifications/notificationUtils.js";
import Order from "../../models/orders/orderModel.js";
import cloudinaryUtils from "../../utils/cloudinaryUtils.js";

const customerController = {};

// Obtiene la lista de clientes registrados en la plataforma
customerController.getCustomers = async (req, res) => {
    try {
        const customers = await crudUtils.searchDocuments(CustomerModel, req.query);
        return res.status(200).json(customers);
    } catch (error) {
        console.error("customerController.getCustomers:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo obtener la lista de clientes." });
    }
};

// Actualiza los datos de un cliente (nombre, apellidos o foto de perfil) y lo guarda en la base de datos
customerController.updateCustomer = async (req, res) => {
    try {
        const { name, lastname } = req.body;
        const updateData = {};
        const validationsToRun = [];

        if (name !== undefined) {
            validationsToRun.push(() => validationUtils.validateName(name, "El nombre"));
            updateData["personalInfo.name"] = name.trim();
        }
        if (lastname !== undefined) {
            validationsToRun.push(() => validationUtils.validateName(lastname, "El apellido"));
            updateData["personalInfo.lastname"] = lastname.trim();
        }

        // req.file lo agrega multer (la ruta lleva upload.single("image")).
        // Mismo patrón que employeeController.updateEmployee: solo se toca la
        // imagen si de verdad llegó un archivo nuevo.
        if (req.file) {
            updateData["personalInfo.image"] = req.file.path;
        }

        if (validationsToRun.length > 0) {
            const result = validationUtils.runValidations(validationsToRun);
            if (!result.valid) return res.status(400).json({ title: "Datos inválidos", message: result.message });
        }

        // Si viene una foto nueva, se guarda la URL de la anterior para
        // borrarla de Cloudinary después de que la actualización tenga éxito
        // (si se borra antes y falla el update, se pierde la imagen vieja
        // sin haber guardado la nueva).
        let previousImage = null;
        if (req.file) {
            const currentCustomer = await CustomerModel.findById(req.params.id).select("personalInfo.image");
            previousImage = currentCustomer?.personalInfo?.image || null;
        }

        const updatedCustomer = await CustomerModel.findByIdAndUpdate(
            req.params.id,
            { $set: updateData },
            { new: true }
        ).select("-loginInfo.password");

        if (!updatedCustomer) return res.status(404).json({ title: "Cliente no encontrado", message: "No se encontró el cliente solicitado." });

        // La imagen anterior ya no la usa nadie, se elimina de Cloudinary
        if (previousImage) {
            await cloudinaryUtils.deletePreviousImage(previousImage);
        }

        const customerName = `${updatedCustomer.personalInfo?.name || ""} ${updatedCustomer.personalInfo?.lastname || ""}`.trim();

        await notificationUtils.createNotification({
            req,
            category: "clients",
            action: "updated",
            title: "Cliente actualizado",
            message: (actor) => `${actor.name} actualizó los datos del cliente ${customerName}`,
            icon: "user-pen",
            severity: "info",
            entity: { model: "Customer", id: updatedCustomer._id, label: customerName },
        });

        return res.status(200).json({ title: "Cliente actualizado", message: "Los datos se actualizaron correctamente.", data: updatedCustomer });
    } catch (error) {
        console.error("customerController.updateCustomer:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo actualizar el cliente." });
    }
};

// Activa o desactiva la cuenta de un cliente.
//
// No se borra al cliente: su historial de pedidos se necesita para la
// contabilidad y los rankings. Desactivarlo le impide iniciar sesión (ver
// loginUtils.processLogin), que es lo que realmente se busca al "darlo de baja".
customerController.toggleStatus = async (req, res) => {
    try {
        const { status } = req.body;

        const customer = await CustomerModel.findById(req.params.id).select("personalInfo status");
        if (!customer) {
            return res.status(404).json({ title: "Cliente no encontrado", message: "No se encontró el cliente solicitado." });
        }

        // Si no mandan el valor, se alterna el actual (útil para un botón simple).
        const current = customer.status || "active";
        const newStatus = status === "active" || status === "inactive"
            ? status
            : (current === "active" ? "inactive" : "active");

        customer.status = newStatus;
        await customer.save();

        const customerName = `${customer.personalInfo?.name || ""} ${customer.personalInfo?.lastname || ""}`.trim();
        const wasDeactivated = newStatus === "inactive";

        await notificationUtils.createNotification({
            req,
            category: "clients",
            action: "status_changed",
            title: wasDeactivated ? "Cliente desactivado" : "Cliente reactivado",
            message: (actor) =>
                `${actor.name} ${wasDeactivated ? "desactivó" : "reactivó"} la cuenta del cliente ${customerName}`,
            icon: wasDeactivated ? "ban" : "check-circle",
            severity: wasDeactivated ? "warning" : "success",
            entity: { model: "Customer", id: customer._id, label: customerName },
        });

        return res.status(200).json({
            title: wasDeactivated ? "Cliente desactivado" : "Cliente reactivado",
            message: wasDeactivated
                ? "El cliente ya no podrá iniciar sesión."
                : "El cliente puede volver a iniciar sesión.",
            data: { _id: customer._id, status: newStatus },
        });
    } catch (error) {
        console.error("customerController.toggleStatus:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo actualizar el estado del cliente." });
    }
};

// Historial de pedidos de un cliente, para el detalle de su ficha.
// Solo pedidos en línea llevan cliente con cuenta: los locales los anota el
// mesero como texto libre, así que no se pueden asociar a nadie.
customerController.getCustomerOrders = async (req, res) => {
    try {
        const orders = await Order.find({ customer: req.params.id })
            .select("items total status paymentStatus paymentMethod isDelivery createdAt orderType")
            .sort({ createdAt: -1 })
            .limit(50);

        // Resumen para el encabezado del historial: cuánto ha gastado y
        // cuántas veces ha pedido. Solo cuentan los pedidos entregados,
        // igual que hace el leaderboard de clientes.
        const delivered = orders.filter((o) => o.status === "delivered");
        const totalSpent = delivered.reduce((acc, o) => acc + (Number(o.total) || 0), 0);

        return res.status(200).json({
            orders,
            summary: {
                totalOrders: orders.length,
                deliveredOrders: delivered.length,
                totalSpent: Math.round((totalSpent + Number.EPSILON) * 100) / 100,
                lastOrderAt: orders[0]?.createdAt || null,
            },
        });
    } catch (error) {
        console.error("customerController.getCustomerOrders:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo obtener el historial de pedidos." });
    }
};

export default customerController;
