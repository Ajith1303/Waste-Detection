/**
 * Notification service.
 *
 * Email:  primary channel via Nodemailer.
 *   - MAIL_MODE=smtp    -> real delivery (e.g. Gmail SMTP + app password)
 *   - MAIL_MODE=console -> prints a nicely formatted email to the terminal
 *                          (zero-config, perfect for the prototype)
 * SMS:    OPTIONAL. India requires DLT registration for transactional SMS
 *         templates (see README). Prototype logs to console by default; a
 *         Fast2SMS integration is included (SMS_MODE=fast2sms).
 *
 * Decision matrix (see services/classification.js for how it is reached):
 *   'illegal' -> alert ALL residents registered to the zone + admins
 *   'full'    -> alert admins ONLY
 *   'correct'/'near'/'no_waste' -> this service is never called
 */
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

/* ------------------------------- email ------------------------------------ */

function smtpConfigured() {
  // Real SMTP is only used when the operator EXPLICITLY opts in via
  // MAIL_MODE=smtp AND supplies real credentials. Placeholder values or an
  // unset flag must never make the system attempt real delivery.
  return (
    process.env.MAIL_MODE === 'smtp' &&
    !!process.env.SMTP_HOST &&
    (process.env.SMTP_USER || '').trim().length > 0 &&
    (process.env.SMTP_PASS || '').trim().length > 0 &&
    !/your_|yourmail|example/i.test(process.env.SMTP_USER + ' ' + process.env.SMTP_PASS)
  );
}

let mailer = null;
function getMailer() {
  if (!mailer) {
    const port = Number(process.env.SMTP_PORT || 587);
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return mailer;
}

/** Reset the cached mailer so the next getMailer() creates a fresh connection. */
function resetMailer() { mailer = null; }

function mapsUrl(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** Small inline-styled HTML email body including the snapshot and GPS link. */
function buildEmailHtml({ event, zone, alertLabel }) {
  const loc = event.gps_lat != null
    ? `GPS: <a href="${mapsUrl(event.gps_lat, event.gps_lng)}">${event.gps_lat.toFixed(6)}, ${event.gps_lng.toFixed(6)} (view on map)</a>`
    : 'GPS: not available (browser location not granted)';
  return `
  <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; border:1px solid #ddd; border-radius:8px; overflow:hidden;">
    <div style="background:#b91c1c; color:#fff; padding:14px 18px;">
      <h2 style="margin:0; font-size:18px;">${alertLabel}</h2>
      <div style="opacity:.9; font-size:13px;">Smart Waste Dumping Detection System</div>
    </div>
    <div style="padding:18px; font-size:14px; line-height:1.6;">
      <p>An event was detected at <b>${zone.name}</b> (${zone.area}).</p>
      <table cellpadding="6" style="border-collapse:collapse; width:100%;">
        <tr><td style="border-bottom:1px solid #eee;"><b>Classification</b></td><td>${event.classification}</td></tr>
        <tr><td style="border-bottom:1px solid #eee;"><b>Details</b></td><td>${event.reason || '-'}</td></tr>
        <tr><td style="border-bottom:1px solid #eee;"><b>Time</b></td><td>${event.created_at} UTC</td></tr>
        <tr><td style="border-bottom:1px solid #eee;"><b>Objects detected</b></td><td>${event.object_count}</td></tr>
        <tr><td style="border-bottom:1px solid #eee;"><b>Est. bin fill</b></td><td>${event.fill_estimate != null ? Math.round(event.fill_estimate * 100) + ' %' : '-'}</td></tr>
        <tr><td><b>Location</b></td><td>${loc}</td></tr>
      </table>
      <p style="margin-top:16px; color:#666; font-size:12px;">The camera snapshot is attached to this email.<br/>
      Audit trail: Admin Dashboard -> Events.</p>
    </div>
  </div>`;
}
/**
 * Send one email. Returns 'sent' (real SMTP), 'console' (fake), or throws.
 */
async function sendEmail({ to, subject, html, snapshotAttachment }) {
  if (smtpConfigured()) {
    const msg = {
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, html,
      attachments: snapshotAttachment ? [snapshotAttachment] : [],
    };
    try {
      await getMailer().sendMail(msg);
      return 'sent';
    } catch (err) {
      // Stale / broken connection — reset transport and retry once.
      console.warn('[email] first attempt failed:', err.message, '— retrying...');
      resetMailer();
      await getMailer().sendMail(msg);
      return 'sent';      // second attempt succeeded
    }
  }
  console.log('\n==================== [EMAIL - console mode] ====================');
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log('---------');
  console.log(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500));
  if (snapshotAttachment) console.log(`Attachment: ${snapshotAttachment.path}`);
  console.log('=================================================================\n');
  return 'console';
}

function getSnapshotAttachment(event) {
  if (!event.snapshot_path) return null;
  const p = path.join(UPLOAD_DIR, path.basename(event.snapshot_path));
  return fs.existsSync(p) ? { filename: path.basename(p), path: p } : null;
}

/* --------------------------------- SMS ------------------------------------ */

/**
 * Send an SMS. OPTIONAL channel (Fast2SMS is stubbed; India requires DLT
 * registration - see README). Console mode is the default.
 */
async function sendSms(phone, message) {
  if (!phone) return 'skipped';
  if (process.env.SMS_MODE === 'fast2sms' && process.env.FAST2SMS_API_KEY) {
    try {
      const resp = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          authorization: process.env.FAST2SMS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          route: 'q',
          language: 'english',
          numbers: String(phone).replace(/[^\d]/g, ''),
          message,
        }),
      });
      const json = await resp.json();
      return json.return ? 'sent' : 'failed';
    } catch (err) {
      console.warn('[sms] Fast2SMS error:', err.message);
      return 'failed';
    }
  }
  console.log(`\n[SMS - console mode] To: ${phone} | Msg: ${message}\n`);
  return 'console';
}
/* ------------------------------ dispatch ---------------------------------- */

