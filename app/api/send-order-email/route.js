import { Resend } from "resend";
import { NextResponse } from "next/server";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function orderEmailHtml({ orderId, total, lines }) {
  const rows = (lines || [])
    .map(
      (l) => `
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #f4f6f8; font-size:13px; color:#111417;">${esc(l.name)}</td>
          <td style="padding:10px 0; border-bottom:1px solid #f4f6f8; font-size:13px; color:#6e7276; text-align:center;">×${esc(l.qty)}</td>
          <td style="padding:10px 0; border-bottom:1px solid #f4f6f8; font-size:13px; color:#111417; text-align:right;">$${esc(l.price)}</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background:#f4f6f8; font-family:'IBM Plex Sans', Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8; padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border:1px solid #d5d8da; border-radius:2px; overflow:hidden;">

          <tr>
            <td style="background:#111417; padding:28px 32px;">
              <span style="font-family:Archivo, Helvetica, Arial, sans-serif; font-size:26px; letter-spacing:0.02em; color:#f9fafb;">MORPHEPS</span>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 32px 8px;">
              <p style="margin:0 0 4px; font-size:20px; font-weight:600; color:#111417;">Order confirmed</p>
              <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:#6e7276;">
                Order <span style="font-family:'IBM Plex Mono', ui-monospace, monospace; color:#111417;">${esc(orderId)}</span> is in. We will email tracking once it ships.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${rows}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 32px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #d5d8da;">
                <tr>
                  <td style="padding-top:14px; font-size:14px; font-weight:600; color:#111417;">Total</td>
                  <td style="padding-top:14px; font-size:14px; font-weight:600; color:#111417; text-align:right;">$${esc(total)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px; border-top:1px solid #d5d8da; background:#f4f6f8;">
              <p style="margin:0; font-family:'IBM Plex Mono', ui-monospace, monospace; font-size:11px; color:#6e7276;">
                Questions about this order? Reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function POST(request) {
  const body = await request.json();
  const { email, orderId, total, lines } = body || {};

  if (!email || !orderId) {
    return NextResponse.json({ ok: false, error: "email and orderId required" }, { status: 400 });
  }

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ ok: false, error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM,
      to: email,
      subject: `Order ${orderId} confirmed`,
      html: orderEmailHtml({ orderId, total, lines }),
    });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    return NextResponse.json({ ok: true, id: data?.id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
