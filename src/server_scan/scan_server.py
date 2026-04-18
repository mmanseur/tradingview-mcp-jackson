"""
scan_server.py — Scan autonome TSX sans TradingView

Pipeline :
  1. Connexion IBKR Gateway → positions + NLV
  2. Téléchargement OHLCV daily pour chaque position (+ watchlist si cash dispo)
  3. Calcul Momentum V4 [Unified] en Python (Gold Pro / Supertrend / V4 Standard)
  4. Raisonnement 4 couches (signal, contexte, sizing, portfolio)
  5. Génération rapport markdown
  6. Envoi email via mail_report.js
  7. Suppression fichier temporaire

Usage :
    python scan_server.py

Planification automatique (Windows Task Scheduler) :
    Déclencheur : Lundi-Vendredi 09:30
    Action      : python D:/Claude/tradingview-mcp-jackson/src/server_scan/scan_server.py
"""

import os
import sys
import io
import subprocess
from datetime import date, datetime
from pathlib import Path

# Fix Windows console encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# Ajouter le répertoire courant au path
sys.path.insert(0, str(Path(__file__).parent))

from ibkr_client import IBKRClient
from momentum_v4 import compute_signals

# ─── CONFIG ─────────────────────────────────────────────────────────────────

NLV_CAD       = 9_000          # Capital de référence pour le sizing
RISK_PCT      = 0.03           # 3% de risque max par trade
RISK_BUDGET   = NLV_CAD * RISK_PCT   # = 270 CAD

WATCHLIST     = ["WPM", "BBD.B", "CLS", "AEM", "CGG", "VNP", "SHOP"]
OHLCV_BARS    = 300            # ~14 mois de daily

MAIL_SCRIPT   = Path("D:/Claude/tradingview-mcp-jackson/src/scripts/mail_report.js")
REPORTS_DIR   = Path("D:/Claude/tradingview-mcp-jackson/reports")

# ─── SIZING ─────────────────────────────────────────────────────────────────

def compute_sizing(price: float, stop: float, risk_budget: float = RISK_BUDGET) -> dict:
    """
    Calcule le nombre d'actions optimal pour un risque donné.
    Retourne dict avec shares, value, risk_per_share, risk_total.
    """
    if stop is None or stop <= 0 or stop >= price:
        return {"shares": None, "value": None, "risk_per_share": None, "risk_total": None}

    risk_per_share = round(price - stop, 4)
    shares         = int(risk_budget / risk_per_share)
    if shares <= 0:
        return {"shares": 0, "value": 0, "risk_per_share": risk_per_share, "risk_total": 0}

    return {
        "shares"        : shares,
        "value"         : round(shares * price, 2),
        "risk_per_share": risk_per_share,
        "risk_total"    : round(shares * risk_per_share, 2),
        "pct_capital"   : round(shares * price / NLV_CAD * 100, 1),
    }


def fmt_sizing(sz: dict, price: float) -> str:
    if sz["shares"] is None:
        return "N/A"
    return (f"{sz['shares']} actions × {price:.2f}$ = {sz['value']:,.0f}$ "
            f"({sz['pct_capital']}% capital) — risque {sz['risk_total']:.0f}$/{RISK_BUDGET:.0f}$ max")


# ─── ANALYSE PAR TICKER ─────────────────────────────────────────────────────

