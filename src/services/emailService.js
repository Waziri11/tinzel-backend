import nodemailer from 'nodemailer';

let transporterInstance = null;

/**
 * Checks whether live SMTP credentials are provided in the environment.
 */
export const isEmailConfigured = () => {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
};

/**
 * Creates or returns the cached Nodemailer transporter.
 */
export const getTransporter = () => {
  if (transporterInstance) {
    return transporterInstance;
  }

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const isSecure = process.env.SMTP_SECURE !== undefined
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;

  transporterInstance = nodemailer.createTransport({
    host,
    port,
    secure: isSecure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Useful timeout options for production stability
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 15000,
  });

  return transporterInstance;
};

/**
 * Base email layout using clean, flat styling.
 * Strictly adheres to design rules: No CSS gradients, no emojis.
 */
export const wrapEmailTemplate = ({ title, contentHtml, callToAction }) => {
  const ctaButtonHtml = callToAction && callToAction.url
    ? `
      <div style="margin: 28px 0; text-align: center;">
        <a href="${callToAction.url}"
           style="display: inline-block; background-color: #0f172a; color: #ffffff; padding: 12px 24px; font-weight: 600; font-size: 14px; text-decoration: none; border-radius: 4px;">
          ${callToAction.label}
        </a>
      </div>
    `
    : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 580px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; box-shadow: none;">
          <!-- Header -->
          <tr>
            <td style="background-color: #0f172a; padding: 20px 28px; text-align: left;">
              <span style="color: #ffffff; font-size: 18px; font-weight: 700; letter-spacing: 0.5px;">TINZEL</span>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 32px 28px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">${title}</h1>
              <div style="font-size: 15px; color: #334155;">
                ${contentHtml}
              </div>
              ${ctaButtonHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 20px 28px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #64748b;">
              <p style="margin: 0 0 6px 0;">Tinzel - Mfumo wa Usimamizi wa Machapisho ya Majarida</p>
              <p style="margin: 0;">Barua pepe hii imetumwa moja kwa moja kutoka kwenye mfumo wa Tinzel.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

/**
 * High-level HTML & Plaintext Template Builders
 */
export const emailTemplates = {
  payment_verified: ({ clientName, trackingId, trackingUrl, formTitle }) => {
    const title = 'Malipo Yamethibitishwa';
    const contentHtml = `
      <p>Habari <strong>${clientName}</strong>,</p>
      <p>Malipo ya jarida lako <strong>${formTitle || 'Tinzel Magazine'}</strong> yamethibitishwa rasmi.</p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <p style="margin: 0 0 8px 0; font-size: 13px; color: #64748b; text-transform: uppercase; font-weight: 600;">Namba ya Kufuatilia (Tracking ID)</p>
        <p style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 1px; color: #0f172a;">${trackingId}</p>
      </div>
      <p>Oda yako sasa imepangwa kuanza kusanifiwa (designing). Unaweza kufuatilia maendeleo ya jarida lako kupitia ukurasa wa ufuatiliaji.</p>
    `;
    const text = `Habari ${clientName}!\n\nMalipo ya jarida lako (${formTitle || 'Tinzel Magazine'}) yamethibitishwa.\nNamba yako ya Kufuatilia (Tracking ID) ni: ${trackingId}\n\nFuatilia maendeleo ya oda yako hapa:\n${trackingUrl}`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: { label: 'Fuatilia Jarida Lako', url: trackingUrl },
      }),
      text,
    };
  },

  draft_released: ({ clientName, trackingId, trackingUrl, versionNumber, designerNotes }) => {
    const title = `Rasimu ya Jarida Ipo Tayari (Toleo la ${versionNumber || 1})`;
    const designerSection = designerNotes
      ? `<div style="background-color: #f8fafc; border-left: 3px solid #0f172a; padding: 12px 16px; margin: 18px 0; font-size: 14px; color: #475569;">
           <strong>Maelezo kutoka kwa Mbunifu:</strong><br>${designerNotes}
         </div>`
      : '';

    const contentHtml = `
      <p>Habari <strong>${clientName}</strong>,</p>
      <p>Rasimu ya jarida lako (Toleo la <strong>${versionNumber || 1}</strong>) imekamilika na ipo tayari kwa mapitio yako.</p>
      ${designerSection}
      <p>Tafadhali kagua kurasa zote za jarida na uweke idhini au maoni iwapo kuna marekebisho yoyote unayohitaji kabla ya kuchapishwa.</p>
    `;
    const text = `Habari ${clientName}!\n\nRasimu ya Jarida lako (Toleo la ${versionNumber || 1}) ipo tayari kuangaliwa.\nNamba ya Kufuatilia: ${trackingId}\n\nKagua na utoe idhini au maoni hapa:\n${trackingUrl}`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: { label: 'Kagua Rasimu Sasa', url: trackingUrl },
      }),
      text,
    };
  },

  printing_in_progress: ({ clientName, trackingId, formTitle }) => {
    const title = 'Jarida Lako Lipo Kwenye Mashine ya Uchapaji';
    const contentHtml = `
      <p>Habari <strong>${clientName}</strong>,</p>
      <p>Jarida lako <strong>${formTitle || 'Tinzel Magazine'}</strong> (Tracking ID: <strong>${trackingId}</strong>) limeanza kuchapwa rasmi kwenye mashine za uchapaji baada ya kupata idhini.</p>
      <p>Hatua inayofuata ni ukaguzi wa mwisho wa ubora na maandalizi ya usafirishaji. Tutakutaarifu mara tu litakapokuwa njiani.</p>
    `;
    const text = `Habari ${clientName}!\n\nJarida lako (${formTitle || 'Tinzel Magazine'}) limeanza kuchapwa rasmi kwenye mashine za uchapaji.\nTracking ID: ${trackingId}\n\nTutakutaarifu pindi litakapokuwa tayari kusafirishwa.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
      }),
      text,
    };
  },

  order_dispatched: ({ clientName, trackingId, trackingReference, carrier, trackingUrl }) => {
    const title = 'Jarida Lako Limesafirishwa';
    const contentHtml = `
      <p>Habari <strong>${clientName}</strong>,</p>
      <p>Tunafurahi kukutaarifu kuwa jarida lako (Tracking ID: <strong>${trackingId}</strong>) limekamilika kuchapwa na limesafirishwa rasmi.</p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <p style="margin: 0 0 6px 0;"><strong>Msafirishaji:</strong> ${carrier || 'Usafiri Maalum'}</p>
        <p style="margin: 0;"><strong>Namba ya Kumbukumbu ya Mzigo:</strong> ${trackingReference || 'Inashughulikiwa'}</p>
      </div>
      <p>Asante kwa kuchagua huduma za Tinzel. Tunathamini sana ushirikiano wako!</p>
    `;
    const text = `Habari ${clientName}!\n\nJarida lako limekamilika na limesafirishwa.\nMsafirishaji: ${carrier || 'Usafiri Maalum'}\nKumbukumbu ya Mzigo: ${trackingReference || 'Inashughulikiwa'}\nAsante kwa kuchagua Tinzel!`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: trackingUrl ? { label: 'Fuatilia Mzigo Wako', url: trackingUrl } : undefined,
      }),
      text,
    };
  },

  client_otp: ({ clientName, otpCode, validityMinutes = 10 }) => {
    const title = 'Namba Yako ya Siri (OTP) ya Kuingia';
    const contentHtml = `
      <p>Habari <strong>${clientName || 'Mteja'}</strong>,</p>
      <p>Umeomba kuingia kwenye mfumo wa kufuatilia jarida lako kupitia Tinzel. Tumia namba ya siri ifuatayo kukamilisha uthibitishaji:</p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 20px; margin: 20px 0; text-align: center;">
        <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #0f172a; display: inline-block;">${otpCode}</span>
      </div>
      <p style="font-size: 13px; color: #64748b;">Namba hii ya siri itatumika kwa muda wa dakika ${validityMinutes}. Usishirikishe mtu yeyote namba hii.</p>
    `;
    const text = `Habari ${clientName || 'Mteja'}!\n\nNamba yako ya siri (OTP) ya kuingia kwenye mfumo wa Tinzel ni: ${otpCode}.\nNamba hii itatumika kwa dakika ${validityMinutes}.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
      }),
      text,
    };
  },

  order_submitted: ({ recipientName, submissionId, formTitle, clientName, isStaff = false, staffUrl }) => {
    const title = isStaff
      ? `Oda Mpya Imepokelewa: ${submissionId}`
      : `Oda Yako Imepokelewa (${submissionId})`;
    const contentHtml = isStaff
      ? `
        <p>Habari <strong>${recipientName || 'Meneja'}</strong>,</p>
        <p>Oda mpya ya jarida <strong>${formTitle || 'Tinzel Magazine'}</strong> kutoka kwa mteja <strong>${clientName}</strong> imewasilishwa na inasubiri uthibitisho wa malipo (Pre-Design).</p>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 14px; margin: 16px 0;">
          <p style="margin: 0;"><strong>Submission ID:</strong> ${submissionId}</p>
        </div>
      `
      : `
        <p>Habari <strong>${clientName}</strong>,</p>
        <p>Taarifa na picha za jarida lako <strong>${formTitle || 'Tinzel Magazine'}</strong> zimepokelewa rasmi.</p>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 14px; margin: 16px 0;">
          <p style="margin: 0;"><strong>Namba ya Mawasilisho:</strong> ${submissionId}</p>
        </div>
        <p>Tafadhali kamilisha malipo ili tuweze kuthibitisha oda yako na kutoa Namba ya Kufuatilia (Tracking ID).</p>
      `;
    const text = isStaff
      ? `Habari ${recipientName || 'Meneja'}!\nOda mpya (${submissionId}) ya ${formTitle || 'Tinzel Magazine'} kutoka kwa ${clientName} inasubiri uthibitisho wa malipo.`
      : `Habari ${clientName}!\nTaarifa za jarida lako (${formTitle || 'Tinzel Magazine'}) zimepokelewa (Namba: ${submissionId}). Tafadhali kamilisha malipo ili kupata Tracking ID.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: isStaff && staffUrl ? { label: 'Fungua Pre-Design', url: staffUrl } : undefined,
      }),
      text,
    };
  },

  order_assigned: ({ designerName, trackingId, formTitle, clientName, staffUrl }) => {
    const title = `Oda Imekabidhiwa Kwako: ${trackingId}`;
    const contentHtml = `
      <p>Habari <strong>${designerName || 'Mbunifu'}</strong>,</p>
      <p>Umekabidhiwa oda ya jarida <strong>${formTitle || 'Tinzel Magazine'}</strong> kwa ajili ya mteja <strong>${clientName}</strong>.</p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 14px; margin: 16px 0;">
        <p style="margin: 0;"><strong>Tracking ID:</strong> ${trackingId}</p>
      </div>
      <p>Tafadhali ingia kwenye mfumo wa Tinzel kuanza usanifu wa jarida hili.</p>
    `;
    const text = `Habari ${designerName || 'Mbunifu'}!\nUmekabidhiwa oda ${trackingId} (${formTitle || 'Tinzel Magazine'} - ${clientName}). Ingia kwenye mfumo kuanza usanifu.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: staffUrl ? { label: 'Fungua Oda ya Usanifu', url: staffUrl } : undefined,
      }),
      text,
    };
  },

  draft_uploaded: ({ managerName, trackingId, formTitle, clientName, versionNumber, staffUrl }) => {
    const title = `Rasimu Mpya Inasubiri Mapitio: ${trackingId} (V${versionNumber || 1})`;
    const contentHtml = `
      <p>Habari <strong>${managerName || 'Meneja'}</strong>,</p>
      <p>Rasimu ya Toleo la <strong>${versionNumber || 1}</strong> ya jarida <strong>${formTitle || 'Tinzel Magazine'}</strong> (Mteja: <strong>${clientName}</strong>, Tracking ID: <strong>${trackingId}</strong>) imepakiwa na inasubiri ukaguzi wako kwenye Design Phase.</p>
    `;
    const text = `Habari ${managerName || 'Meneja'}!\nRasimu V${versionNumber || 1} ya oda ${trackingId} (${clientName}) imepakiwa na inasubiri mapitio yako ya Meneja.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: staffUrl ? { label: 'Kagua Rasimu Sasa', url: staffUrl } : undefined,
      }),
      text,
    };
  },

  draft_returned: ({ recipientName, trackingId, formTitle, clientName, roundNumber, items = [], source = 'manager', staffUrl }) => {
    const sourceLabel = source === 'client' ? 'Mteja' : 'Meneja';
    const title = `Marekebisho Yameombwa (${sourceLabel}): ${trackingId} - Duru ya ${roundNumber || 1}`;
    const itemsHtml = items.length
      ? `<ul style="padding-left: 20px; margin: 12px 0;">${items
          .map((item) => `<li>${item.pageReference ? `<strong>Ukurasa ${item.pageReference}:</strong> ` : ''}${item.text}</li>`)
          .join('')}</ul>`
      : '';
    const contentHtml = `
      <p>Habari <strong>${recipientName || 'Mbunifu'}</strong>,</p>
      <p>Jarida la <strong>${formTitle || 'Tinzel Magazine'}</strong> (Tracking ID: <strong>${trackingId}</strong>, Mteja: <strong>${clientName}</strong>) limerudishwa kwenye ukurasa wa <strong>Returns</strong> kwa ajili ya marekebisho (Duru ya ${roundNumber || 1} kutoka kwa ${sourceLabel}).</p>
      ${itemsHtml}
      <p>Tafadhali fungua ukurasa wa Returns kukamilisha marekebisho yote yaliyoorodheshwa.</p>
    `;
    const itemsText = items.map((item, idx) => `${idx + 1}. ${item.pageReference ? `[Uk. ${item.pageReference}] ` : ''}${item.text}`).join('\n');
    const text = `Habari ${recipientName || 'Mbunifu'}!\nJarida ${trackingId} (${clientName}) limerudishwa kwa marekebisho (Duru ya ${roundNumber || 1} - ${sourceLabel}).\n${itemsText}`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: staffUrl ? { label: 'Fungua Ukurasa wa Returns', url: staffUrl } : undefined,
      }),
      text,
    };
  },

  client_approved: ({ recipientName, trackingId, formTitle, clientName, versionNumber, staffUrl }) => {
    const title = `Mteja Ameidhinisha Jarida: ${trackingId}`;
    const contentHtml = `
      <p>Habari <strong>${recipientName || 'Timu ya Tinzel'}</strong>,</p>
      <p>Mteja <strong>${clientName}</strong> ameidhinisha rasmi jarida zima la <strong>${formTitle || 'Tinzel Magazine'}</strong> (Tracking ID: <strong>${trackingId}</strong>, Toleo la <strong>${versionNumber || 1}</strong>).</p>
      <p>Oda imeingia kwenye <strong>Post-Design Phase</strong> kwa ajili ya kuandaa faili la mwisho la uchapaji (Print Preparation).</p>
    `;
    const text = `Habari ${recipientName || 'Timu ya Tinzel'}!\nMteja ${clientName} ameidhinisha jarida zima la oda ${trackingId} (Toleo la ${versionNumber || 1}). Oda ipo kwenye Post-Design Phase kwa maandalizi ya uchapaji.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: staffUrl ? { label: 'Fungua Post-Design Phase', url: staffUrl } : undefined,
      }),
      text,
    };
  },

  print_document_uploaded: ({ recipientName, trackingId, formTitle, clientName, specs = {}, staffUrl }) => {
    const title = `Faili la Print Lipo Tayari kwa Idhini: ${trackingId}`;
    const contentHtml = `
      <p>Habari <strong>${recipientName || 'Meneja'}</strong>,</p>
      <p>Faili la mwisho la uchapaji (Print-Ready PDF) kwa oda <strong>${trackingId}</strong> (${formTitle || 'Tinzel Magazine'} - <strong>${clientName}</strong>) limepakiwa na linasubiri idhini yako ya kupelekwa kwa mchapaji.</p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 14px; margin: 16px 0;">
        <p style="margin: 0 0 4px 0;"><strong>Nakala:</strong> ${specs.quantity || 1}</p>
        <p style="margin: 0 0 4px 0;"><strong>Karatasi:</strong> ${specs.paperType || 'Glossy 150gsm'}</p>
        <p style="margin: 0;"><strong>Kava:</strong> ${specs.coverFinish || 'Laminated Matte'}</p>
      </div>
    `;
    const text = `Habari ${recipientName || 'Meneja'}!\nFaili la Print-Ready PDF kwa oda ${trackingId} (${clientName}) limepakiwa na linasubiri idhini yako kwenye Post-Design Phase.`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: staffUrl ? { label: 'Idhinisha Uchapaji', url: staffUrl } : undefined,
      }),
      text,
    };
  },

  order_closed: ({ recipientName, trackingId, formTitle, recipientConfirmed, confirmationMethod }) => {
    const title = `Oda Imekamilika na Kukabidhiwa: ${trackingId}`;
    const contentHtml = `
      <p>Habari <strong>${recipientName || 'Mteja'}</strong>,</p>
      <p>Oda ya jarida <strong>${formTitle || 'Tinzel Magazine'}</strong> (Tracking ID: <strong>${trackingId}</strong>) imethibitishwa kufika salama kwa mpokeaji (<strong>${recipientConfirmed || recipientName}</strong>) na imefungwa rasmi.</p>
      <p>Asante kwa kutumia mfumo wa Tinzel!</p>
    `;
    const text = `Habari ${recipientName || 'Mteja'}!\nOda ya jarida ${trackingId} (${formTitle || 'Tinzel Magazine'}) imethibitishwa kufika salama (${confirmationMethod || 'Delivered'}) na imefungwa rasmi. Asante kwa kuchagua Tinzel!`;

    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
      }),
      text,
    };
  },

  general_notification: ({ recipientName, title = 'Taarifa kutoka Tinzel', message, actionUrl, actionLabel }) => {
    const contentHtml = `
      <p>Habari <strong>${recipientName || 'Mpendwa'}</strong>,</p>
      <div style="white-space: pre-line; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 16px; margin: 16px 0;">
        ${message}
      </div>
    `;
    return {
      title,
      html: wrapEmailTemplate({
        title,
        contentHtml,
        callToAction: actionUrl ? { label: actionLabel || 'Fungua Mfumo', url: actionUrl } : undefined,
      }),
      text: message,
    };
  },
};

