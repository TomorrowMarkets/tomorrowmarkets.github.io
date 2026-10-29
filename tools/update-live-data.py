#!/usr/bin/env python3
"""Publish completed-session prices/returns and optional historical market JSON.

Run on the trusted GitHub Actions runner. Private keys never enter browser code.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlparse

HISTORY_OBJECT = 'tm-market-data/portfolio/yahoo-30.json'
MAX_HISTORY_BYTES = 6 * 1024 * 1024


class DataError(ValueError):
    """A safe, deliberately constructed validation message for job logs."""


def validate_data(data):
    if data.get('source') != 'Yahoo Finance' or data.get('demo') or data.get('adjusted') is not True or data.get('currency') != 'USD':
        raise DataError('Daily portfolios require real adjusted USD Yahoo data, not demo data.')
    assets = data.get('assets', [])
    if len(assets) != 30 or any(not isinstance(a, dict) or not re.fullmatch(r'[A-Z0-9.^=_-]{1,20}', a.get('symbol', '')) for a in assets) or len({a['symbol'] for a in assets}) != 30:
        raise DataError('Exactly 30 unique valid asset symbols are required.')
    dates, prices = data.get('dates', []), data.get('prices', [])
    if not dates or len(dates) != len(prices):
        raise DataError('Daily dates and price rows must have equal, nonzero lengths.')
    previous = ''
    for stamp, row in zip(dates, prices):
        try:
            valid_date = isinstance(stamp, str) and date.fromisoformat(stamp).isoformat() == stamp
        except ValueError:
            valid_date = False
        if not valid_date or stamp <= previous:
            raise DataError('Price dates must be valid, sorted, unique ISO dates.')
        previous = stamp
        if not isinstance(row, list) or len(row) != 30 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not 0 < x <= 1e12 for x in row):
            raise DataError('Every price date must have 30 finite, positive adjusted closes.')


def closed_observations(data, calendar, now):
    validate_data(data)
    sessions = calendar.sessions_in_range(data['dates'][0], (now.date() + timedelta(days=60)).isoformat())
    completed = {s.date().isoformat() for s in sessions if calendar.session_close(s).to_pydatetime() <= now}
    latest = max(completed, default=None)
    rows = [(stamp, row) for stamp, row in zip(data['dates'], data['prices']) if stamp in completed]
    if not rows:
        raise DataError('No completed exchange session is present in the price file.')
    if rows[-1][0] != latest:
        raise DataError(f'Latest completed session {latest} is missing for one or more assets. No publication was attempted.')
    available = {stamp for stamp, _ in rows}
    missing = completed - available
    if missing:
        raise DataError(f'Completed exchange session {min(missing)} is missing from the aligned data. No publication was attempted.')
    return sessions, rows


def build_payload(data, calendar, now):
    sessions, rows = closed_observations(data, calendar, now)
    start = (now.date() - timedelta(days=500)).isoformat()
    periods = []
    for index, session in enumerate(sessions):
        if not index or session.date().isoformat() < start:
            continue
        previous = sessions[index - 1]
        periods.append({'sessionDate': session.date().isoformat(), 'previousDate': previous.date().isoformat(),
            'cutoff': calendar.session_close(previous).isoformat(), 'valuation': calendar.session_close(session).isoformat()})
    # Include the immediately preceding observation to form the oldest ratio.
    first = next((i for i, row in enumerate(rows) if row[0] >= start), len(rows))
    recent = rows[max(0, first - 1):]
    prices = [{'date': stamp, 'values': row} for stamp, row in recent]
    return {'version': 1, 'assets': [a['symbol'] for a in data['assets']], 'prices': prices, 'periods': periods}


def build_history(data, calendar, now):
    _, rows = closed_observations(data, calendar, now)
    return {'version': 1, 'kind': 'portfolio', 'source': 'Yahoo Finance', 'currency': 'USD',
        'adjusted': True, 'demo': False, 'generatedAt': now.isoformat(),
        'assets': [{'symbol': a['symbol'], 'name': a.get('name', a['symbol'])} for a in data['assets']],
        'dates': [row[0] for row in rows], 'prices': [row[1] for row in rows]}


def server_settings():
    url = os.environ.get('TM_SUPABASE_URL', '')
    key = os.environ.get('TM_SUPABASE_SERVICE_ROLE_KEY', '')
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.supabase.co') or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.query or parsed.fragment or parsed.path not in ('', '/') or not key:
        raise DataError('Configure TM_SUPABASE_URL and the server-only TM_SUPABASE_SERVICE_ROLE_KEY in GitHub Actions.')
    if key.startswith('sb_publishable_'):
        raise DataError('The publisher needs a Supabase secret/server key, not the public browser key.')
    return url.rstrip('/'), key


def headers(key):
    result = {'apikey': key, 'Content-Type': 'application/json'}
    if not key.startswith('sb_secret_'):
        result['Authorization'] = 'Bearer ' + key
    return result


def send(request, attempts=3):
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=90) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt + 1 == attempts:
                raise
        except (URLError, TimeoutError):
            if attempt + 1 == attempts:
                raise
        time.sleep(2 ** attempt)


def rpc(url, key, name, parameters):
    request = Request(url + '/rest/v1/rpc/' + name,
        data=json.dumps(parameters, allow_nan=False, separators=(',', ':')).encode(), headers=headers(key), method='POST')
    return send(request)


def publish_history(url, key, data):
    body = json.dumps(data, allow_nan=False, separators=(',', ':')).encode()
    if len(body) > MAX_HISTORY_BYTES:
        raise DataError('Historical JSON exceeds the configured 6 MiB storage limit; use a shorter history or split the dataset.')
    request_headers = {**headers(key), 'x-upsert': 'true', 'Cache-Control': 'max-age=60'}
    request = Request(url + '/storage/v1/object/' + HISTORY_OBJECT, data=body, headers=request_headers, method='POST')
    send(request)
    return hashlib.sha256(body).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--download-start', help='Optional full-history start date, e.g. 2015-01-01')
    parser.add_argument('--portfolio-data', type=Path, default=Path('data/portfolio/yahoo-30.json'))
    parser.add_argument('--output', type=Path, help='Write the non-secret live feed without publication')
    parser.add_argument('--history-output', type=Path, help='Write completed-session historical JSON locally')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--publish-history', action='store_true', help='Upload market JSON to the configured public storage bucket')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    try:
        # Fail before expensive downloads if publisher configuration is absent.
        server = server_settings() if args.publish or args.publish_history else None
        if args.download_start:
            date.fromisoformat(args.download_start)
        import exchange_calendars as xcals
        with tempfile.TemporaryDirectory(prefix='tm-live-data-') as directory:
            price_file = args.portfolio_data
            if args.download:
                price_file = Path(directory) / 'portfolio.json'
                start = args.download_start or (now.date() - timedelta(days=500)).isoformat()
                command = [sys.executable, str(Path(__file__).with_name('prepare-yahoo.py')), '--download',
                    '--start', start, '--end', (now.date() + timedelta(days=1)).isoformat(), '--csv-dir', str(Path(directory) / 'raw'),
                    '--output', str(price_file), '--manifest', str(Path(directory) / 'manifest.json')]
                # The downloader has no need for the database's elevated key.
                environment = {k: v for k, v in os.environ.items() if k != 'TM_SUPABASE_SERVICE_ROLE_KEY'}
                subprocess.run(command, check=True, env=environment)
            data = json.loads(price_file.read_text())
            calendar = xcals.get_calendar('XNYS')
            payload = build_payload(data, calendar, now)
            history = build_history(data, calendar, now) if args.publish_history or args.history_output else None
            # Validate historical serialization/size before any live publication.
            if history is not None and len(json.dumps(history, allow_nan=False, separators=(',', ':')).encode()) > MAX_HISTORY_BYTES:
                raise DataError('Historical JSON exceeds the configured 6 MiB storage limit.')
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(payload, allow_nan=False))
            if args.history_output:
                args.history_output.parent.mkdir(parents=True, exist_ok=True)
                args.history_output.write_text(json.dumps(history, allow_nan=False, separators=(',', ':')))
            print(f'Validated complete prices through {payload["prices"][-1]["date"]} for all 30 assets.')
            if args.publish:
                created = rpc(*server, 'tm_ingest_live_feed', {'p_payload': payload})
                settled = rpc(*server, 'tm_settle_all_live', {})
                print(f'Published {created} new return vectors; settled {settled} portfolio periods.')
            if args.publish_history:
                checksum = publish_history(*server, history)
                print(f'Published historical market JSON: {len(history["dates"])} dates; SHA-256 {checksum}.')
            if not args.publish and not args.publish_history:
                print('Validation complete. No production data was published.')
    except ImportError:
        parser.exit(1, 'Install dependencies: python3 -m pip install -r tools/live-data-requirements.txt\n')
    except DataError as error:
        parser.exit(1, str(error) + '\n')
    except Exception:
        parser.exit(1, 'Market update failed. Check source availability, server secrets, migrations and optional storage. No credentials were logged.\n')


if __name__ == '__main__':
    main()