def analyse_ticker(sig: dict, pos: dict | None, cash_cad: float) -> dict:
    """
    Applique le raisonnement 4 couches à un ticker.
    Retourne un dict structuré pour le rapport.
    """
    mode  = sig["mode"]
    price = sig["close"]
    ticker = sig["ticker"]

    # ── Stop Loss ───────────────────────────────────────────────────────────
    if mode == "GoldPro":
        stop   = sig["chandelier"]       # Chandelier trailing stop
        target = sig["donchian_hi"]      # Donchian Hi 55j = target turtle
    elif mode == "Supertrend":
        stop   = sig["supertrend"]       # Supertrend line = stop dynamique
        target = None                    # Pas de Donchian en mode Supertrend
    else:  # V4 Standard
        stop   = sig["ema_fast"]         # EMA Fast = stop de protection
        target = None                    # Pas de Donchian

    # ── Signal dominant ─────────────────────────────────────────────────────
    if sig["brk"]:
        dominant = "BRK"
    elif sig["pb"]:
        dominant = "PB"
    elif sig["add"]:
        dominant = "ADD"
    elif sig["exit"]:
        dominant = "EXIT"
    elif sig["sell"]:
        dominant = "SELL"
    elif sig["weak"]:
        dominant = "WEAK"
    else:
        dominant = "NEUTRE"

    # ── Recommandation ──────────────────────────────────────────────────────
    if sig["exit"] or sig["sell"] or sig["weak"]:
        reco  = "VENDRE" if pos else "ÉVITER"
        emoji = "🔴"
    elif sig["brk"] or sig["pb"] or sig["add"]:
        reco  = "ENTRER" if not pos else "AJOUTER"
        emoji = "🟢"
    else:
        reco  = "HOLD" if pos else "SURVEILLER"
        emoji = "🟡"

    # Surcharge Supertrend : si price < Supertrend → risque caché malgré EMAs bullish
    if mode == "Supertrend" and stop and price < stop:
        if reco == "HOLD":
            reco  = "SURVEILLER"
            emoji = "🟡"

    # ── Sizing ──────────────────────────────────────────────────────────────
    sz = compute_sizing(price, stop)

    # Si pas de cash pour ajouter
    can_add = (cash_cad >= sz["value"]) if sz["value"] else False

    if reco == "AJOUTER" and not can_add:
        reco  = "HOLD"
        emoji = "🟢"
        note_cash = f"ADD signal — IMPOSSIBLE (cash {cash_cad:.0f} CAD, besoin {sz['value']:,.0f} CAD)"
    else:
        note_cash = None

    # ── P&L contexte ────────────────────────────────────────────────────────
    pnl_info = None
    if pos:
        pnl_info = {
            "avg"      : pos["avg_price"],
            "last"     : pos["last_price"],
            "pnl_pct"  : pos["pnl_pct"],
            "pnl_cad"  : pos["pnl_cad"],
            "qty"      : pos["qty"],
            "value"    : pos["value_cad"],
            "pct_cap"  : round(pos["value_cad"] / NLV_CAD * 100, 1),
        }

    # ── Pourquoi ────────────────────────────────────────────────────────────
    rationale = _build_rationale(sig, dominant, reco, mode, stop, target, pos, note_cash)

    return {
        "ticker"   : ticker,
        "mode"     : mode,
        "reco"     : reco,
        "emoji"    : emoji,
        "dominant" : dominant,
        "price"    : price,
        "stop"     : stop,
        "target"   : target,
        "sizing"   : sz,
        "can_add"  : can_add,
        "note_cash": note_cash,
        "pnl"      : pnl_info,
        "adx"      : sig["adx"],
        "ema_fast" : sig["ema_fast"],
        "bull_align": sig["bull_align"],
        "rationale": rationale,
        "sig"      : sig,
    }


def _build_rationale(sig, dominant, reco, mode, stop, target, pos, note_cash):
    parts = []

    # Signal context
    if mode == "GoldPro":
        if dominant == "BRK":
            parts.append(f"Breakout Donchian 55j (prix > {sig['donchian_hi']:.2f}$) avec ADX {sig['adx']:.1f}")
        elif dominant == "WEAK":
            parts.append(f"Prix sous EMA Fast {sig['ema_fast']:.2f}$ en position Gold Pro — momentum s'affaiblit")
        elif dominant == "EXIT":
            parts.append(f"Prix sous Chandelier {sig['chandelier']:.2f}$ ou Donchian Lo — signal de sortie turtle")
        else:
            dh = sig.get("donchian_hi")
            ch = sig.get("chandelier")
            pct = ((sig["close"] / dh - 1) * 100) if dh else 0
            parts.append(f"Gold Pro HOLD — {pct:.1f}% du target Donchian {dh:.2f}$, Chandelier trailing {ch:.2f}$")

    elif mode == "Supertrend":
        st = sig.get("supertrend")
        if st:
            direction = "au-dessus" if sig["close"] > st else "en-dessous"
            parts.append(f"Supertrend {st:.2f}$ — prix {direction} ({'+' if sig['close'] > st else '-'}{abs(sig['close']-st):.2f}$)")
        parts.append(f"ADX {sig['adx']:.1f} ({'tendance forte' if sig['adx'] > 25 else 'tendance faible' if sig['adx'] < 15 else 'tendance modérée'})")

    else:  # V4
        if sig["bull_align"]:
            parts.append(f"EMAs haussières alignées (Fast {sig['ema_fast']:.2f}$ sous le prix)")
        elif sig["bear_align"]:
            parts.append(f"EMAs baissières alignées — structure dégradée")
        if dominant == "WEAK":
            parts.append(f"WEAK : prix retombé sous EMA Fast — momentum cassé, sortir")
        elif dominant == "BRK":
            parts.append(f"BRK : croisement EMA haussier avec volume et alignement complet")

    # P&L context
    if pos:
        if abs(pos["pnl_pct"]) > 20:
            parts.append(f"Gain exceptionnel {pos['pnl_pct']:+.1f}% — envisager stop trail serré")
        elif pos["pnl_pct"] < -3:
            parts.append(f"Position perdante {pos['pnl_pct']:+.1f}% — surveiller stop {stop:.2f}$ de près")

    if note_cash:
        parts.append(note_cash)

    return " | ".join(parts) if parts else "Aucun signal actif — attendre confirmation"


