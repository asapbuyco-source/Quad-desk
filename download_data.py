"""Download 5 years of 15m futures data for BTC/ETH/SOL + BNB/XRP/DOGE/LINK."""
import time
from datetime import datetime, timedelta

import pandas as pd
import requests

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT"]
YEARS = 5
INTERVAL = "15m"


def fetch(symbol):
    end_dt = datetime.now()
    start_dt = end_dt - timedelta(days=int(365 * YEARS))
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)
    all_klines = []
    cur = start_ms
    page = 0
    while cur < end_ms:
        page += 1
        try:
            resp = requests.get(
                "https://fapi.binance.com/fapi/v1/klines",
                params={"symbol": symbol, "interval": INTERVAL,
                        "startTime": cur, "endTime": end_ms, "limit": 1500},
                timeout=30,
            )
            resp.raise_for_status()
            batch = resp.json()
        except Exception as e:
            print(f"  {symbol} page {page} error: {e}")
            time.sleep(2)
            continue
        if not batch:
            break
        all_klines.extend(batch)
        cur = int(batch[-1][0]) + 1
        if len(batch) < 1500:
            break
        if page % 10 == 0:
            print(f"  {symbol}: {len(all_klines):,} bars...")
        time.sleep(0.15)
    if not all_klines:
        return None
    cols = ['time', 'open', 'high', 'low', 'close', 'volume',
            'close_time', 'quote_vol', 'trades',
            'taker_buy_base', 'taker_buy_quote', 'ignore']
    df = pd.DataFrame(all_klines, columns=cols)
    df['time'] = pd.to_datetime(df['time'].astype(int), unit='ms')
    df.set_index('time', inplace=True)
    for c in ('open', 'high', 'low', 'close', 'volume', 'taker_buy_base'):
        df[c] = df[c].astype(float)
    df = df[['open', 'high', 'low', 'close', 'volume', 'taker_buy_base']]

    # Funding rate
    fr_list = []
    fr_cur = start_ms
    while fr_cur < end_ms:
        try:
            resp = requests.get(
                "https://fapi.binance.com/fapi/v1/fundingRate",
                params={"symbol": symbol, "startTime": fr_cur, "endTime": end_ms, "limit": 1000},
                timeout=30,
            )
            resp.raise_for_status()
            batch = resp.json()
        except Exception:
            time.sleep(2)
            continue
        if not batch:
            break
        fr_list.extend(batch)
        fr_cur = int(batch[-1]['fundingTime']) + 1
        if len(batch) < 1000:
            break
        time.sleep(0.15)
    if fr_list:
        fr_df = pd.DataFrame(fr_list)
        fr_df['time'] = pd.to_datetime(fr_df['fundingTime'].astype(int), unit='ms')
        fr_df['funding_rate'] = fr_df['fundingRate'].astype(float)
        fr_df.set_index('time', inplace=True)
        fr_df = fr_df[~fr_df.index.duplicated(keep='last')][['funding_rate']]
        df = df.join(fr_df, how='left')
        df['funding_rate'] = df['funding_rate'].ffill().fillna(0.0)
    else:
        df['funding_rate'] = 0.0

    df.to_pickle(f"data/{symbol}_15m_cached.pkl")
    print(f"  {symbol}: saved {len(df):,} bars ({df.index[0].date()} -> {df.index[-1].date()})")
    return df


if __name__ == "__main__":
    import os
    os.makedirs("data", exist_ok=True)
    for sym in SYMBOLS:
        print(f"Downloading {sym} ({YEARS}yr)...")
        try:
            fetch(sym)
        except Exception as e:
            print(f"  {sym} FAILED: {e}")
    print("Done.")