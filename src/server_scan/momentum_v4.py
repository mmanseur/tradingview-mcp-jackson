"""
momentum_v4.py — Traduction fidèle de Momentum V4 [Unified] (Pine Script v6)

3 modes auto-détectés selon le ticker :
  • WPM / AEM        → Gold Momentum Pro  (EMA 13/26/55, Donchian turtle, Chandelier)
  • BBD / CLS        → Supertrend         (ATR×3, période 10, stateful)
  • Tous les autres  → Momentum V4        (EMA 8/21/50, croisement + volume)

Usage :
    df = pd.DataFrame avec colonnes open/high/low/close/volume, index datetime, tri croissant
    result = compute_signals(df, "WPM")
    print(result["brk"], result["donchian_hi"])
"""

import numpy as np
import pandas as pd


# ─── HELPERS ────────────────────────────────────────────────────────────────

def _ema(series: pd.Series, length: int) -> pd.Series:
    return series.ewm(span=length, adjust=False).mean()


def _sma(series: pd.Series, length: int) -> pd.Series:
    return series.rolling(length).mean()


def _wilder(series: pd.Series, length: int) -> pd.Series:
    """Wilder smoothing (RMA) — identique à ta.rma() Pine Script.
    alpha = 1/length, première valeur = SMA(length)."""
    alpha = 1.0 / length
    result = np.full(len(series), np.nan)
    # Chercher le premier index valide après `length` barres
    vals = series.values
    start = length - 1
    while start < len(vals) and np.isnan(vals[start]):
        start += 1
    if start >= len(vals):
        return pd.Series(result, index=series.index)
    # Initialisation SMA sur les `length` premières valeurs
    window = vals[start - length + 1: start + 1]
    result[start] = np.nanmean(window)
    for i in range(start + 1, len(vals)):
        if np.isnan(vals[i]):
            result[i] = result[i - 1]
        else:
            result[i] = result[i - 1] * (1 - alpha) + vals[i] * alpha
    return pd.Series(result, index=series.index)


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    """ATR avec Wilder smoothing — identique à ta.atr() Pine Script."""
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low  - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    return _wilder(tr, length)


def _adx(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    """ADX avec Wilder smoothing — identique à ta.dmi() Pine Script."""
    up   = high.diff()
    down = -low.diff()
    plus_dm  = pd.Series(np.where((up > down) & (up > 0),   up,   0.0), index=high.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=high.index)

    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low  - close.shift(1)).abs(),
    ], axis=1).max(axis=1)

    atr_base = _wilder(tr,       length)
    plus_w   = _wilder(plus_dm,  length)
    minus_w  = _wilder(minus_dm, length)

    plus_di  = 100 * plus_w  / atr_base.replace(0, np.nan)
    minus_di = 100 * minus_w / atr_base.replace(0, np.nan)
    dx       = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx      = _wilder(dx, length)
    return adx


# ─── GOLD MOMENTUM PRO ──────────────────────────────────────────────────────

