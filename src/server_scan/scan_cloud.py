"""
scan_cloud.py — Scan IA TSX entièrement cloud

Données :
  • positions.json  — positions IBKR exportées localement puis pushées sur GitHub
  • yfinance        — OHLCV TSX (gratuit, sans auth, tourne partout)
  • Claude API      — raisonnement 4 couches + rapport narrative

Variables d'environnement requises :
  ANTHROPIC_API_KEY   — clé API Anthropic
  GMAIL_USER          — adresse email expéditeur
  GMAIL_APP_PASSWORD  — mot de passe d'application Gmail
  RECIPIENT_EMAIL     — adresse email destinataire (optionnel, défaut = GMAIL_USER)
"""

import json
import os
import smtplib
import sys
from datetime import date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import anthropic
import yfinance as yf

# Ajouter le répertoire server_scan au path pour importer momentum_v4
sys.path.insert(0, str(Path(__file__).parent))
from momentum_v4 import compute_signals

# ─── CONFIG ─────────────────────────────────────────────────────────────────

NLV_CAD     = 9_000
RISK_BUDGET = NLV_CAD * 0.03   # 270 CAD max par trade
OHLCV_BARS  = 400               # ~18 mois de barres daily

REPO_ROOT     = Path(__file__).parent.parent.parent
POSITIONS_FILE = REPO_ROOT / "positions.json"

# Mapping ticker IBKR → symbole Yahoo Finance
YAHOO_MAP = {
    "WPM"  : "WPM.TO",
    "BBD.B": "BBD-B.TO",
    "CGG"  : "CGG.TO",
    "VNP"  : "VNP.TO",
    "CLS"  : "CLS.TO",
    "AEM"  : "AEM.TO",
    "SHOP" : "SHOP.TO",
}


# ─── DONNÉES OHLCV ──────────────────────────────────────────────────────────

def fetch_ohlcv(ticker: str, bars: int = OHLCV_BARS):
    """Télécharge les barres daily depuis Yahoo Finance."""
    yahoo_sym = YAHOO_MAP.get(ticker.upper(), f"{ticker}.TO")
    print(f"  yfinance {yahoo_sym}...")
    df = yf.download(yahoo_sym, period="2y", interval="1d",
                     progress=False, auto_adjust=True, multi_level_index=False)
    if df.empty:
        raise ValueError(f"Aucune donnée yfinance pour {yahoo_sym}")
    df.columns = [c.lower() for c in df.columns]
    df = df[["open", "high", "low", "close", "volume"]].dropna()
    return df.tail(bars)


# ─── SIZING ─────────────────────────────────────────────────────────────────

def sizing(price, stop) -> dict:
    if not stop or stop <= 0 or stop >= price:
        return {"shares": None, "value": None, "risk": None, "pct": None}
    risk_per = price - stop
    n = int(RISK_BUDGET / risk_per)
    if n <= 0:
        return {"shares": 0, "value": 0, "risk": 0, "pct": 0}
    return {
        "shares": n,
        "value" : round(n * price, 0),
        "risk"  : round(n * risk_per, 0),
        "pct"   : round(n * price / NLV_CAD * 100, 1),
    }


# ─── RAPPORT VIA CLAUDE API ─────────────────────────────────────────────────

