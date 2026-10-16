import { Schema, model } from "mongoose";

const cashierWaiterCallSchema = new Schema(
    {
        deviceId: { type: String, required: true, index: true },
        session: { type: Schema.Types.ObjectId, ref: "CashSession", required: true },
        assignedWaiter: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
        triedWaiters: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
        status: {
            type: String,
            enum: ["pending", "acknowledged", "unanswered", "cancelled"],
            default: "pending",
            index: true,
        },
        respondBy: { type: Date, required: true, index: true },
        acknowledgedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

cashierWaiterCallSchema.index(
    { deviceId: 1 },
    { unique: true, partialFilterExpression: { status: "pending" } },
);
cashierWaiterCallSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export default model("CashierWaiterCall", cashierWaiterCallSchema);