def _gold_signals(close, high, low, open_, volume,
                  ema_fast, ema_mid, ema_slow, atr14,
                  bull_align, adx):
    n = len(close)
    adx_ok = adx > 20.0

    # Donchian channels (Pine: high[1] = shifted by 1 before rolling)
    entry_high = high.shift(1).rolling(55).max()   # ta.highest(high[1], 55)
    add_high   = high.shift(1).rolling(20).max()   # ta.highest(high[1], 20)
    exit_low   = low.shift(1).rolling(20).min()    # ta.lowest(low[1], 20)
    chandelier = high.rolling(22).max() - atr14 * 4.5

    # Stateful variables
    in_pos   = False
    entry_bar = 0
    adds     = 0

    brk_arr  = np.zeros(n, dtype=bool)
    pb_arr   = np.zeros(n, dtype=bool)
    add_arr  = np.zeros(n, dtype=bool)
    exit_arr = np.zeros(n, dtype=bool)
    weak_arr = np.zeros(n, dtype=bool)
    adds_arr = np.zeros(n, dtype=int)
    inpos_arr = np.zeros(n, dtype=bool)

    for i in range(n):
        c   = close.iloc[i]
        ef  = ema_fast.iloc[i]
        l   = low.iloc[i]
        ba  = bool(bull_align.iloc[i])
        aok = bool(adx_ok.iloc[i]) if not pd.isna(adx_ok.iloc[i]) else False
        eh  = entry_high.iloc[i]
        ah  = add_high.iloc[i]
        el  = exit_low.iloc[i]
        ch  = chandelier.iloc[i]
        eh5 = entry_high.iloc[i - 5] if i >= 5 else np.nan

        if pd.isna(eh) or pd.isna(ef):
            inpos_arr[i] = in_pos
            adds_arr[i]  = adds
            continue

        gp_brk_raw = (c > eh) and ba and aok and not in_pos
        gp_pb_raw  = (c > ef and l < ef and
                      (not pd.isna(eh5) and c > eh5) and
                      ba and aok and not gp_brk_raw and not in_pos)

        if (gp_brk_raw or gp_pb_raw) and not in_pos:
            in_pos    = True
            entry_bar = i
            adds      = 0

        brk_arr[i] = gp_brk_raw
        pb_arr[i]  = gp_pb_raw

        # ADD : new 20-day high while in position, max 2 pyramiding, 10+ bars after entry
        if not pd.isna(ah):
            gp_add_raw = (in_pos and c > ah and aok and
                          adds < 2 and (i - entry_bar) >= 10)
            if gp_add_raw:
                adds += 1
            add_arr[i] = gp_add_raw

        # EXIT : close below 20-day low OR below Chandelier
        if not pd.isna(el) and not pd.isna(ch):
            gp_exit_raw = in_pos and (c < el or c < ch)
            if gp_exit_raw:
                in_pos = False
                adds   = 0
            exit_arr[i] = gp_exit_raw

            weak_arr[i] = in_pos and c < ef and not exit_arr[i]

        inpos_arr[i] = in_pos
        adds_arr[i]  = adds

    idx = close.index
    return (
        pd.Series(brk_arr,   index=idx),
        pd.Series(pb_arr,    index=idx),
        pd.Series(add_arr,   index=idx),
        pd.Series(exit_arr,  index=idx),
        pd.Series(weak_arr,  index=idx),
        pd.Series(inpos_arr, index=idx),
        pd.Series(adds_arr,  index=idx),
        entry_high, exit_low, chandelier,
    )


# ─── SUPERTREND ─────────────────────────────────────────────────────────────

def _supertrend(high: pd.Series, low: pd.Series, close: pd.Series) -> tuple:
    """Returns (st_line, st_trend, st_upper, st_lower) as Series."""
    st_atr         = _atr(high, low, close, length=10)
    hl2            = (high + low) / 2
    basic_upper    = hl2 + 3.0 * st_atr
    basic_lower    = hl2 - 3.0 * st_atr

    n = len(close)
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    trend = np.ones(n, dtype=int)

    for i in range(n):
        bu = basic_upper.iloc[i]
        bl = basic_lower.iloc[i]
        if pd.isna(bu) or pd.isna(bl):
            continue

        if i == 0 or np.isnan(upper[i - 1]):
            upper[i] = bu
            lower[i] = bl
            trend[i] = 1
        else:
            # Upper band : only tighten (lower) unless price closed above previous upper
            upper[i] = bu if (bu < upper[i-1] or close.iloc[i-1] > upper[i-1]) else upper[i-1]
            # Lower band : only tighten (higher) unless price closed below previous lower
            lower[i] = bl if (bl > lower[i-1] or close.iloc[i-1] < lower[i-1]) else lower[i-1]
            # Trend flip
            if   trend[i-1] == -1 and close.iloc[i] > upper[i-1]:
                trend[i] = 1
            elif trend[i-1] ==  1 and close.iloc[i] < lower[i-1]:
                trend[i] = -1
            else:
                trend[i] = trend[i-1]

    idx     = close.index
    upper_s = pd.Series(upper, index=idx)
    lower_s = pd.Series(lower, index=idx)
    trend_s = pd.Series(trend, index=idx)
    line_s  = pd.Series(
        np.where(trend == 1, lower, upper),
        index=idx
    )
    return line_s, trend_s, upper_s, lower_s


