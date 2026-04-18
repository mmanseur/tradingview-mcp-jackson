"""
export_positions.py — Exporte les positions IBKR vers positions.json et push sur GitHub

Usage :
    python export_positions.py              # export + git push
    python export_positions.py --dry-run   # export seulement, sans push

Planifier sur Windows (Task Scheduler) pour s'exécuter :
  - À l'ouverture de session
  - Toutes les heures pendant les heures de marché
  - Ou manuellement après chaque trade
"""

import io
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from ib_insync import IB, util

if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# ─── CONFIG ─────────────────────────────────────────────────────────────────

GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 4001
ACCOUNT_ID   = "U22347486"
CLIENT_ID    = 20           # ID différent des autres scripts

REPO_DIR     = Path("D:/Claude/tradingview-mcp-jackson")
OUTPUT_FILE  = REPO_DIR / "positions.json"

# ─── LECTURE POSITIONS ───────────────────────────────────────────────────────

def fetch_positions() -> dict:
    util.startLoop()
    ib = IB()
    ib.connect(GATEWAY_HOST, GATEWAY_PORT, clientId=CLIENT_ID, timeout=15)

    try:
        # Positions
        raw_positions = ib.positions(account=ACCOUNT_ID)
        positions = []
        for p in raw_positions:
            c = p.contract
            # Prix en temps réel
            ib.qualifyContracts(c)
            ticker = ib.reqMktData(c, "", False, False)
            ib.sleep(1.5)
            last = ticker.last if ticker.last and ticker.last > 0 else ticker.close
            ib.cancelMktData(c)
            if not last or last <= 0:
                last = p.avgCost

            symbol = c.symbol  # "WPM", "BBD.B", "VNP", "CGG"
            qty    = int(p.position)
            avg    = round(p.avgCost, 4)
            pnl_pct = round((last - avg) / avg * 100, 2) if avg > 0 else 0.0

            positions.append({
                "ticker"    : symbol,
                "qty"       : qty,
                "avg_price" : avg,
                "last_price": round(last, 4),
                "pnl_pct"   : pnl_pct,
                "pnl_cad"   : round((last - avg) * qty, 2),
                "value_cad" : round(last * qty, 2),
            })

        # Résumé compte
        summary = ib.accountSummary(account=ACCOUNT_ID)
        account = {}
        for item in summary:
            if item.tag in ("NetLiquidation", "AvailableFunds", "ExcessLiquidity", "TotalCashValue"):
                account[item.tag] = round(float(item.value), 2)

    finally:
        ib.disconnect()

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "account_id" : ACCOUNT_ID,
        "account"    : account,
        "positions"  : positions,
    }


# ─── GIT PUSH ────────────────────────────────────────────────────────────────

def git_push(data: dict) -> bool:
    """Commit et push positions.json sur GitHub."""
    n        = len(data["positions"])
    tickers  = ", ".join(p["ticker"] for p in data["positions"])
    msg      = f"positions: {n} positions ({tickers}) — {data['exported_at'][:10]}"

    cmds = [
        ["git", "-C", str(REPO_DIR), "add", str(OUTPUT_FILE)],
        ["git", "-C", str(REPO_DIR), "commit", "-m", msg],
        ["git", "-C", str(REPO_DIR), "push"],
    ]

    for cmd in cmds:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            # "nothing to commit" n'est pas une erreur
            if "nothing to commit" in result.stdout + result.stderr:
                print("  Git: aucun changement détecté — pas de commit nécessaire")
                return True
            print(f"  Git erreur ({' '.join(cmd[2:])}) : {result.stderr.strip()}")
            return False
        print(f"  Git: {result.stdout.strip() or 'OK'}")

    return True


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv
    print(f"Export positions IBKR -> {OUTPUT_FILE.name} {'(dry-run)' if dry_run else ''}")

    # 1. Lire les positions
    print("Connexion IB Gateway...")
    data = fetch_positions()

    # 2. Écrire le fichier JSON
    OUTPUT_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Écrit : {OUTPUT_FILE}")

    # 3. Afficher un résumé
    print(f"\nCompte {ACCOUNT_ID} :")
    print(f"  NLV   : {data['account'].get('NetLiquidation', 'N/A'):,.2f} CAD")
    print(f"  Cash  : {data['account'].get('AvailableFunds', 'N/A'):,.2f} CAD")
    print(f"\nPositions ({len(data['positions'])}) :")
    for p in data["positions"]:
        print(f"  {p['ticker']:8s} {p['qty']:3d} x {p['avg_price']:8.2f}$ | {p['last_price']:8.2f}$ ({p['pnl_pct']:+.2f}%)")

    # 4. Git push
    if not dry_run:
        print("\nPush sur GitHub...")
        ok = git_push(data)
        if ok:
            print("positions.json disponible sur GitHub")
        else:
            print("Push échoué — vérifier les droits git")
    else:
        print("\n[dry-run] Push ignoré")


if __name__ == "__main__":
    main()
