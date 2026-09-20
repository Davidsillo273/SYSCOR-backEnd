// Asistente de la pantalla de inicio de sesión.
//
// Es un asistente aparte del general (assistantChatController.js) y no un
// modo suyo, por una razón de seguridad: este endpoint es PÚBLICO — lo
// consulta gente que todavía no ha iniciado sesión — así que no puede tener
// ninguna herramienta ni acceso a datos del negocio. Solo explica cómo
// funciona el acceso al sistema.
//
// Todo lo que sabe está en el prompt: no consulta la base de datos, no
// confirma si un correo existe y no revela nada de la operación de la
// taquería.
import { handleChatWithTools } from "../../utils/chat/geminiUtils.js";

const loginHelpController = {};

// Si Gemini no responde, el usuario no se queda sin salida: se le da el
// mismo camino que daría el asistente.
const FALLBACK_REPLY =
  "No puedo responder en este momento. Si no logras entrar, escribe a " +
  "taqueriaelcorralsyscor@gmail.com o contacta a soporte por teléfono o WhatsApp.";

const SYSTEM_PROMPT = `Eres el asistente de la pantalla de inicio de sesión de SYSCOR, el sistema
de gestión de Taquería El Corral (El Salvador). Hablas con alguien que
TODAVÍA NO ha iniciado sesión.

TU ÚNICO TEMA es cómo entrar al sistema. Puedes explicar:

- Acceso de administrador: se entra con correo electrónico y contraseña.
- Acceso por CÓDIGO DE ACCESO: es de 6 caracteres y NO lo tienen todos los
  empleados. Solo lo recibe quien el administrador le ha dado al menos un
  permiso dentro del sistema; a esa persona se le envía su código por
  correo. Después de escribirlo, el sistema pide su contraseña.
  Si un empleado no tiene ningún permiso asignado, no tiene código y no
  puede entrar al sistema web: eso lo decide el administrador, no es un
  error que se pueda arreglar desde aquí.
- Contraseña olvidada: el enlace "¿Olvidó su contraseña?" envía un código de
  verificación al correo registrado; con ese código se define una contraseña
  nueva. El código tiene una vigencia corta, así que conviene usarlo pronto.
- Errores comunes: correo mal escrito, mayúsculas/minúsculas en la
  contraseña, el código de acceso se escribe sin espacios, y una cuenta
  puede estar inactiva (en ese caso solo el administrador puede reactivarla).
- Si el empleado no recuerda su código de acceso, debe pedírselo al
  administrador: tú NO puedes consultarlo ni generarlo. Tampoco puedes
  saber qué permisos tiene una persona ni si le corresponde un código.

REGLAS ESTRICTAS:

1. NO tienes acceso a ningún dato del sistema. No puedes consultar usuarios,
   ventas, pedidos, inventario, empleados ni nada de la operación. Si te
   preguntan por eso, responde que esa información solo está disponible
   dentro del sistema, después de iniciar sesión.
2. NUNCA confirmes ni niegues si un correo, un código o una cuenta existen.
   Tampoco pidas contraseñas ni códigos: si alguien te los escribe, dile que
   no los comparta con nadie y que los escriba solo en el formulario.
3. No inventes procedimientos, plazos ni números de teléfono que no estén
   aquí.
4. Si la pregunta no es sobre el inicio de sesión, dilo en una frase y
   reconduce al tema.
5. Cuando el problema no se resuelva con lo que sabes —cuenta inactiva,
   correo que ya no existe, el código no llega, o cualquier caso que necesite
   intervención humana— indícale claramente que contacte a soporte por
   teléfono, WhatsApp o al correo taqueriaelcorralsyscor@gmail.com.

Responde SIEMPRE en español, en tono cercano y breve (2 a 4 frases). Esto es
un chat, no un manual.`;

/**
 * Responde una duda sobre cómo iniciar sesión.
 *
 * Público a propósito (quien pregunta no tiene sesión), pero sin
 * herramientas: el modelo solo puede responder con lo que trae el prompt.
 */
loginHelpController.ask = async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        title: "Mensaje vacío",
        message: "Escribe tu duda sobre el inicio de sesión.",
      });
    }

    // Un mensaje larguísimo en un endpoint sin sesión es un desperdicio de
    // cuota (y una forma fácil de abusar del servicio).
    if (message.length > 500) {
      return res.status(400).json({
        title: "Mensaje muy largo",
        message: "Resume tu duda en pocas líneas, por favor.",
      });
    }

    // Solo se conservan los últimos turnos: aquí no hay sesión donde guardar
    // una conversación larga, y el contexto necesario es mínimo.
    const safeHistory = Array.isArray(history)
      ? history
          .slice(-6)
          .filter((h) => h && (h.role === "user" || h.role === "model") && Array.isArray(h.parts))
      : [];

    const result = await handleChatWithTools({
      history: safeHistory,
      message: message.trim(),
      systemPrompt: SYSTEM_PROMPT,
      // Sin herramientas: este asistente no puede tocar nada del sistema.
      tools: [],
    });

    // "empty" también cae aquí: sin herramientas, cualquier respuesta que no
    // sea texto es un fallo del modelo, no algo que el usuario deba ver.
    if (!result || result.type !== "text") {
      return res.status(200).json({ reply: FALLBACK_REPLY, history: safeHistory });
    }

    return res.status(200).json({
      reply: result.text || FALLBACK_REPLY,
      history: result.history || safeHistory,
    });
  } catch (error) {
    console.error("loginHelpController.ask:", error);
    return res.status(200).json({ reply: FALLBACK_REPLY, history: [] });
  }
};

export default loginHelpController;
