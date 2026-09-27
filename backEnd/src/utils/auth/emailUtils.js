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
    throw new Error("No se pudo enviar el correo.");
  }
};

// ─── HTML Templates ──────────────────────────────────────────────────────────

// Identidad de los correos (rediseño editorial alineado al dashboard). 
const EMAIL_LOGO_URL =
  "https://res.cloudinary.com/ddisnfuwo/image/upload/v1789531574/TaqueriaElCorralSyscor/brand/syscor-logo-email.png";

// Colores extraídos del diseño del sistema (image_df559c.png)
const EMAIL_INK = "#1a1a1a"; // Texto principal oscuro
const EMAIL_INK_2 = "#4b5563"; // Texto secundario
const EMAIL_MUTED = "#8b92a5"; // Texto silenciado (ej. subtítulos)
const EMAIL_LINE = "#e5e7eb"; // Líneas sutiles de bordes
const EMAIL_SURFACE = "#ffffff"; // Fondo de la tarjeta
const EMAIL_PAGE = "#f9fafb"; // Fondo general sutil
const EMAIL_AC = "#a33527"; // Rojo oscuro/granate de acento

// Encabezado común: logo, nombre del sistema y el local.
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
            <td style="padding:16px 32px;border-top:1px solid ${EMAIL_LINE};background:${EMAIL_PAGE};">
              <p style="margin:0;color:${EMAIL_MUTED};font-size:12px;">© ${new Date().getFullYear()} Taquería El Corral · SYSCOR</p>
            </td>
          </tr>`;

// Envoltorio de la tarjeta (Plantilla principal unificada).
const emailShell = (inner) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${EMAIL_PAGE};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:40px 12px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" role="presentation"
               style="max-width:520px;width:100%;background:${EMAIL_SURFACE};border:1px solid ${EMAIL_LINE};border-radius:6px;overflow:hidden;box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
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

/**
 * Plantilla: Verificación de correo
 */
const htmlVerificationEmail = (code) => emailShell(`
          <tr>
            <td style="padding:34px 32px;">
              <div style="width:34px;height:2px;background:${EMAIL_AC};margin-bottom:18px;"></div>
              <h2 style="margin:0 0 10px;color:${EMAIL_INK};font-size:21px;font-weight:600;">Verifica tu correo</h2>
              <p style="margin:0 0 22px;color:${EMAIL_INK_2};font-size:14px;line-height:1.6;">
                Usa el siguiente código para completar tu registro. Expira en <strong style="color:${EMAIL_INK};">15 minutos</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation" width="100%">
                <tr>
                  <td style="background:${EMAIL_PAGE};border-left:3px solid ${EMAIL_AC};padding:20px 24px;">
                    <span style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:${EMAIL_INK};">${code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0;color:${EMAIL_MUTED};font-size:12.5px;line-height:1.6;">
                Si no solicitaste esto, puedes ignorar este mensaje.
              </p>
            </td>
          </tr>`);

/**
 * Plantilla: Recuperación de contraseña
 */
const htmlRecoveryEmail = (code) => emailShell(`
          <tr>
            <td style="padding:34px 32px;">
              <div style="width:34px;height:2px;background:${EMAIL_AC};margin-bottom:18px;"></div>
              <h2 style="margin:0 0 10px;color:${EMAIL_INK};font-size:21px;font-weight:600;">Recuperación de contraseña</h2>
              <p style="margin:0 0 22px;color:${EMAIL_INK_2};font-size:14px;line-height:1.6;">
                Usa este código para restablecer tu contraseña. Expira en <strong style="color:${EMAIL_INK};">15 minutos</strong>.
              </p>
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
 * Plantilla: Código de acceso para empleados
 */
const htmlAccessCodeEmail = (code) => emailShell(`
          <tr>
            <td style="padding:34px 32px;">
              <div style="width:34px;height:2px;background:${EMAIL_AC};margin-bottom:18px;"></div>
              <h2 style="margin:0 0 10px;color:${EMAIL_INK};font-size:21px;font-weight:600;">Se te otorgaron permisos en el sistema</h2>
              <p style="margin:0 0 22px;color:${EMAIL_INK_2};font-size:14px;line-height:1.6;">
                Usa este código de acceso junto con tu contraseña para iniciar sesión. 
                Guárdalo en un lugar seguro: es personal e intransferible.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation" width="100%">
                <tr>
                  <td style="background:${EMAIL_PAGE};border-left:3px solid ${EMAIL_AC};padding:20px 24px;">
                    <span style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:${EMAIL_INK};">${code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0;color:${EMAIL_MUTED};font-size:12.5px;line-height:1.6;">
                Si crees que esto es un error, contacta a un administrador.
              </p>
            </td>
          </tr>`);

/**
 * Plantilla: Invitación al sistema
 */
const htmlInvitationEmail = (link, roleLabel) => emailShell(`
          <tr>
            <td style="padding:34px 32px;">
              <div style="width:34px;height:2px;background:${EMAIL_AC};margin-bottom:18px;"></div>
              <h2 style="margin:0 0 10px;color:${EMAIL_INK};font-size:21px;font-weight:600;">Has sido invitado</h2>
              <p style="margin:0 0 22px;color:${EMAIL_INK_2};font-size:14px;line-height:1.6;">
                Fuiste invitado a unirte a SYSCOR como <strong style="color:${EMAIL_INK};">${roleLabel}</strong>.
                Haz clic en el botón para completar tu registro. Este enlace expira en <strong style="color:${EMAIL_INK};">24 horas</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border:1px solid ${EMAIL_AC}; border-radius: 4px; background: ${EMAIL_AC};">
                    <a href="${link}" target="_blank"
                       style="display:inline-block;padding:12px 24px;color:#ffffff;
                              text-decoration:none;font-size:14px;font-weight:600;">
                      Completar registro
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0;color:${EMAIL_MUTED};font-size:12.5px;line-height:1.6;">
                Si no esperabas esta invitación, puedes ignorar este correo.
              </p>
            </td>
          </tr>`);

/**
 * Plantilla: Invitación a restablecer contraseña por un administrador
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
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border:1px solid ${EMAIL_AC}; border-radius: 4px;">
                    <a href="${link}" target="_blank"
                       style="display:inline-block;padding:12px 24px;color:${EMAIL_AC};
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