/**
 * Dispatch notifications for a stored event.
 * Called ONLY for 'illegal' and 'full' classifications by routes/frames.js.
 *   illegal -> residents (zone) + admins (zone, else global fallback)
 *   full    -> admins only
 */
async function notify(zone, event) {
  const type = event.classification;

  // Admin contacts for this zone, falling back to global (zone_id NULL)
  // admins so alerts never silently fail.
  const zoneAdmins = db.prepare('SELECT * FROM admins WHERE zone_id = ?').all(zone.id);
  const fallbackAdmins = zoneAdmins.length
    ? []
    : db.prepare('SELECT * FROM admins WHERE zone_id IS NULL').all();
  const admins = [...zoneAdmins, ...fallbackAdmins];

  // Residents only care about illegal dumping in their vicinity.
  const residents = db.prepare('SELECT * FROM residents WHERE zone_id = ?').all(zone.id);

  const attachment = getSnapshotAttachment(event);
  const out = { emails: [], sms: [] };
  const alertLabel = type === 'illegal' ? 'Illegal Waste Dumping Detected' : 'Dustbin Full';

  if (type === 'illegal') {
    for (const r of residents) {
      const html = buildEmailHtml({ event, zone, alertLabel });
      const emailStatus = await sendEmail({
        to: r.email,
        subject: `${alertLabel} near ${zone.name}, ${zone.area}`,
        html,
        snapshotAttachment: attachment,
      });
      out.emails.push({ kind: 'resident', to: r.email, name: r.name, status: emailStatus });
      out.sms.push({
        kind: 'resident',
        to: r.phone,
        status: await sendSms(r.phone, `Alert: Illegal waste dumping detected near ${zone.name}, ${zone.area}. Please check and report. - Smart Waste System`),
      });
    }
  }

  for (const a of admins) {
    const html = buildEmailHtml({ event, zone, alertLabel });
    const emailStatus = await sendEmail({
      to: a.email,
      subject: `${alertLabel} - ${zone.name} (${zone.area})`,
      html,
      snapshotAttachment: attachment,
    });
    out.emails.push({ kind: 'admin', to: a.email, name: a.name, status: emailStatus });
    out.sms.push({
      kind: 'admin',
      to: a.phone,
      status: await sendSms(a.phone, `${alertLabel} at ${zone.name}, ${zone.area}. See admin dashboard. - Smart Waste System`),
    });
  }

  out.status = out.emails.every((e) => e.status === 'sent' || e.status === 'console')
    ? 'sent'
    : 'partial_failure';
  return out;
}

/**
 * Persist the notification outcome on the event row and return a short status.
 */
function recordNotification(eventId, notification) {
  const status =
    notification.status === 'sent'
      ? 'sent'
      : notification.status === 'cooldown'
      ? 'cooldown_skipped'
      : 'failed';
  db.prepare(
    'UPDATE events SET notification_status = ?, notification_detail = ? WHERE id = ?'
  ).run(status, JSON.stringify(notification).slice(0, 2000), eventId);
  return { ...notification, status };
}

module.exports = { notify, recordNotification, smtpConfigured };