import { loadChatOrder, conversationFor, markChatRead, postChatMessage } from "../../utils/orders/orderChatUtils.js";
import { suggestDriverMessages } from "../../utils/panchita/panchitaUtils.js";

// Chat directo cliente <-> repartidor de un pedido a domicilio. La lógica
// vive en utils/orders/orderChatUtils.js (Panchita también la usa).
const orderChatController = {};

// GET /orders/chat/:orderId
// Devuelve la conversación y la marca como leída para quien la pide. La app
// la vuelve a pedir cada pocos segundos mientras el chat está abierto.
orderChatController.getConversation = async (req, res) => {
  try {
    const { order, side, code, error } = await loadChatOrder(req.params.orderId, req.user);
    if (error) return res.status(code).json({ title: "Chat no disponible", message: error });

    await markChatRead(order, side);
    const conversation = conversationFor(order, side);
    // Mensajes de un toque, solo para el cliente.
    if (side === "customer" && conversation.open) {
      conversation.quickMessages = suggestDriverMessages(order, order.eta);
    }
    return res.json(conversation);
  } catch (err) {
    console.error("orderChat.getConversation:", err);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo cargar el chat." });
  }
};

// POST /orders/chat/:orderId  { text, preset? }
orderChatController.postMessage = async (req, res) => {
  try {
    const { order, side, code, error } = await loadChatOrder(req.params.orderId, req.user);
    if (error) return res.status(code).json({ title: "Chat no disponible", message: error });

    const result = await postChatMessage(order, side, req.body?.text, { preset: !!req.body?.preset });
    if (result.error) return res.status(400).json({ title: "No se envió", message: result.error });
    return res.status(201).json({ message: result.message });
  } catch (err) {
    console.error("orderChat.postMessage:", err);
    return res.status(500).json({ title: "Error del servidor", message: "No se pudo enviar el mensaje." });
  }
};

export default orderChatController;
