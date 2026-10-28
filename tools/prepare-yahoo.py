#!/usr/bin/env python3
"""Build the app's 30-asset adjusted-close dataset from Yahoo Finance CSVs.

Offline import uses only Python's standard library. --download optionally uses
yfinance on your own computer; no Yahoo request runs in a player's browser.
"""
import argparse
import calendar
import csv
from datetime import date
import json
import math
import os
from pathlib import Path
import tempfile


def read_prices(path):
    prices = {}
    with Path(path).open(newline='', encoding='utf-8-sig') as handle:
        reader = csv.DictReader(handle)
        if not {'Date', 'Adj Close'}.issubset(reader.fieldnames or []):
            raise ValueError(f'{path}: expected Yahoo CSV columns Date and Adj Close. Raw Close is not a substitute.')
        for row in reader:
            stamp = row['Date'].strip()
            parsed = date.fromisoformat(stamp)
            if parsed.isoformat() != stamp:
                raise ValueError(f'{path}: dates must use YYYY-MM-DD.')
            value = row['Adj Close'].strip()
            if value.lower() in {'', 'null', 'nan', 'n/a'}:
                continue  # intersect dates later; never backfill from future rows
            price = float(value)
            if not math.isfinite(price) or price <= 0:
                raise ValueError(f'{path}: invalid adjusted close on {stamp}.')
            if stamp in prices:
                raise ValueError(f'{path}: duplicate date {stamp}.')
            prices[stamp] = price
    if not prices:
        raise ValueError(f'{path}: no valid prices.')
    return prices


def next_year(stamp):
    day = date.fromisoformat(stamp)
    year = day.year + 1
    return date(year, day.month, min(day.day, calendar.monthrange(year, day.month)[1])).isoformat()


def build_dataset(assets, series):
    if len(assets) != 30 or len(series) != 30 or len({a['symbol'] for a in assets}) != 30:
        raise ValueError('Provide exactly 30 unique USD assets and their CSVs.')
    if any(a.get('currency') != 'USD' for a in assets):
        raise ValueError('Every asset must declare currency USD. Convert other currencies before import.')
    dates = sorted(set.intersection(*(set(prices) for prices in series)))
    if len(dates) < 201:
        raise ValueError('Fewer than 201 common trading dates. Download a longer overlapping history.')
    for previous, current in zip(dates, dates[1:]):
        if (date.fromisoformat(current) - date.fromisoformat(previous)).days > 7:
            raise ValueError(f'Missing-price gap between {previous} and {current}. Supply complete daily CSVs.')
    positions = {stamp: i for i, stamp in enumerate(dates)}
    windows = sum(200 <= positions.get(next_year(stamp), -10000) - i <= 270 for i, stamp in enumerate(dates))
    if not windows:
        raise ValueError('No full one-calendar-year window. Supply at least two years of daily data for all 30 assets.')
    return {
        'version': 1, 'kind': 'portfolio', 'source': 'Yahoo Finance',
        'currency': 'USD', 'adjusted': True, 'demo': False,
        'assets': [{'symbol': a['symbol'], 'name': a.get('name', a['symbol'])} for a in assets],
        'dates': dates, 'prices': [[prices[stamp] for prices in series] for stamp in dates],
    }, windows


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as handle:
            tmp = handle.name
            json.dump(value, handle, separators=(',', ':'), allow_nan=False)
            handle.write('\n')
        os.replace(tmp, path)
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)


def download(assets, directory, start, end):
    try:
        import yfinance as yf
    except ImportError as exc:
        raise ValueError('Optional download requires yfinance. Run: python3 -m pip install yfinance') from exc
    directory.mkdir(parents=True, exist_ok=True)
    for i, asset in enumerate(assets, 1):
        symbol = asset['symbol']
        print(f'[{i}/30] Downloading {symbol}', flush=True)
        try:
            frame = yf.Ticker(symbol).history(start=start, end=end, interval='1d',
                auto_adjust=False, actions=False, raise_errors=True)
        except Exception as exc:
            raise ValueError(f'Yahoo download failed for {symbol}: {exc}. Use CSV import if access is restricted.') from exc
        if frame.empty or 'Adj Close' not in frame.columns:
            raise ValueError(f'Yahoo returned no adjusted closes for {symbol}. Import an authorised CSV instead.')
        # Keep dates in the exchange's own timezone; converting to UTC can move
        # midnight quotes into the preceding day in some markets.
        with (directory / f'{symbol}.csv').open('w', newline='', encoding='utf-8') as handle:
            writer = csv.writer(handle)
            writer.writerow(['Date', 'Adj Close'])
            for stamp, value in frame['Adj Close'].items():
                writer.writerow([stamp.date().isoformat(), value])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv-dir', type=Path, default=Path('data/yahoo-raw'))
    parser.add_argument('--universe', type=Path, default=Path('data/portfolio/universe.json'))
    parser.add_argument('--output', type=Path, default=Path('data/portfolio/yahoo-30.json'))
    parser.add_argument('--manifest', type=Path, default=Path('data/manifest.json'))
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--start', default='2015-01-01')
    parser.add_argument('--end', default=date.today().isoformat(), help='Exclusive end date for Yahoo downloads')
    args = parser.parse_args()
    try:
        assets = json.loads(args.universe.read_text(encoding='utf-8'))
        if not isinstance(assets, list) or len(assets) != 30:
            raise ValueError('universe.json must list exactly 30 assets.')
        import re
        if any(not isinstance(a, dict) or not re.fullmatch(r'[A-Z0-9.^=_-]{1,20}', a.get('symbol', '')) for a in assets):
            raise ValueError('Each universe asset needs a valid symbol.')
        if len({a['symbol'] for a in assets}) != 30 or any(a.get('currency') != 'USD' for a in assets):
            raise ValueError('The universe must contain 30 unique assets, each declaring currency USD.')
        manifest = json.loads(args.manifest.read_text(encoding='utf-8')) if args.manifest.exists() else {'version': 1, 'orderbooks': [], 'portfolios': []}
        if manifest.get('version') != 1 or not isinstance(manifest.get('portfolios', []), list):
            raise ValueError('Existing manifest must use version 1 and a portfolios array.')
        if args.download:
            if date.fromisoformat(args.start) >= date.fromisoformat(args.end):
                raise ValueError('The download start date must precede its exclusive end date.')
            download(assets, args.csv_dir, args.start, args.end)
        series = [read_prices(args.csv_dir / f"{asset['symbol']}.csv") for asset in assets]
        data, windows = build_dataset(assets, series)
        entry = {'id': 'yahoo-30', 'label': 'Yahoo Finance · 30 assets · adjusted daily prices',
            'path': Path(os.path.relpath(args.output, args.manifest.parent)).as_posix(), 'demo': False}
        entries = manifest.setdefault('portfolios', [])
        entries[:] = [existing for existing in entries if existing.get('id') != entry['id']]
        entries.insert(0, entry)
        atomic_json(args.output, data)
        atomic_json(args.manifest, manifest)
        print(f'Saved {args.output}: {len(data["dates"])} aligned dates, 30 assets, {windows} eligible one-year windows.')
        print('Updated the manifest. Commit the generated JSON and manifest to your repository.')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f'Cannot prepare Yahoo data: {exc}\n')


if __name__ == '__main__':
    main()
