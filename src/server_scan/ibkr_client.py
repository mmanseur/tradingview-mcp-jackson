"""
ibkr_client.py — Client IBKR Gateway via ib_insync

Fournit :
  • get_positions()          → liste des positions ouvertes
  • get_ohlcv(ticker, n)     → DataFrame OHLCV (barres daily)

Prérequis :
  • IB Gateway lancé (port 4001 live / 4002 paper)
  • ib_insync installé : pip install ib_insync

Configuration :
  Modifier les constantes HOST / PORT / CLIENT_ID selon votre setup.
"""

import time
import pandas as pd
from datetime import datetime, timedelta
from ib_insync import IB, Stock, util

# ─── CONFIG ─────────────────────────────────────────────────────────────────

HOST       = "127.0.0.1"
PORT       = 4001        # 4001 = Gateway live | 4002 = Gateway paper
CLIENT_ID  = 10          # ID unique par connexion (éviter conflits)
ACCOUNT_ID = "U22347486" # Compte de trading principal (TSX)
EXCHANGE   = "TSE"       # Toronto Stock Exchange
CURRENCY   = "CAD"
TIMEOUT    = 30          # secondes

# Mapping ticker → symbole IBKR si différent du format standard
# Par défaut : IBKR accepte les symboles TSX avec le point (BBD.B, etc.)
TICKER_MAP: dict[str, str] = {}


# ─── CONNEXION ──────────────────────────────────────────────────────────────

class IBKRClient:

    def __init__(self):
        self.ib = IB()

    def connect(self):
        print(f"Connexion IBKR Gateway {HOST}:{PORT} (clientId={CLIENT_ID})...")
        self.ib.connect(HOST, PORT, clientId=CLIENT_ID, timeout=TIMEOUT)
        print(f"Connecté — compte : {self.ib.managedAccounts()}")

    def disconnect(self):
        self.ib.disconnect()
        print("Déconnecté de IBKR Gateway")

    # ── POSITIONS ───────────────────────────────────────────────────────────

    def get_positions(self) -> list[dict]:
        """
        Retourne la liste des positions ouvertes.

        Format retourné :
        [
            {
                "ticker"    : "WPM",
                "qty"       : 15,
                "avg_price" : 202.51,
                "last_price": 209.23,
                "pnl_pct"   : 3.32,
                "pnl_cad"   : 100.8,
                "value_cad" : 3138.45,
            },
            ...
        ]
        """
        positions = self.ib.positions(account=ACCOUNT_ID)
        result = []

        for pos in positions:
            contract = pos.contract
            # Filtrer uniquement TSE
            if contract.exchange not in (EXCHANGE, "SMART") and contract.primaryExchange != EXCHANGE:
                continue

            ticker_raw = contract.symbol.replace(" ", ".")  # "BBD B" → "BBD.B"
            qty        = pos.position
            avg        = pos.avgCost

            # Prix de marché en temps réel
            self.ib.qualifyContracts(contract)
            ticker_obj = self.ib.reqMktData(contract, "", False, False)
            self.ib.sleep(1.5)  # attente snapshot

            last = ticker_obj.last if ticker_obj.last and ticker_obj.last > 0 else ticker_obj.close
            self.ib.cancelMktData(contract)

            if not last or last <= 0:
                last = avg  # fallback

            pnl_cad = (last - avg) * qty
            pnl_pct = ((last - avg) / avg * 100) if avg > 0 else 0.0

            result.append({
                "ticker"    : ticker_raw,
                "qty"       : int(qty),
                "avg_price" : round(avg, 4),
                "last_price": round(last, 4),
                "pnl_pct"   : round(pnl_pct, 2),
                "pnl_cad"   : round(pnl_cad, 2),
                "value_cad" : round(last * qty, 2),
            })

        return result

    # ── OHLCV HISTORIQUE ────────────────────────────────────────────────────

    def get_ohlcv(self, ticker: str, bars: int = 300) -> pd.DataFrame:
        """
        Récupère les barres daily OHLCV depuis IBKR Gateway.

        Paramètres :
            ticker : ex "WPM", "BBD.B", "CGG"
            bars   : nombre de barres (300 = ~14 mois de données daily)

        Retourne :
            DataFrame avec colonnes open/high/low/close/volume, index DatetimeIndex trié croissant.
        """
        ib_symbol = TICKER_MAP.get(ticker.upper(), ticker)

        contract = Stock(ib_symbol, EXCHANGE, CURRENCY)
        self.ib.qualifyContracts(contract)

        # IBKR: durationStr = "1 Y" donne ~252 barres, "2 Y" donne ~504
        duration = "2 Y" if bars > 252 else "1 Y"

        print(f"  Téléchargement {ticker} ({duration}, barSize=1 day)...")
        bars_data = self.ib.reqHistoricalData(
            contract,
            endDateTime="",         # maintenant
            durationStr=duration,
            barSizeSetting="1 day",
            whatToShow="TRADES",
            useRTH=True,
            formatDate=1,
        )

        if not bars_data:
            raise ValueError(f"Aucune donnée OHLCV pour {ticker} — Gateway connecté ?")

        df = util.df(bars_data)
        df = df.rename(columns={"date": "datetime", "barCount": "bar_count"})
        df["datetime"] = pd.to_datetime(df["datetime"])
        df = df.set_index("datetime").sort_index()
        df = df[["open", "high", "low", "close", "volume"]]

        # Garder seulement les N dernières barres
        if len(df) > bars:
            df = df.iloc[-bars:]

        print(f"  {ticker} : {len(df)} barres récupérées ({df.index[0].date()} → {df.index[-1].date()})")
        return df

    # ── NLV / CASH ──────────────────────────────────────────────────────────

    def get_account_summary(self) -> dict:
        """Retourne NLV, cash disponible et excess liquidity."""
        summary = self.ib.accountSummary(account=ACCOUNT_ID)
        result  = {}
        for item in summary:
            if item.tag in ("NetLiquidation", "AvailableFunds", "ExcessLiquidity", "TotalCashValue"):
                result[item.tag] = float(item.value)
        return result


# ─── STANDALONE USAGE ───────────────────────────────────────────────────────

if __name__ == "__main__":
    client = IBKRClient()
    client.connect()

    print("\n=== Positions ouvertes ===")
    positions = client.get_positions()
    for p in positions:
        print(f"  {p['ticker']}: {p['qty']} × {p['avg_price']}$ → {p['last_price']}$ "
              f"({p['pnl_pct']:+.2f}%, {p['pnl_cad']:+.0f} CAD)")

    print("\n=== Compte ===")
    acct = client.get_account_summary()
    for k, v in acct.items():
        print(f"  {k}: {v:,.2f} CAD")

    print("\n=== Test OHLCV WPM ===")
    df = client.get_ohlcv("WPM", bars=300)
    print(df.tail(3))

    client.disconnect()
