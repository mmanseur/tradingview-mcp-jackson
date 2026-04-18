/**
 * mail_report.js — CLI wrapper pour envoyer un rapport markdown par email
 *
 * Usage:
 *   node src/scripts/mail_report.js <subject> <previewText> <filePath>
 *
 * Le fichier est lu, converti en HTML et envoyé via Gmail SMTP (mailer.js).
 * Variables requises dans .env : GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_TO
 */
import { sendReportEmail } from '../core/mailer.js';

const [, , subject, previewText, filePath] = process.argv;

if (!subject || !filePath) {
  console.error('Usage: node mail_report.js <subject> <previewText> <filePath>');
  process.exit(1);
}

try {
  const result = await sendReportEmail({ subject, previewText, reportPath: filePath });
  if (result.sent) {
    console.log(`Email envoyé: ${result.messageId}`);
  } else {
    console.error(`Email non envoyé: ${result.reason}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Erreur email: ${e.message}`);
  process.exit(1);
}
