/**
 * Mailer — Gmail SMTP via nodemailer
 *
 * Configuration via .env (ou variables d'environnement) :
 *   GMAIL_USER          — adresse Gmail expéditeur
 *   GMAIL_APP_PASSWORD  — App Password Google (pas le mot de passe normal)
 *   GMAIL_TO            — destinataire (défaut: GMAIL_USER)
 *   MAIL_DISABLED       — 1 pour désactiver l'envoi
 */
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import nodemailer from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Charge .env minimaliste (pas de dépendance supplémentaire)
function loadDotEnv() {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // Strip optional quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''); // Gmail tolère mais on nettoie
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD non définis dans .env');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

/**
 * Convertit un markdown simple en HTML (tables, headings, listes, bold).
 * Suffisant pour nos rapports scanner/brief, pas besoin d'une lib externe.
 */
function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inTable = false;
  let tableCols = 0;

  const inline = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
      tableCols = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // Tables
    if (/^\|.*\|$/.test(ln)) {
      const cells = ln.slice(1, -1).split('|').map((c) => c.trim());
      const next = lines[i + 1] || '';
      const isSeparator = /^\|?[\s\-:|]+\|?$/.test(ln) && ln.includes('-');
      if (isSeparator) continue;
      if (!inTable) {
        // Header
        out.push('<table style="border-collapse:collapse;margin:12px 0;font-family:Arial,sans-serif;font-size:13px">');
        out.push('<thead><tr>');
        for (const c of cells) {
          out.push(
            `<th style="border:1px solid #ddd;padding:6px 10px;background:#f5f5f5;text-align:left">${inline(c)}</th>`
          );
        }
        out.push('</tr></thead><tbody>');
        inTable = true;
        tableCols = cells.length;
        // skip the separator line
        if (/^\|?[\s\-:|]+\|?$/.test(lines[i + 1] || '')) i++;
        continue;
      }
      out.push('<tr>');
      for (const c of cells) {
        out.push(`<td style="border:1px solid #ddd;padding:6px 10px">${inline(c)}</td>`);
      }
      out.push('</tr>');
      continue;
    }
    closeTable();

    if (ln.startsWith('### ')) {
      out.push(`<h3 style="font-family:Arial,sans-serif;margin:18px 0 6px">${inline(ln.slice(4))}</h3>`);
    } else if (ln.startsWith('## ')) {
      out.push(`<h2 style="font-family:Arial,sans-serif;margin:20px 0 8px;color:#222">${inline(ln.slice(3))}</h2>`);
    } else if (ln.startsWith('# ')) {
      out.push(`<h1 style="font-family:Arial,sans-serif;margin:24px 0 10px;color:#111">${inline(ln.slice(2))}</h1>`);
    } else if (ln.startsWith('> ')) {
      out.push(`<blockquote style="border-left:3px solid #888;padding-left:10px;color:#555;font-family:Arial,sans-serif">${inline(ln.slice(2))}</blockquote>`);
    } else if (ln.startsWith('- ')) {
      out.push(`<li style="font-family:Arial,sans-serif">${inline(ln.slice(2))}</li>`);
    } else if (/^---+$/.test(ln)) {
      out.push('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0" />');
    } else if (ln.trim() === '') {
      out.push('<br/>');
    } else {
      out.push(`<p style="font-family:Arial,sans-serif;margin:6px 0">${inline(ln)}</p>`);
    }
  }
  closeTable();
  return out.join('\n');
}

/**
 * Envoie un email avec un rapport markdown.
 * @param {Object} opts
 * @param {string} opts.subject   — Sujet de l'email
 * @param {string} opts.reportPath — chemin absolu vers le .md à envoyer
 * @param {string} [opts.previewText] — résumé textuel en tête du mail
 * @returns {Promise<{sent: boolean, reason?: string, messageId?: string}>}
 */
export async function sendReportEmail({ subject, reportPath, previewText }) {
  if (process.env.MAIL_DISABLED === '1') {
    return { sent: false, reason: 'MAIL_DISABLED=1' };
  }
  if (!existsSync(reportPath)) {
    return { sent: false, reason: `Report file not found: ${reportPath}` };
  }

  const md = readFileSync(reportPath, 'utf8');
  const html = `
<div style="max-width:900px;font-family:Arial,sans-serif">
  ${previewText ? `<p style="background:#e8f4ff;padding:10px;border-radius:4px;border-left:4px solid #2a7bd5">${previewText}</p>` : ''}
  ${mdToHtml(md)}
  <hr/>
  <p style="color:#888;font-size:11px">Envoyé automatiquement par scanner_v4.js · Claude Code</p>
</div>
  `.trim();

  const transporter = getTransporter();
  const from = process.env.GMAIL_USER;
  const to = process.env.GMAIL_TO || from;

  const info = await transporter.sendMail({
    from: `"Claude Scanner" <${from}>`,
    to,
    subject,
    text: md, // fallback texte
    html,
    attachments: [
      {
        filename: basename(reportPath),
        path: reportPath,
        contentType: 'text/markdown',
      },
    ],
  });

  return { sent: true, messageId: info.messageId };
}
