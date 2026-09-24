const nodemailer = require('nodemailer');
const crypto = require('crypto');

let transporter = null;
let transporterKey = '';
function secret(value) { if (!value || !String(value).startsWith('enc:')) return value || ''; try { const [, iv, tag, data] = String(value).split(':'); const key = crypto.createHash('sha256').update(process.env.JWT_SECRET || 'softy-email-settings-key').digest(); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); decipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'); } catch { return ''; } }

function getTransporter(emailSettings = {}) {
  const emailUser = secret(emailSettings.smtpUser) || process.env.GMAIL_USER;
  const emailPass = secret(emailSettings.smtpPassword) || process.env.GMAIL_APP_PASSWORD;
  const key = `${emailUser}:${emailPass}`;
  if (transporter && transporterKey === key) return transporter;

  if (!emailUser || !emailPass) {
    console.warn('[Email] GMAIL_USER or GMAIL_APP_PASSWORD not set. Emails will not be sent.');
    return null;
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPass,
    },
  });
  transporterKey = key;

  return transporter;
}

function formatPrice(n) {
  return `BDT ${Number(n || 0).toLocaleString('en-BD')}`;
}

function orderConfirmationEmail(order, settings = {}) {
  const customerName = order.shippingInfo?.name || order.customerName || 'Customer';
  const orderId = order.orderId || order._id?.slice(-8)?.toUpperCase() || '';
  const items = order.items || order.orderItems || [];
  const address = order.shippingInfo || {};
  const contact = settings.contact || order.siteSettings?.contact || {};
  const contactEmail = contact.email || 'globalcosmeticslines@gmail.com';
  const contactPhone = contact.phone || '01911-238421';

  const addressParts = [
    address.address,
    address.city,
    address.district,
  ].filter(Boolean).join(', ');

  const itemRows = items.map((item) => {
    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;font-size:14px;color:#333;">
          ${item.name || 'Product'}
          ${item.color ? `<span style="color:#888;font-size:12px;"> | Color: ${item.color}</span>` : ''}
        </td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;font-size:14px;color:#333;text-align:center;">${item.quantity || item.qty || 1}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;font-size:14px;color:#333;text-align:right;">${formatPrice(item.price * (item.quantity || item.qty || 1))}</td>
      </tr>`;
  }).join('');

  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:0;background:#f7f2ea;font-family:'Helvetica Neue',Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2ea;padding:40px 20px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

            <!-- Header -->
            <tr>
              <td style="background:#4E1520;padding:32px 40px;text-align:center;">
                <h1 style="margin:0;color:#F7F2EA;font-size:24px;letter-spacing:3px;font-weight:700;">SOFTY</h1>
                <p style="margin:6px 0 0;color:#EBC9DD;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Gentle care for real skin</p>
              </td>
            </tr>

            <!-- Success Badge -->
            <tr>
              <td style="padding:32px 40px 0;text-align:center;">
                <div style="width:64px;height:64px;border-radius:50%;background:#ecfdf5;display:inline-flex;align-items:center;justify-content:center;">
                  <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="#16a34a" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
                  </svg>
                </div>
                <h2 style="margin:16px 0 4px;font-size:22px;color:#1a1a1a;font-weight:700;">Order Confirmed!</h2>
                <p style="margin:0;font-size:14px;color:#666;">Thank you for your order, <strong>${customerName}</strong></p>
              </td>
            </tr>

            <!-- Order ID -->
            <tr>
              <td style="padding:24px 40px 0;text-align:center;">
                <div style="background:#f7f2ea;border-radius:8px;padding:16px;display:inline-block;">
                  <p style="margin:0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1.5px;">Order ID</p>
                  <p style="margin:4px 0 0;font-size:18px;color:#4E1520;font-weight:700;font-family:monospace;">#${orderId}</p>
                </div>
              </td>
            </tr>

            <!-- Items -->
            <tr>
              <td style="padding:28px 40px 0;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Order Items</h3>
                <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
                  <thead>
                    <tr style="background:#fafafa;">
                      <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
                      <th style="padding:10px 16px;text-align:center;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
                      <th style="padding:10px 16px;text-align:right;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemRows}
                  </tbody>
                </table>
              </td>
            </tr>

            <!-- Price Breakdown -->
            <tr>
              <td style="padding:20px 40px 0;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#666;">Subtotal</td>
                    <td style="padding:6px 0;font-size:14px;color:#333;text-align:right;">${formatPrice(order.subtotal)}</td>
                  </tr>
                  ${order.discount > 0 ? `
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#16a34a;">Discount${order.couponCode ? ` (${order.couponCode})` : ''}</td>
                    <td style="padding:6px 0;font-size:14px;color:#16a34a;text-align:right;">-${formatPrice(order.discount)}</td>
                  </tr>` : ''}
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#666;">Delivery</td>
                    <td style="padding:6px 0;font-size:14px;color:${order.deliveryCharge === 0 ? '#16a34a' : '#333'};text-align:right;">${order.deliveryCharge === 0 ? 'Free' : formatPrice(order.deliveryCharge)}</td>
                  </tr>
                  <tr>
                    <td colspan="2"><hr style="border:none;border-top:1px solid #eee;margin:8px 0;"></td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;font-size:16px;color:#1a1a1a;font-weight:700;">Total</td>
                    <td style="padding:4px 0;font-size:18px;color:#4E1520;font-weight:700;text-align:right;">${formatPrice(order.total)}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Shipping Info -->
            <tr>
              <td style="padding:24px 40px 0;">
                <div style="background:#fafafa;border-radius:8px;padding:20px;">
                  <h3 style="margin:0 0 10px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Shipping Details</h3>
                  <p style="margin:0;font-size:14px;color:#333;line-height:1.6;">
                    ${customerName}<br>
                    ${address.phone ? `${address.phone}<br>` : ''}
                    ${addressParts || ''}
                    ${address.note ? `<br><em style="color:#888;">"${address.note}"</em>` : ''}
                  </p>
                </div>
              </td>
            </tr>

            <!-- Payment -->
            <tr>
              <td style="padding:20px 40px 0;">
                <div style="background:#fafafa;border-radius:8px;padding:20px;">
                  <h3 style="margin:0 0 10px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Payment</h3>
                  <p style="margin:0;font-size:14px;color:#333;">
                    Method: <strong style="text-transform:capitalize;">${order.paymentMethod || 'Cash on Delivery'}</strong>
                  </p>
                  ${order.bkashTrxId || order.bkashTransactionId ? `
                  <p style="margin:4px 0 0;font-size:13px;color:#666;">
                    bKash Trx ID: <strong>${order.bkashTrxId || order.bkashTransactionId}</strong>
                  </p>` : ''}
                </div>
              </td>
            </tr>

            <!-- Track Order Button -->
            <tr>
              <td style="padding:28px 40px;text-align:center;">
                <a href="${process.env.FRONTEND_URL || 'http://localhost:1001'}/track-order?orderId=${orderId}"
                   style="display:inline-block;background:#4E1520;color:#fff;padding:14px 36px;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;border-radius:6px;">
                  Track Your Order
                </a>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background:#fafafa;padding:24px 40px;text-align:center;border-top:1px solid #eee;">
                <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
                  Questions? Contact us at <a href="mailto:${contactEmail}" style="color:#4E1520;text-decoration:none;">${contactEmail}</a><br>
                  or call <strong>${contactPhone}</strong>
                </p>
                <p style="margin:12px 0 0;font-size:11px;color:#bbb;">&copy; ${new Date().getFullYear()} Softy, a Global Cosmetics Lines brand.</p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

async function sendOrderConfirmation(order, settings = {}) {
  const emailSettings = settings.emailSettings || {};
  if (emailSettings.enabled === false) return false;
  const transport = getTransporter(emailSettings);
  if (!transport) return false;
  const senderEmail = secret(emailSettings.smtpUser) || process.env.GMAIL_USER;

  const email = order.shippingInfo?.email || order.email;
  const forwardingEmail = emailSettings.forwardingEnabled === false ? '' : emailSettings.forwardingEmail;
  if (!email && !forwardingEmail) {
    console.warn('[Email] No email address for order, skipping confirmation.');
    return false;
  }

  const orderId = order.orderId || order._id?.slice(-8)?.toUpperCase() || '';

  try {
    await transport.sendMail({
      from: `"${emailSettings.senderName || 'Softy'}" <${senderEmail}>`,
      to: email || forwardingEmail,
      ...(email && forwardingEmail && email !== forwardingEmail ? { bcc: forwardingEmail } : {}),
      ...(emailSettings.replyTo ? { replyTo: emailSettings.replyTo } : {}),
      subject: `Order Confirmed #${orderId} - Softy`,
      html: orderConfirmationEmail(order, settings),
    });
    console.log(`[Email] Order confirmation sent to ${email} for order #${orderId}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send confirmation to ${email}:`, err.message);
    return false;
  }
}

module.exports = { sendOrderConfirmation };
