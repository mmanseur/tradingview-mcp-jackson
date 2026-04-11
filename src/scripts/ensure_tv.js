/**
 * Preflight — vérifie que TradingView est accessible via CDP port 9222.
 *
 * Stratégie prudente (pas d'auto-lancement risqué):
 *   1. Ping CDP /json/version
 *   2. Si OK → exit 0
 *   3. Si down → envoie un email d'alerte à l'utilisateur et exit 2
 *
 * Pourquoi pas d'auto-launch:
 *   L'utilisateur tourne potentiellement en Edge browser mode (TradingView Web)
 *   avec son chart, indicateurs et layout perso. Relancer via launch() créerait
 *   une 2e instance vide qui prendrait le port 9222 et écraserait l'état réel.
 *   Sur les setups Desktop MSIX (Microsoft Store), le path TradingView.exe
 *   n'est de toute façon pas détectable par `where` → fallback browser
 *   systématique, ce qui est indésirable.
 *
 * Exit codes:
 *   0 = CDP prêt
 *   2 = CDP inaccessible (email d'alerte envoyé)
 */
import http from 'node:http';
import { sendReportEmail } from '../core/mailer.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

const CDP_PORT = 9222;

function checkCdp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve({ ok: true, browser: info.Browser, ua: info['User-Agent'] });
        } catch {
          resolve({ ok: false, reason: 'Invalid JSON from CDP' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
  });
}

async function sendAlert(reason) {
  const ts = new Date().toISOString();
  const dateStr = ts.split('T')[0];
  mkdirSync(REPORTS_DIR, { recursive: true });
  const alertPath = resolve(REPORTS_DIR, `alert_cdp_${dateStr}.md`);
  const md = `# ⚠️ Alerte Scanner V4 — CDP inaccessible

> ${ts}

Le preflight \`ensure_tv.js\` n'a pas pu joindre TradingView via CDP port ${CDP_PORT}.

**Raison:** ${reason}

Le scan du jour a été **annulé**.

## Action requise

1. Vérifier que **TradingView Desktop** (ou Edge avec TradingView Web) est bien lancé
2. S'assurer que CDP est activé sur le port ${CDP_PORT}
3. Relancer manuellement: \`npm run scan\`

## Commandes de diagnostic

\`\`\`bash
netstat -an | findstr 9222
tasklist | findstr /I tradingview
curl http://127.0.0.1:9222/json/version
\`\`\`
`;
  writeFileSync(alertPath, md, 'utf8');
  try {
    const r = await sendReportEmail({
      subject: `[Scanner V4] ⚠️ ${dateStr} — CDP inaccessible, scan annulé`,
      reportPath: alertPath,
      previewText: `CDP port ${CDP_PORT} inaccessible (${reason}). Scan du jour annulé. Vérifie que TradingView tourne.`,
    });
    if (r.sent) console.log(`[ensure_tv] Email d'alerte envoyé: ${r.messageId}`);
    else console.log(`[ensure_tv] Email d'alerte non envoyé: ${r.reason}`);
  } catch (e) {
    console.log(`[ensure_tv] Erreur envoi alerte: ${e.message}`);
  }
}

async function main() {
  console.log(`[ensure_tv] Vérification CDP sur port ${CDP_PORT}...`);
  const status = await checkCdp();
  if (status.ok) {
    console.log(`[ensure_tv] OK — CDP actif: ${status.browser}`);
    process.exit(0);
  }
  console.error(`[ensure_tv] ÉCHEC — CDP inaccessible (${status.reason})`);
  await sendAlert(status.reason);
  process.exit(2);
}

main().catch((e) => {
  console.error(`[ensure_tv] Fatal: ${e.message}`);
  process.exit(1);
});