# ─── RAPPORT MARKDOWN ───────────────────────────────────────────────────────

def build_report(positions_analysis: list, watchlist_analysis: list,
                 account: dict, today: str) -> str:
    nlv   = account.get("NetLiquidation", NLV_CAD)
    cash  = account.get("AvailableFunds", 0)
    total_invested = sum(a["pnl"]["value"] for a in positions_analysis if a["pnl"])

    # Résumé exécutif
    exits  = [a for a in positions_analysis if a["reco"] == "VENDRE"]
    brks   = [a for a in positions_analysis + watchlist_analysis if a["dominant"] in ("BRK", "PB")]
    risks  = [a for a in positions_analysis if a["dominant"] in ("WEAK", "EXIT", "SELL")]

    exec_summary = []
    if exits:
        exec_summary.append(f"SORTIE recommandée sur {', '.join(a['ticker'] for a in exits)}")
    if brks:
        exec_summary.append(f"Signal BRK/PB actif sur {', '.join(a['ticker'] for a in brks)}")
    if cash < 500:
        exec_summary.append(f"Cash critique : {cash:.0f} CAD — aucun ajout possible avant libération de liquidité")

    # Corrélations gold
    gold_positions = [a for a in positions_analysis
                      if a["mode"] == "GoldPro" or "CGG" in a["ticker"]]
    gold_pct = sum(a["pnl"]["pct_cap"] for a in gold_positions if a["pnl"])

    lines = [
        f"# Analyse IA Portefeuille — {today}",
        "",
        "## Résumé Exécutif",
        " ".join(exec_summary) if exec_summary else "Portefeuille stable, aucun signal d'urgence.",
        f"NLV {nlv:,.0f} CAD | Investi {total_invested:,.0f} CAD ({total_invested/nlv*100:.1f}%) | Cash ~{cash:,.0f} CAD",
        "",
        "---",
        "",
        "## Positions IBKR",
    ]

    for a in positions_analysis:
        p   = a["pnl"]
        stop_str   = f"{a['stop']:.2f}$" if a["stop"] else "N/A"
        target_str = f"{a['target']:.2f}$" if a["target"] else "N/A"
        sz_str     = fmt_sizing(a["sizing"], a["price"]) if a["reco"] in ("AJOUTER", "ENTRER") else (
            f"{p['qty']} actions × {a['price']:.2f}$ = {p['value']:,.0f}$ ({p['pct_cap']}% capital)"
            if p else "N/A"
        )
        if a["reco"] == "VENDRE" and p:
            sz_str = f"VENDRE {p['qty']} actions × {a['price']:.2f}$ = {p['value']:,.0f}$ CAD récupérés"

        lines += [
            "",
            f"### {a['ticker']} — {a['reco']} {a['emoji']}",
            f"- Prix : {a['price']:.2f}$ | Moy : {p['avg']:.2f}$ | P&L : {p['pnl_pct']:+.2f}% ({p['pnl_cad']:+.0f} CAD)" if p else f"- Prix : {a['price']:.2f}$",
            f"- Signal : {a['dominant']} | Mode : {a['mode']} | ADX : {a['adx']:.1f}",
            f"- Stop : {stop_str} | Target : {target_str}",
            f"- Sizing : {sz_str}",
            f"- Pourquoi : {a['rationale']}",
        ]

    # Watchlist
    active_wl = [a for a in watchlist_analysis if a["dominant"] in ("BRK", "PB", "ADD")]
    lines += [
        "",
        "---",
        "",
        "## Watchlist — Setups actifs",
    ]

    if active_wl:
        for a in active_wl:
            stop_str   = f"{a['stop']:.2f}$" if a["stop"] else "N/A"
            target_str = f"{a['target']:.2f}$" if a["target"] else "N/A"
            sz_str     = fmt_sizing(a["sizing"], a["price"])
            lines += [
                "",
                f"### {a['ticker']} — {a['reco']} {a['emoji']}",
                f"- Prix : {a['price']:.2f}$ | Signal : {a['dominant']} | Mode : {a['mode']} | ADX : {a['adx']:.1f}",
                f"- Stop : {stop_str} | Target : {target_str}",
                f"- Sizing : {sz_str}",
                f"- Pourquoi : {a['rationale']}",
            ]
    else:
        lines.append("Aucun setup BRK/PB actif sur la watchlist aujourd'hui.")

    # Portfolio global
    lines += [
        "",
        "---",
        "",
        "## Portfolio Global",
        f"- **NLV** : {nlv:,.0f} CAD | **Investi** : {total_invested:,.0f}$ ({total_invested/nlv*100:.1f}%) | **Cash** : ~{cash:,.0f} CAD",
        f"- **Corrélations** : Exposition Gold/Métaux {gold_pct:.0f}% du capital"
        + (" ⚠️ — concentration élevée" if gold_pct > 40 else ""),
    ]

    # Priorité #1
    if exits:
        priority = f"VENDRE {exits[0]['ticker']} — libère {exits[0]['pnl']['value']:,.0f} CAD"
    elif active_wl and cash >= 500:
        priority = f"ENTRER {active_wl[0]['ticker']} — signal {active_wl[0]['dominant']} actif"
    elif risks:
        priority = f"Surveiller stop de {risks[0]['ticker']} — signal {risks[0]['dominant']}"
    else:
        priority = "Maintenir les positions, aucune action urgente"

    lines += [f"- **Priorité #1** : {priority}", ""]

    # Risques
    lines += [
        "---",
        "",
        "## Risques",
    ]

    risk_items = []
    if gold_pct > 40:
        risk_items.append(f"**Concentration Gold** : {gold_pct:.0f}% du capital sur métaux précieux — corrélé au cours de l'or")
    for a in positions_analysis:
        if a["mode"] == "Supertrend" and a["stop"] and a["price"] < a["stop"]:
            risk_items.append(f"**{a['ticker']} Supertrend bearish** : prix {a['price']:.2f}$ sous Supertrend {a['stop']:.2f}$ — résistance majeure")
    if cash < 300:
        risk_items.append(f"**Liquidité critique** : {cash:.0f} CAD — impossible de réagir à une opportunité ou de gérer un stop")
    for a in positions_analysis:
        if a["pnl"] and a["pnl"]["pnl_pct"] < -5:
            risk_items.append(f"**{a['ticker']} en perte** : {a['pnl']['pnl_pct']:+.1f}% — stop {a['stop']:.2f}$ à surveiller")

    if not risk_items:
        risk_items.append("Aucun risque critique identifié — maintenir les stops en place")

    for item in risk_items[:4]:  # max 4 risques
        lines.append(f"- {item}")

    return "\n".join(lines)


