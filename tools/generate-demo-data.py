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
    def book_data(days, interval_seconds, seed):
        book_rng = random.Random(seed)
        session_date = date(2024, 1, 3)
        frames = []
        mid, volatility = 100.0, 1.0
        for day in range(days):
            while session_date.weekday() >= 5:
                session_date += timedelta(days=1)
            current = datetime.combine(session_date, datetime.min.time(), timezone.utc) + timedelta(hours=9, minutes=30)
            mid *= math.exp(book_rng.gauss(0, 0.003))
            drift = book_rng.choice([-1, 1]) * book_rng.uniform(0, 0.000003)
            for i in range(30600 // interval_seconds + 1):
                progress = i * interval_seconds / 30600
                activity = 0.65 + 1.15 * (2 * progress - 1) ** 2 + 0.3 * math.exp(-((progress - 0.6) / 0.07) ** 2)
                volatility = 0.97 * volatility + 0.03 * math.exp(book_rng.gauss(0, 0.7))
                shock = book_rng.gauss(0, 0.002) if i and book_rng.random() < 0.001 else 0
                mid = max(5, mid * math.exp(drift + shock + book_rng.gauss(0, 0.00016 * math.sqrt(interval_seconds / 15) * activity * volatility)))
                centre = round(mid, 2)
                half = book_rng.choice([1, 2, 2, 3, 4]) * 0.01
                imbalance = book_rng.uniform(-0.4, 0.4)
                levels = {}
                for side, sign in [('bids', -1), ('asks', 1)]:
                    scale = (1 + imbalance if side == 'bids' else 1 - imbalance) / math.sqrt(volatility)
                    levels[side] = [{'price': round(centre + sign * (half + j * 0.02), 2),
                        'qty': max(1, round(book_rng.lognormvariate(math.log(70 + j * 30), 0.5) * scale))} for j in range(10)]
                prints = []
                if i:
                    for _ in range(book_rng.randint(1, max(2, round(3 * activity)))):
                        side = book_rng.choice(['BUY', 'SELL'])
                        prints.append({'price': levels['asks' if side == 'BUY' else 'bids'][0]['price'],
                            'qty': max(1, round(book_rng.lognormvariate(math.log(35 * activity * interval_seconds / 15), 0.85))), 'side': side})
                frames.append({'timestamp': (current + timedelta(seconds=i * interval_seconds)).isoformat().replace('+00:00', 'Z'),
                    'sessionDate': session_date.isoformat(), **levels, 'trades': prints, 'volume': sum(t['qty'] for t in prints)})
            session_date += timedelta(days=1)
        return {'version': 1, 'kind': 'orderbook', 'symbol': 'DEMO / USD', 'currency': 'USD', 'demo': True, 'frames': frames}

    orderbook = book_data(5, 15, 17483)
    long_book = book_data(20, 60, 18532)
    for name, data in [('data/portfolio/demo-30.json', portfolio), ('data/orderbooks/demo-book.json', orderbook), ('data/orderbooks/demo-book-20.json', long_book)]:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, separators=(',', ':')) + '\n', encoding='utf-8')


if __name__ == '__main__':
    generate()
