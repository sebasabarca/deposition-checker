// Transactional email (address verification, password reset) through Resend's HTTP API. Settings
// come only from the environment: RESEND_API_KEY, EMAIL_FROM (an address on a domain verified in
// Resend) and APP_URL (where links point). In development, without RESEND_API_KEY, the message is
// printed to the server console instead, so the flows can be tried locally; in production that
// fallback is off, and a link is never logged.

export type Email = { to: string; subject: string; text: string; html: string };
export type Mailer = (email: Email) => Promise<void>;

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const production = () => process.env.NODE_ENV === "production";

export const resendMailer: Mailer = async (email) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    if (production()) throw new Error("Email isn't configured: set RESEND_API_KEY and EMAIL_FROM.");
    console.info(`[dev email, not sent] To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
  });
  // The response body may echo the message, so only the status is reported.
  if (!res.ok) throw new Error(`Resend refused the email (HTTP ${res.status}).`);
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// One plain layout for every message: a sentence, a button-like link, the same link as text, and why
// the reader got it.
function message(subject: string, lines: string[], action: { label: string; url: string } | null, footer: string): Email & { to: "" } {
  const text = [...lines, ...(action ? ["", `${action.label}: ${action.url}`] : []), "", footer].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f2f3f5;font-family:Helvetica,Arial,sans-serif;color:#151b26">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e1e4e9;border-radius:10px">
<tr><td style="padding:28px 32px 8px;font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#13213a">Veridict</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:22px">${lines.map((l) => `<p style="margin:0 0 14px">${escape(l)}</p>`).join("")}</td></tr>
${action ? `<tr><td style="padding:6px 32px 8px"><a href="${escape(action.url)}" style="display:inline-block;background:#13213a;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 18px;border-radius:6px">${escape(action.label)}</a></td></tr>
<tr><td style="padding:10px 32px 0;font-size:12px;line-height:18px;color:#4f5866;word-break:break-all">Or paste this link into your browser: ${escape(action.url)}</td></tr>` : ""}
<tr><td style="padding:18px 32px 28px;font-size:12px;line-height:18px;color:#6a7280">${escape(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { to: "", subject, text, html };
}

// Links carry the token after "#", so it never reaches a server log or a Referer header.
export const verifyEmail = (name: string, token: string) =>
  message("Verify your email for Veridict", [`Hi ${name},`, "Confirm this address to start adding depositions to Veridict. The link works once and expires in 24 hours."], { label: "Verify email", url: `${appUrl()}/#/verify?token=${token}` }, "You got this because someone created a Veridict account with this address. If it wasn't you, ignore this email and no account will be verified.");

export const alreadyRegistered = () =>
  message("You already have a Veridict account", ["Someone tried to create a Veridict account with this email address, which already has one.", "If it was you, sign in, or reset your password if you've forgotten it."], { label: "Sign in", url: `${appUrl()}/#/signin` }, "If it wasn't you, you can ignore this email. Your account hasn't changed.");

export const resetPassword = (name: string, token: string) =>
  message("Reset your Veridict password", [`Hi ${name},`, "Use this link to choose a new password. It works once and expires in 1 hour. Signing in with the new password signs you out everywhere else."], { label: "Choose a new password", url: `${appUrl()}/#/reset?token=${token}` }, "You got this because a password reset was requested for this address. If it wasn't you, ignore this email; your password hasn't changed.");

export const passwordChanged = (name: string) =>
  message("Your Veridict password was changed", [`Hi ${name},`, "Your password was just changed, and every other session was signed out.", "If you didn't do this, reset your password now."], { label: "Reset password", url: `${appUrl()}/#/forgot` }, "This is a security notice about your account.");

export const emailChanged = (name: string, newEmail: string) =>
  message("Your Veridict email is changing", [`Hi ${name},`, `The email on your Veridict account was changed to ${newEmail}. Messages will go there once it's verified.`, "If you didn't do this, reset your password now."], { label: "Reset password", url: `${appUrl()}/#/forgot` }, "This is a security notice about your account.");