# ─── EMAIL ──────────────────────────────────────────────────────────────────

def send_email(report: str, today: str, positions_analysis: list):
    # Construire sujet selon contenu
    exits  = [a for a in positions_analysis if a["reco"] == "VENDRE"]
    brks   = [a for a in positions_analysis if a["dominant"] in ("BRK", "PB")]

    if exits and brks:
        subject = f"[Scan IA] {today} — {exits[0]['ticker']} SORTIE + {brks[0]['ticker']} BRK"
        preview = f"Exit {exits[0]['ticker']} | BRK {brks[0]['ticker']} | {len(positions_analysis)} positions analysées"
    elif exits:
        subject = f"[Scan IA] {today} — SORTIE {', '.join(a['ticker'] for a in exits)}"
        preview = f"Signal WEAK/EXIT sur {', '.join(a['ticker'] for a in exits)} — action requise"
    elif brks:
        subject = f"[Scan IA] {today} — BRK {brks[0]['ticker']}"
        preview = f"Breakout actif sur {brks[0]['ticker']} — vérifier entrée"
    else:
        subject = f"[Scan IA] {today} — rapport quotidien TSX"
        preview = f"Analyse {len(positions_analysis)} positions IBKR — aucun signal urgent"

    # Écrire fichier temporaire
    REPORTS_DIR.mkdir(exist_ok=True)
    tmp_path = REPORTS_DIR / f".tmp_scan_{today}.md"
    tmp_path.write_text(report, encoding="utf-8")

    # Envoyer via mail_report.js
    try:
        result = subprocess.run(
            ["node", str(MAIL_SCRIPT), subject, preview, str(tmp_path)],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            print(f"Email envoyé : {result.stdout.strip()}")
        else:
            print(f"Erreur email : {result.stderr.strip()}")
    finally:
        tmp_path.unlink(missing_ok=True)
        print("Fichier temporaire supprimé")


# ─── MAIN ───────────────────────────────────────────────────────────────────

def main():
    today = date.today().isoformat()
    print(f"\n{'='*60}")
    print(f"  Scan IA TSX — {today}")
    print(f"{'='*60}\n")

    client = IBKRClient()
    client.connect()

    try:
        # ── Étape 1 : Positions & compte ────────────────────────────────────
        print("Étape 1 — Lecture positions IBKR...")
        positions = client.get_positions()
        account   = client.get_account_summary()
        nlv       = account.get("NetLiquidation", NLV_CAD)
        cash      = account.get("AvailableFunds", 0)

        print(f"  Positions : {len(positions)} | NLV : {nlv:,.0f} CAD | Cash : {cash:,.0f} CAD")
        for p in positions:
            print(f"  {p['ticker']}: {p['qty']} x {p['avg_price']}$ -> {p['last_price']}$ ({p['pnl_pct']:+.2f}%)")

        position_tickers = {p["ticker"].upper().replace(".", "") for p in positions}

        # ── Étape 2 : Données techniques par position ────────────────────────
        print("\nÉtape 2 — Calcul Momentum V4 par position...")
        positions_analysis = []

        pos_map = {p["ticker"].upper(): p for p in positions}

        for pos in positions:
            ticker = pos["ticker"]
            print(f"  → {ticker}...")
            try:
                df  = client.get_ohlcv(ticker, bars=OHLCV_BARS)
                sig = compute_signals(df, ticker)
                analysis = analyse_ticker(sig, pos, cash)
                positions_analysis.append(analysis)
                print(f"     Signal: {analysis['dominant']} | Reco: {analysis['reco']} | "
                      f"Stop: {sig.get('chandelier') or sig.get('supertrend') or sig.get('ema_fast'):.2f}$")
            except Exception as e:
                print(f"  ERREUR {ticker}: {e}")

        # ── Étape 3 : Watchlist (si cash disponible) ────────────────────────
        print("\nÉtape 3 — Watchlist...")
        watchlist_analysis = []

        for ticker in WATCHLIST:
            ticker_clean = ticker.replace(".", "").replace("-", "").upper()
            if any(ticker_clean in t.upper() for t in position_tickers):
                continue  # Déjà en position

            if cash < 500:
                print(f"  Watchlist ignorée — cash insuffisant ({cash:.0f} CAD)")
                break

            print(f"  → {ticker}...")
            try:
                df  = client.get_ohlcv(ticker, bars=OHLCV_BARS)
                sig = compute_signals(df, ticker)
                analysis = analyse_ticker(sig, None, cash)
                watchlist_analysis.append(analysis)
                print(f"     Signal: {analysis['dominant']}")
            except Exception as e:
                print(f"  ERREUR {ticker}: {e}")

        # ── Étape 4 : Rapport + Email ────────────────────────────────────────
        print("\nÉtape 4 — Génération rapport...")
        report = build_report(positions_analysis, watchlist_analysis, account, today)

        print("\nÉtape 5 — Envoi email...")
        send_email(report, today, positions_analysis)

        print(f"\n{'='*60}")
        print(f"  Scan terminé — {datetime.now().strftime('%H:%M:%S')}")
        print(f"{'='*60}\n")

    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
