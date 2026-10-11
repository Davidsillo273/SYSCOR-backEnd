import mongoose from "mongoose";
import EmployeeNotification from "../../models/notifications/employeeNotificationModel.js";

// Bandeja personal del empleado en la app (ver employeeNotificationModel).
// Cada empleado solo ve y marca las suyas.
const employeeNotificationsController = {};

const PAGE_SIZE = 30;

// GET /notifications/mine?before=<fecha ISO>
// Las más nuevas primero, de 30 en 30; `before` pide la página siguiente.
employeeNotificationsController.getMine = async (req, res) => {
    try {
        const employee = req.user.id;
        const filter = { employee };
        const before = req.query.before ? new Date(req.query.before) : null;
        if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

        const [notifications, unreadCount] = await Promise.all([
            EmployeeNotification.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE + 1).lean(),
            EmployeeNotification.countDocuments({ employee, readAt: null }),
        ]);

        return res.status(200).json({
            notifications: notifications.slice(0, PAGE_SIZE),
            hasMore: notifications.length > PAGE_SIZE,
            unreadCount,
        });
    } catch (error) {
        console.error("employeeNotificationsController.getMine:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudieron cargar tus notificaciones." });
    }
};

// PATCH /notifications/mine/read-all
employeeNotificationsController.markAllRead = async (req, res) => {
    try {
        await EmployeeNotification.updateMany({ employee: req.user.id, readAt: null }, { $set: { readAt: new Date() } });
        return res.status(200).json({ unreadCount: 0 });
    } catch (error) {
        console.error("employeeNotificationsController.markAllRead:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudieron marcar como leídas." });
    }
};

// PATCH /notifications/mine/:id/read
employeeNotificationsController.markRead = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ title: "No encontrada", message: "Esa notificación ya no existe." });
        }
        await EmployeeNotification.updateOne(
            { _id: req.params.id, employee: req.user.id, readAt: null },
            { $set: { readAt: new Date() } },
        );
        const unreadCount = await EmployeeNotification.countDocuments({ employee: req.user.id, readAt: null });
        return res.status(200).json({ unreadCount });
    } catch (error) {
        console.error("employeeNotificationsController.markRead:", error);
        return res.status(500).json({ title: "Error del servidor", message: "No se pudo marcar como leída." });
    }
};

export default employeeNotificationsController;
