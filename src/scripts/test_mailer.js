/**
 * Test mailer — envoie le dernier rapport scanner par email.
 * Usage: node src/scripts/test_mailer.js
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { sendReportEmail } from '../core/mailer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', '..', 'reports');

function latestReport() {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith('scan_') && f.endsWith('.md'))
    .sort()
    .reverse();
  return files.length > 0 ? resolve(REPORTS_DIR, files[0]) : null;
}

async function main() {
  const report = latestReport();
  if (!report) {
    console.error('Aucun rapport trouvé dans reports/. Lance d\'abord: npm run scan');
    process.exit(1);
  }
  console.log(`Envoi du rapport: ${report}`);
  const r = await sendReportEmail({
    subject: `[TEST] Scanner V4 — ${new Date().toISOString().split('T')[0]}`,
    reportPath: report,
    previewText: 'TEST email — vérification du pipeline Gmail SMTP',
  });
  if (r.sent) {
    console.log(`OK ✓  messageId=${r.messageId}`);
  } else {
    console.log(`NON envoyé: ${r.reason}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Erreur:', e.message);
  process.exit(1);
});
