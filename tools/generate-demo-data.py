#!/usr/bin/env python3
"""Reproduce explicitly synthetic test/demo datasets. No real market data."""
from datetime import datetime, date, timedelta, timezone
import json
import math
from pathlib import Path
import random


def generate(root=Path('.')):
    rng = random.Random(48276)
    assets = [{'symbol': f'DEMO{i + 1:02}', 'name': f'Synthetic asset {i + 1:02}'} for i in range(30)]
    dates, rows = [], []
    prices = [50 + 4 * i for i in range(30)]
    current = date(2017, 1, 2)
    while current <= date(2025, 12, 31):
        if current.weekday() < 5:
            common = rng.gauss(0.0001, 0.007)
            prices = [p * math.exp(common * (0.5 + i / 40) + rng.gauss(0.00005, 0.006 + i / 10000)) for i, p in enumerate(prices)]
            dates.append(current.isoformat())
            rows.append([round(p, 6) for p in prices])
        current += timedelta(days=1)
    portfolio = {'version': 1, 'kind': 'portfolio', 'source': 'Synthetic demo', 'currency': 'USD',
        'adjusted': True, 'demo': True, 'assets': assets, 'dates': dates, 'prices': rows}
    current = datetime(2024, 1, 3, 9, 30, tzinfo=timezone.utc)
    frames = []
    mid = 100
    for i in range(241):
        mid = round(max(5, mid + rng.gauss(0.003, 0.12)), 2)
        frames.append({'timestamp': (current + timedelta(seconds=i * 127.5)).isoformat().replace('+00:00', 'Z'),
            'bids': [{'price': round(mid - 0.02 - j * 0.02, 2), 'qty': rng.randint(80, 350)} for j in range(5)],
            'asks': [{'price': round(mid + 0.02 + j * 0.02, 2), 'qty': rng.randint(80, 350)} for j in range(5)]})
    original = frames
    frames = []
    session_date = current.date()
    for day in range(5):
        while session_date.weekday() >= 5:
            session_date += timedelta(days=1)
        factor = math.exp(rng.gauss(0, 0.008))
        for frame in original:
            timestamp = datetime.fromisoformat(frame['timestamp'].replace('Z', '+00:00'))
            shifted = timestamp.replace(year=session_date.year, month=session_date.month, day=session_date.day)
            frames.append({'timestamp': shifted.isoformat().replace('+00:00', 'Z'),
                'volume': rng.randint(400, 15000),
                **{side: [{'price': round(level['price'] * factor, 2), 'qty': level['qty']} for level in frame[side]] for side in ['bids', 'asks']}})
        session_date += timedelta(days=1)
    orderbook = {'version': 1, 'kind': 'orderbook', 'symbol': 'DEMO / USD', 'currency': 'USD', 'demo': True, 'frames': frames}
    for name, data in [('data/portfolio/demo-30.json', portfolio), ('data/orderbooks/demo-book.json', orderbook)]:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, separators=(',', ':')) + '\n', encoding='utf-8')


if __name__ == '__main__':
    generate()
