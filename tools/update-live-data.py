#!/usr/bin/env python3
"""Prepare and publish daily close-to-close returns. Run only on a trusted host.

The public browser never receives a service-role/secret API key. Input can be
an already prepared Yahoo portfolio file, or --download can fetch one freshly.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen
from urllib.parse import urlparse


def build_payload(data, calendar, now):
    if data.get('source') != 'Yahoo Finance' or data.get('demo') or data.get('adjusted') is not True or data.get('currency') != 'USD':
        raise ValueError('Daily portfolios require real, adjusted USD Yahoo data, not a demo dataset.')
    if len(data.get('assets', [])) != 30:
        raise ValueError('Exactly 30 assets are required.')
    sessions = calendar.sessions_in_range(data['dates'][0], (now.date()+timedelta(days=60)).isoformat())
    periods = []
    completed_dates = set()
    for index, session in enumerate(sessions):
        close = calendar.session_close(session).to_pydatetime()
        if close <= now:
            completed_dates.add(session.date().isoformat())
        if not index:
            continue
        previous = sessions[index-1]
        periods.append({'sessionDate':session.date().isoformat(), 'previousDate':previous.date().isoformat(),
            'cutoff':calendar.session_close(previous).isoformat(), 'valuation':close.isoformat()})
    prices = [{'date':stamp,'values':row} for stamp,row in zip(data['dates'],data['prices']) if stamp in completed_dates]
    if not prices:
        raise ValueError('No completed exchange session is present in the price file.')
    return {'version':1,'assets':[a['symbol'] for a in data['assets']],'prices':prices,'periods':periods}


def rpc(url, key, name, parameters):
    headers = {'apikey':key,'Content-Type':'application/json'}
    # Legacy service_role keys are JWTs. New sb_secret keys use only apikey.
    if not key.startswith('sb_secret_'):
        headers['Authorization'] = 'Bearer '+key
    request = Request(url.rstrip('/')+'/rest/v1/rpc/'+name, data=json.dumps(parameters,allow_nan=False).encode(), headers=headers, method='POST')
    with urlopen(request, timeout=90) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--portfolio-data', type=Path, default=Path('data/portfolio/yahoo-30.json'))
    parser.add_argument('--output', type=Path, help='Write the non-secret feed payload without publishing it')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    try:
        import exchange_calendars as xcals
        with tempfile.TemporaryDirectory(prefix='tm-live-data-') as directory:
            price_file = args.portfolio_data
            if args.download:
                price_file = Path(directory)/'portfolio.json'
                subprocess.run([sys.executable,str(Path(__file__).with_name('prepare-yahoo.py')),'--download',
                    '--start',(now.date()-timedelta(days=500)).isoformat(),'--end',(now.date()+timedelta(days=1)).isoformat(),
                    '--output',str(price_file),'--manifest',str(Path(directory)/'manifest.json')],check=True)
            data = json.loads(price_file.read_text())
            payload = build_payload(data, xcals.get_calendar('XNYS'), now)
            if args.output:
                args.output.parent.mkdir(parents=True,exist_ok=True)
                args.output.write_text(json.dumps(payload,allow_nan=False))
                print('Saved the daily market feed payload.')
            if args.publish:
                url = os.environ.get('TM_SUPABASE_URL','')
                key = os.environ.get('TM_SUPABASE_SERVICE_ROLE_KEY','')
                parsed = urlparse(url)
                if parsed.scheme!='https' or not parsed.hostname or not parsed.hostname.endswith('.supabase.co') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/') or not key:
                    raise ValueError('Set TM_SUPABASE_URL to an HTTPS Supabase URL and TM_SUPABASE_SERVICE_ROLE_KEY on this trusted host.')
                created = rpc(url,key,'tm_ingest_live_feed',{'p_payload':payload})
                settled = rpc(url,key,'tm_settle_all_live',{})
                print(f'Published {created} new return vectors; settled {settled} portfolio periods.')
            elif not args.output:
                print(f'Feed validated: {len(payload["prices"])} completed price dates and {len(payload["periods"])} calendar periods. Use --publish or --output.')
    except ImportError:
        parser.exit(1,'Install the optional data dependencies: python3 -m pip install -r tools/live-data-requirements.txt\n')
    except Exception:
        # Do not echo request headers, API credentials, or HTTP response bodies.
        parser.exit(1,'The daily data update failed. Check source availability, the dataset, server secrets and the applied migration. No credentials were logged.\n')


if __name__=='__main__':
    main()
