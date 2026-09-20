import Mailjet from "node-mailjet";
import crypto from "crypto";
import jsonwebtoken from "jsonwebtoken";
import { config } from "../../../config.js";

// ─── Token & Code ────────────────────────────────────────────────────────────

const generateVerificationCode = () => {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
};

const generateToken = (payload, expiresIn = "15m") => {
  return jsonwebtoken.sign(payload, config.jwt.secret, { expiresIn });
};

const verifyToken = (token) => {
  return jsonwebtoken.verify(token, config.jwt.secret);
};

// ─── Mailer ──────────────────────────────────────────────────────────────────
// Usamos la API HTTP de Mailjet en vez de Nodemailer/SMTP porque Render
// bloquea los puertos 465 y 587 en producción.

const mailjet = Mailjet.apiConnect(
  config.mailjet.apiKey,
  config.mailjet.secretKey
);

const sendEmail = async (to, subject, html) => {
  try {
    const result = await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: config.mailjet.fromEmail,
            Name: config.mailjet.fromName,
          },
          To: [{ Email: to }],
          Subject: subject,
          HTMLPart: html,
        },
      ],
    });

    return result.body;
  } catch (error) {
    console.error("sendEmail error:", error.response?.body || error.message);
    throw new Error("No se pudo enviar el correo de verificación.");
  }
};

// ─── HTML Templates ──────────────────────────────────────────────────────────

// Identidad de los correos (rediseño editorial). El logo vive en Cloudinary
// porque un cliente de correo no puede leer archivos del servidor ni del
// frontend: tiene que ser una URL pública y estable.
const EMAIL_LOGO_URL =
  "https://res.cloudinary.com/ddisnfuwo/image/upload/v1789531574/TaqueriaElCorralSyscor/brand/syscor-logo-email.png";

// Los correos van SIEMPRE en modo claro: el modo oscuro del sistema no
// aplica aquí, porque cada cliente de correo renderiza a su manera y un
// fondo oscuro se rompe en la mitad de ellos.
const EMAIL_INK = "#292b31";
const EMAIL_INK_2 = "#3f424d";
const EMAIL_MUTED = "#75798c";
const EMAIL_LINE = "#e4e7f5";
const EMAIL_SURFACE = "#ffffff";
const EMAIL_PAGE = "#f3f5fe";
const EMAIL_AC = "#a33527";