def _supertrend_signals(close, high, low, st_line, st_trend, st_upper, st_lower):
    st_bull    = st_trend == 1
    st_cross_up = (st_trend == 1)  & (st_trend.shift(1) == -1)
    st_cross_dn = (st_trend == -1) & (st_trend.shift(1) ==  1)

    st_brk  = st_cross_up
    st_pb   = (st_bull &
               (low <= st_lower * 1.005) &
               (close > st_lower) &
               ~st_brk)
    st_exit = st_cross_dn
    st_weak = (st_bull &
               (close < (st_lower + (st_upper - st_lower) * 0.3)) &
               ~st_exit)
    return st_brk, st_pb, st_exit, st_weak, st_bull


# ─── MOMENTUM V4 STANDARD ───────────────────────────────────────────────────

def _v4_signals(close, high, low, open_, volume,
                ema_fast, ema_mid, ema_slow,
                bull_align, bear_align, is_gold):
    n = len(close)
    vol_sma  = _sma(volume.astype(float), 20)
    vol_mult = 2.0 if is_gold else 1.3
    vol_ok   = volume >= vol_sma * vol_mult

    above_all   = (close > ema_fast) & (close > ema_mid) & (close > ema_slow)
    below_all   = (close < ema_fast) & (close < ema_mid) & (close < ema_slow)
    bull_candle = (close > open_) & (close > ema_fast)
    bear_candle = (close < open_) & (close < ema_fast)
    cross_up    = (ema_fast > ema_mid) & (ema_fast.shift(1) <= ema_mid.shift(1))
    cross_dn    = (ema_fast < ema_mid) & (ema_fast.shift(1) >= ema_mid.shift(1))

    # Cooldown : min 3 bars between signals
    bars_since = 99
    brk_arr  = np.zeros(n, dtype=bool)
    sell_arr = np.zeros(n, dtype=bool)

    for i in range(n):
        brk_raw  = (bool(bull_align.iloc[i]) and bool(vol_ok.iloc[i]) and
                    bool(bull_candle.iloc[i]) and bool(above_all.iloc[i]) and
                    bool(cross_up.iloc[i]))
        sell_raw = (bool(bear_align.iloc[i]) and bool(vol_ok.iloc[i]) and
                    bool(bear_candle.iloc[i]) and bool(below_all.iloc[i]) and
                    bool(cross_dn.iloc[i]))

        if brk_raw and bars_since >= 3:
            brk_arr[i] = True
            bars_since = 0
        elif sell_raw and bars_since >= 3:
            sell_arr[i] = True
            bars_since = 0
        else:
            bars_since += 1

    idx     = close.index
    v4_brk  = pd.Series(brk_arr,  index=idx)
    v4_sell = pd.Series(sell_arr, index=idx)
    v4_pb   = (bull_align & (low <= ema_fast * 1.005) &
               (close > ema_fast) & (close > open_) & ~v4_brk)
    v4_weak = bull_align & (close < ema_fast) & ~v4_sell

    return v4_brk, v4_pb, v4_sell, v4_weak


# ─── MAIN ENTRY POINT ───────────────────────────────────────────────────────