/**
 * Dispatch an email message via Nodemailer or simulation mode.
 */
export const sendEmail = async ({ to, subject, html, text }) => {
  const from = process.env.SMTP_FROM || `Tinzel <${process.env.SMTP_USER || 'notifications@tinzel.com'}>`;

  if (!isEmailConfigured()) {
    console.log(`[Email Service - Simulated] To: ${to} | Subject: "${subject}"`);
    return {
      mode: 'simulated',
      messageId: `sim-mail-${Date.now()}`,
      to,
      from,
      subject,
      preview: text ? text.slice(0, 150) : '',
    };
  }

  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });

    console.log(`[Email Service - Google SMTP] Delivered to: ${to} | MessageId: ${info.messageId}`);
    return {
      mode: 'smtp_live',
      messageId: info.messageId,
      to,
      from,
      subject,
    };
  } catch (error) {
    console.error(`[Email Service - Error] Failed to send email to ${to}: ${error.message}`);
    return {
      mode: 'smtp_failed_fallback_simulated',
      to,
      from,
      subject,
      error: error.message,
    };
  }
};

/**
 * Checks the health and live connectivity of the Google SMTP / Nodemailer service.
 */
export const getEmailHealth = async () => {
  const configured = isEmailConfigured();
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const secure =
    process.env.SMTP_SECURE !== undefined ? process.env.SMTP_SECURE === 'true' : port === 465;
  const from = process.env.SMTP_FROM || `Tinzel <${process.env.SMTP_USER || 'notifications@tinzel.com'}>`;
  const user = process.env.SMTP_USER || '';

  if (!configured) {
    return {
      configured: false,
      connected: false,
      mode: 'simulated',
      host,
      port,
      secure,
      from,
      user,
      latencyMs: 0,
      message: 'SMTP credentials (SMTP_USER / SMTP_PASS) are not configured. Operating in simulation mode.',
    };
  }

  const startedAt = Date.now();
  try {
    const transporter = getTransporter();
    await transporter.verify();
    return {
      configured: true,
      connected: true,
      mode: 'smtp_live',
      host,
      port,
      secure,
      from,
      user,
      latencyMs: Date.now() - startedAt,
      message: 'SMTP server connection verified and ready to send emails.',
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      mode: 'error',
      host,
      port,
      secure,
      from,
      user,
      latencyMs: Date.now() - startedAt,
      message: `SMTP verification failed: ${error.message}`,
    };
  }
};