// Encabezado común: logo, nombre del sistema y el local. Se repite en las
// dos plantillas del flujo de contraseña, así que se declara una vez.
const emailHeader = () => `
          <tr>
            <td style="padding:22px 32px;border-bottom:1px solid ${EMAIL_LINE};">
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="padding-right:12px;vertical-align:middle;">
                    <img src="${EMAIL_LOGO_URL}" width="40" alt=""
                         style="display:block;width:40px;height:auto;border:0;">
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:17px;font-weight:600;letter-spacing:3px;color:${EMAIL_INK};">SYSCOR</span>
                    <span style="font-size:13px;color:${EMAIL_MUTED};padding-left:10px;">Taquería El Corral</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;

// Pie común.
const emailFooter = () => `
          <tr>
            <td style="padding:16px 32px;border-top:1px solid ${EMAIL_LINE};">
              <p style="margin:0;color:${EMAIL_MUTED};font-size:12px;">© ${new Date().getFullYear()} Taquería El Corral · SYSCOR</p>
            </td>
          </tr>`;

// Envoltorio de la tarjeta.
const emailShell = (inner) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${EMAIL_PAGE};font-family:Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:40px 12px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" role="presentation"
               style="max-width:520px;width:100%;background:${EMAIL_SURFACE};border:1px solid ${EMAIL_LINE};">
${emailHeader()}
${inner}
${emailFooter()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const htmlVerificationEmail = (code) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0"
               style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <tr>
            <td style="background:#B22222;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;">🌮 SYSCOR</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Taquería El Corral</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 48px;text-align:center;">
              <h2 style="margin:0 0 12px;color:#1a1a1a;font-size:20px;">Verifica tu correo</h2>
              <p style="margin:0 0 32px;color:#555;font-size:15px;line-height:1.6;">
                Usa el siguiente código para completar tu registro. Expira en <strong>15 minutos</strong>.
              </p>
              <div style="display:inline-block;background:#f9f1e7;border:2px dashed #B22222;
                          border-radius:8px;padding:20px 48px;margin-bottom:32px;">
                <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#B22222;">
                  ${code}
                </span>
              </div>
              <p style="margin:0;color:#888;font-size:13px;">
                Si no solicitaste esto, puedes ignorar este mensaje.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#fafafa;padding:16px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">© 2025 Taquería El Corral · SYSCOR</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const htmlRecoveryEmail = (code) => emailShell(`
          <tr>
            <td style="padding:34px 32px;">
              <div style="width:34px;height:2px;background:${EMAIL_AC};margin-bottom:18px;"></div>
              <h2 style="margin:0 0 10px;color:${EMAIL_INK};font-size:21px;font-weight:600;">Recuperación de contraseña</h2>
              <p style="margin:0 0 22px;color:${EMAIL_INK_2};font-size:14px;line-height:1.6;">
                Usa este código para restablecer tu contraseña. Expira en <strong style="color:${EMAIL_INK};">15 minutos</strong>.
              </p>
              <!-- El código es lo único que hay que leer aquí, así que va en
                   monoespaciada, grande y con la barra de acento al costado. -->
              <table cellpadding="0" cellspacing="0" role="presentation" width="100%">
                <tr>
                  <td style="background:${EMAIL_PAGE};border-left:3px solid ${EMAIL_AC};padding:20px 24px;">
                    <span style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:${EMAIL_INK};">${code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0;color:${EMAIL_MUTED};font-size:12.5px;line-height:1.6;">
                Si no solicitaste este cambio, ignora este mensaje.
              </p>
            </td>
          </tr>`);

/**
 * Email con el código de acceso. Se manda una sola vez, cuando el empleado
 * ya tiene contraseña propia Y el admin le otorgó al menos un permiso (ver
 * employeeController.updateEmployee e inviteEmployeeController.acceptInvitation).
 * Este código reemplaza al correo en el login: el empleado entra con
 * código + contraseña en vez de correo + contraseña.
 */
const htmlAccessCodeEmail = (code) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0"
               style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <tr>
            <td style="background:#B22222;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;">🌮 SYSCOR</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Taquería El Corral</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 48px;text-align:center;">
              <h2 style="margin:0 0 12px;color:#1a1a1a;font-size:20px;">Se te otorgaron permisos en el sistema</h2>
              <p style="margin:0 0 32px;color:#555;font-size:15px;line-height:1.6;">
                Usa este código de acceso junto con tu contraseña para iniciar sesión.
                Guárdalo en un lugar seguro: es personal e intransferible.
              </p>
              <div style="display:inline-block;background:#f9f1e7;border:2px dashed #B22222;
                          border-radius:8px;padding:20px 48px;margin-bottom:32px;">
                <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#B22222;">
                  ${code}
                </span>
              </div>
              <p style="margin:0;color:#888;font-size:13px;">
                Si crees que esto es un error, contacta a un administrador.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#fafafa;padding:16px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">© 2025 Taquería El Corral · SYSCOR</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

/**
 * Email de invitación. Usado cuando un Admin invita a otro Admin o a un
 * Empleado a unirse a SYSCOR. El link lleva un token firmado que el
 * destinatario usa para completar su propio registro (set password, etc.).
 *
 * @param {string} link - URL de aceptación de invitación, con el token como query param.
 * @param {string} roleLabel - Texto a mostrar para el rol invitado (ej. "Administrador", "Empleado").
 */
const htmlInvitationEmail = (link, roleLabel) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0"
               style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <tr>
            <td style="background:#B22222;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;">🌮 SYSCOR</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Taquería El Corral</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 48px;text-align:center;">
              <h2 style="margin:0 0 12px;color:#1a1a1a;font-size:20px;">Has sido invitado</h2>
              <p style="margin:0 0 32px;color:#555;font-size:15px;line-height:1.6;">
                Fuiste invitado a unirte a SYSCOR como <strong style="color:#B22222;">${roleLabel}</strong>.
                Haz clic en el botón para completar tu registro. Este enlace expira en <strong>24 horas</strong>.
              </p>
              <a href="${link}" target="_blank"
                 style="display:inline-block;background:#B22222;color:#fff;
                        text-decoration:none;font-weight:700;font-size:15px;border-radius:8px;
                        padding:16px 40px;margin-bottom:24px;">
                Completar registro
              </a>
              <p style="margin:0;color:#888;font-size:13px;">
                Si no esperabas esta invitación, puedes ignorar este correo.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#fafafa;padding:16px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">© 2025 Taquería El Corral · SYSCOR</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

/**
 * Email para cuando un admin dispara, desde la ficha del empleado, un cambio
 * de contraseña: el empleado recibe el enlace y es quien la define, el admin
 * nunca llega a verla ni a escribirla por él.
 *
 * @param {string} link - URL para definir la nueva contraseña, con el token como query param.
 */
const htmlPasswordResetInvitationEmail = (link) => emailShell(`
          <tr>
            <td style="padding:34px 32px;">
              <div style="width:34px;height:2px;background:${EMAIL_AC};margin-bottom:18px;"></div>
              <h2 style="margin:0 0 10px;color:${EMAIL_INK};font-size:21px;font-weight:600;">Cambio de contraseña solicitado</h2>
              <p style="margin:0 0 22px;color:${EMAIL_INK_2};font-size:14px;line-height:1.6;">
                Un administrador solicitó un cambio de contraseña para tu cuenta. Define una
                nueva desde el siguiente enlace. Expira en <strong style="color:${EMAIL_INK};">24 horas</strong>.
              </p>
              <!-- Botón de contorno (el relleno pleno se reserva para el
                   sistema); va en tabla para que Outlook lo respete. -->
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border:1px solid ${EMAIL_AC};">
                    <a href="${link}" target="_blank"
                       style="display:inline-block;padding:13px 26px;color:${EMAIL_AC};
                              text-decoration:none;font-size:14px;font-weight:600;">
                      Definir nueva contraseña
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0;color:${EMAIL_MUTED};font-size:12.5px;line-height:1.6;">
                Si no esperabas este correo, ignóralo: tu contraseña actual seguirá funcionando.
              </p>
            </td>
          </tr>`);

export default {
  generateVerificationCode,
  generateToken,
  verifyToken,
  sendEmail,
  htmlVerificationEmail,
  htmlRecoveryEmail,
  htmlInvitationEmail,
  htmlPasswordResetInvitationEmail,
  htmlAccessCodeEmail,
};