def compute_signals(df: pd.DataFrame, ticker: str) -> dict:
    """
    Calcule les signaux Momentum V4 [Unified] pour la dernière barre du DataFrame.

    Paramètres :
        df     : DataFrame avec colonnes open/high/low/close/volume, index datetime,
                 trié croissant. Minimum 200 barres recommandé.
        ticker : Symbole (ex: "WPM", "BBD.B", "CGG")

    Retourne :
        dict avec tous les champs du data window TradingView + valeurs des indicateurs.
    """
    if len(df) < 60:
        raise ValueError(f"Pas assez de barres ({len(df)}) — minimum 60 requis")

    ticker_up  = ticker.upper()
    is_gold    = "WPM" in ticker_up or "AEM" in ticker_up
    is_st      = "BBD" in ticker_up or "CLS" in ticker_up

    close  = df["close"].astype(float)
    high   = df["high"].astype(float)
    low    = df["low"].astype(float)
    open_  = df["open"].astype(float)
    volume = df["volume"].astype(float)

    # ── EMAs ────────────────────────────────────────────────────────────────
    f = 13 if is_gold else 8
    m = 26 if is_gold else 21
    s = 55 if is_gold else 50

    ema_fast = _ema(close, f)
    ema_mid  = _ema(close, m)
    ema_slow = _ema(close, s)
    atr14    = _atr(high, low, close, 14)
    adx      = _adx(high, low, close, 14)

    bull_align = (ema_fast > ema_mid) & (ema_mid > ema_slow)
    bear_align = (ema_fast < ema_mid) & (ema_mid < ema_slow)

    # ── Compute mode-specific signals ───────────────────────────────────────
    false_s = pd.Series(np.zeros(len(df), dtype=bool), index=df.index)

    donchian_hi = chandelier_s = donchian_lo = supertrend_line = None
    supertrend_bull = None
    pyramid_count = 0
    gp_in_pos_val = None

    if is_gold:
        (sig_brk, sig_pb, sig_add, sig_exit, sig_weak,
         inpos_s, adds_s,
         donchian_hi, donchian_lo, chandelier_s) = _gold_signals(
            close, high, low, open_, volume,
            ema_fast, ema_mid, ema_slow, atr14,
            bull_align, adx
        )
        sig_sell = false_s
        pyramid_count = int(adds_s.iloc[-1])
        gp_in_pos_val = bool(inpos_s.iloc[-1])

    elif is_st:
        st_line, st_trend, st_upper, st_lower = _supertrend(high, low, close)
        sig_brk, sig_pb, sig_exit, sig_weak, st_bull = _supertrend_signals(
            close, high, low, st_line, st_trend, st_upper, st_lower
        )
        sig_add  = false_s
        sig_sell = false_s
        supertrend_line = st_line
        supertrend_bull = st_bull

    else:
        sig_brk, sig_pb, sig_sell, sig_weak = _v4_signals(
            close, high, low, open_, volume,
            ema_fast, ema_mid, ema_slow,
            bull_align, bear_align, is_gold
        )
        sig_add  = false_s
        sig_exit = false_s

    # ── Extract last bar values ──────────────────────────────────────────────
    def last(s):
        v = s.iloc[-1]
        return None if pd.isna(v) else float(v)

    def last_bool(s):
        v = s.iloc[-1]
        return False if pd.isna(v) else bool(v)

    return {
        # Identity
        "ticker"         : ticker,
        "mode"           : "GoldPro" if is_gold else ("Supertrend" if is_st else "V4"),
        "date"           : str(df.index[-1].date()),

        # Price
        "close"          : last(close),
        "open"           : last(open_),
        "high"           : last(high),
        "low"            : last(low),

        # EMAs
        "ema_fast"       : last(ema_fast),
        "ema_mid"        : last(ema_mid),
        "ema_slow"       : last(ema_slow),
        "bull_align"     : last_bool(bull_align),
        "bear_align"     : last_bool(bear_align),

        # ATR / ADX
        "atr14"          : last(atr14),
        "adx"            : last(adx),

        # Gold Pro specific
        "donchian_hi"    : last(donchian_hi) if donchian_hi is not None else None,
        "donchian_lo"    : last(donchian_lo) if donchian_lo is not None else None,
        "chandelier"     : last(chandelier_s) if chandelier_s is not None else None,
        "gp_in_pos"      : gp_in_pos_val,
        "pyramid_count"  : pyramid_count,

        # Supertrend specific
        "supertrend"     : last(supertrend_line) if supertrend_line is not None else None,
        "supertrend_bull": last_bool(supertrend_bull) if supertrend_bull is not None else None,

        # Signals (matching TradingView data window output)
        "brk"            : last_bool(sig_brk),
        "pb"             : last_bool(sig_pb),
        "add"            : last_bool(sig_add),
        "exit"           : last_bool(sig_exit),
        "sell"           : last_bool(sig_sell),
        "weak"           : last_bool(sig_weak),

        # IsGoldPro / IsSupertrend flags (mirrors Pine plot output)
        "is_gold_pro"    : is_gold,
        "is_supertrend"  : is_st,
    }
