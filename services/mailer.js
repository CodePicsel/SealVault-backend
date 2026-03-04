let nodemailer = null;
try {
  // Optional dependency. If unavailable, service automatically uses mock mode.
  nodemailer = require('nodemailer');
} catch (err) {
  nodemailer = null;
}

function buildTransport() {
  if (!nodemailer) return { mode: 'mock', transporter: null };

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!host || !user || !pass) return { mode: 'mock', transporter: null };

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
  return { mode: 'smtp', transporter };
}

async function sendMail({ to, subject, text, html }) {
  const toList = Array.isArray(to) ? to : [to];
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@sealvault.local';
  const { mode, transporter } = buildTransport();

  if (mode === 'mock') {
    const mockId = `mock-${Date.now()}`;
    console.log('[MOCK_EMAIL]', JSON.stringify({ to: toList, subject, text, html }, null, 2));
    return {
      mode: 'mock',
      messageId: mockId,
      accepted: toList,
      rejected: []
    };
  }

  const info = await transporter.sendMail({
    from,
    to: toList.join(', '),
    subject,
    text,
    html
  });

  return {
    mode: 'smtp',
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || []
  };
}

module.exports = {
  sendMail
};