def generate_report_claude(signals_data: list, positions: list,
                            account: dict, today: str) -> str:
    """Envoie les données techniques à Claude API pour générer le rapport final."""

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    # Construire le contexte pour Claude
    nlv  = account.get("NetLiquidation", NLV_CAD)
    cash = account.get("AvailableFunds", 0)

    signals_text = json.dumps(signals_data, indent=2, ensure_ascii=False)

    prompt = f"""Tu es un analyste quantitatif senior spécialisé swing trading TSX.
Capital : {nlv:,.0f} CAD | Budget risque : {RISK_BUDGET:.0f} CAD max/trade | Cash disponible : {cash:,.0f} CAD

Voici les données techniques calculées par Momentum V4 [Unified] pour les positions IBKR d'aujourd'hui ({today}) :

{signals_text}

Génère un rapport de scan complet en markdown avec cette structure exacte :

# Analyse IA Portefeuille — {today}

## Résumé Exécutif
[2-3 phrases : état global, signal dominant, priorité du jour]

## Positions IBKR

Pour CHAQUE position, format obligatoire :
### [TICKER] — [HOLD/AJOUTER/VENDRE] 🔴/🟡/🟢
- Prix : X.XX$ | Moy : X.XX$ | P&L : +X.X% (+XX CAD)
- Signal D : [BRK/PB/ADD/EXIT/SELL/WEAK/NEUTRE] | Mode : [GoldPro/Supertrend/V4] | ADX : XX.X
- Stop : X.XX$ | Target : X.XX$ (ou N/A)
- Sizing : N actions × X.XX$ = X,XXX$ (X% capital) — risque XX$/270$ max (ou N/A si HOLD)
- Pourquoi : [2 phrases de raisonnement]

## Portfolio Global
- Investi : X,XXX$ / {nlv:,.0f}$ | Cash : ~{cash:,.0f}$ | Corrélations : [alertes gold/secteur]
- Priorité #1 : [UNE seule action concrète]

## Risques
[2-3 points concrets avec prix exacts]

Règles :
- Stop Loss, Take Profit et Sizing TOUJOURS présents (N/A si vraiment impossible)
- Si WEAK ou EXIT → recommander VENDRE avec nombre d'actions exact
- Si BRK ou PB et cash suffisant → recommander entrée avec sizing complet
- Raisonnement basé UNIQUEMENT sur les données fournies, ne pas inventer de prix
"""

    chunks = []
    with client.messages.stream(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        for text in stream.text_stream:
            chunks.append(text)
            print(text, end="", flush=True)
    print()
    return "".join(chunks)


# ─── EMAIL ──────────────────────────────────────────────────────────────────

def send_email(report: str, today: str, signals_data: list):
    gmail_user = os.environ["GMAIL_USER"]
    gmail_pass = os.environ["GMAIL_APP_PASSWORD"]
    recipient  = os.environ.get("RECIPIENT_EMAIL", gmail_user)

    # Sujet selon signaux dominants
    exits = [s for s in signals_data if s.get("weak") or s.get("exit")]
    brks  = [s for s in signals_data if s.get("brk") or s.get("pb")]

    if exits and brks:
        subject = f"[Scan IA] {today} — {exits[0]['ticker']} SORTIE + {brks[0]['ticker']} BRK"
    elif exits:
        subject = f"[Scan IA] {today} — SORTIE {exits[0]['ticker']}"
    elif brks:
        subject = f"[Scan IA] {today} — BRK {brks[0]['ticker']}"
    else:
        subject = f"[Scan IA] {today} — rapport positions IBKR"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = gmail_user
    msg["To"]      = recipient
    msg.attach(MIMEText(report, "plain", "utf-8"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(gmail_user, gmail_pass)
        server.sendmail(gmail_user, recipient, msg.as_string())

    print(f"Email envoyé : {subject}")
    print(f"Destinataire : {recipient}")


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    today = date.today().isoformat()
    print(f"\n{'='*55}")
    print(f"  Scan IA Cloud TSX — {today}")
    print(f"{'='*55}\n")

    # 1. Lire positions.json
    print("Étape 1 — Lecture positions.json...")
    data      = json.loads(POSITIONS_FILE.read_text(encoding="utf-8"))
    positions = data["positions"]
    account   = data["account"]
    exported  = data["exported_at"]
    nlv       = account.get("NetLiquidation", NLV_CAD)
    cash      = account.get("AvailableFunds", 0)

    print(f"  Exporté le : {exported}")
    print(f"  NLV : {nlv:,.0f} CAD | Cash : {cash:,.0f} CAD")
    print(f"  Positions : {len(positions)}")
    for p in positions:
        print(f"    {p['ticker']:8s} {p['qty']:3d} × {p['avg_price']:.2f}$ ({p['pnl_pct']:+.1f}%)")

    # 2. OHLCV + signaux
    print("\nÉtape 2 — OHLCV + Momentum V4...")
    signals_data = []
    pos_map = {p["ticker"].upper(): p for p in positions}

    for pos in positions:
        ticker = pos["ticker"]
        print(f"  → {ticker}")
        try:
            df  = fetch_ohlcv(ticker)
            sig = compute_signals(df, ticker)

            # Stop / Target selon le mode
            if sig["mode"] == "GoldPro":
                stop   = sig.get("chandelier")
                target = sig.get("donchian_hi")
            elif sig["mode"] == "Supertrend":
                stop   = sig.get("supertrend")
                target = None
            else:
                stop   = sig.get("ema_fast")
                target = None

            sz = sizing(sig["close"], stop)

            dominant = next(
                (k for k in ["brk","pb","add","exit","sell","weak"] if sig.get(k)),
                "neutre"
            )

            signals_data.append({
                "ticker"     : ticker,
                "mode"       : sig["mode"],
                "dominant"   : dominant.upper(),
                # Position IBKR
                "qty"        : pos["qty"],
                "avg_price"  : pos["avg_price"],
                "last_price" : sig["close"],
                "pnl_pct"    : round((sig["close"] - pos["avg_price"]) / pos["avg_price"] * 100, 2),
                "pnl_cad"    : round((sig["close"] - pos["avg_price"]) * pos["qty"], 0),
                # Indicateurs
                "ema_fast"   : round(sig["ema_fast"], 2),
                "adx"        : round(sig["adx"], 1),
                "bull_align" : sig["bull_align"],
                # Signaux
                "brk"  : sig["brk"],  "pb"  : sig["pb"],
                "add"  : sig["add"],  "exit": sig["exit"],
                "sell" : sig["sell"], "weak": sig["weak"],
                # Gold Pro
                "donchian_hi": round(sig["donchian_hi"], 2) if sig.get("donchian_hi") else None,
                "chandelier" : round(sig["chandelier"],  2) if sig.get("chandelier")  else None,
                # Supertrend
                "supertrend" : round(sig["supertrend"],  2) if sig.get("supertrend")  else None,
                # Sizing
                "stop"       : round(stop,   2) if stop   else None,
                "target"     : round(target, 2) if target else None,
                "sizing"     : sz,
            })
            print(f"     {dominant.upper()} | stop={stop:.2f if stop else 'N/A'} | ADX={sig['adx']:.1f}")
        except Exception as e:
            print(f"     ERREUR : {e}")

    if not signals_data:
        print("Aucune donnée — abandon")
        sys.exit(1)

    # 3. Rapport via Claude API
    print("\nÉtape 3 — Génération rapport (Claude API)...")
    report = generate_report_claude(signals_data, positions, account, today)
    print("  Rapport généré ✓")

    # 4. Email
    print("\nÉtape 4 — Envoi email...")
    send_email(report, today, signals_data)

    print(f"\n{'='*55}")
    print("  Scan cloud terminé avec succès")
    print(f"{'='*55}\n")


if __name__ == "__main__":
    main()
