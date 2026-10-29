import importlib.util
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('publisher', ROOT / 'tools/update-live-data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Stamp:
    def __init__(self, day): self.value = datetime(2026, 10, day, tzinfo=timezone.utc)
    def date(self): return self.value.date()


class Close:
    def __init__(self, stamp): self.value = stamp.value.replace(hour=20)
    def to_pydatetime(self): return self.value
    def isoformat(self): return self.value.isoformat()


class Calendar:
    def sessions_in_range(self, start, end): return [Stamp(day) for day in [26, 27, 28, 29]]
    def session_close(self, session): return Close(session)


class PublisherTests(unittest.TestCase):
    def data(self):
        return {'source': 'Yahoo Finance', 'adjusted': True, 'demo': False, 'currency': 'USD',
            'assets': [{'symbol': f'T{i}'} for i in range(30)],
            'dates': [f'2026-10-{day}' for day in [26, 27, 28, 29]],
            'prices': [[100 + i for i in range(30)] for _ in range(4)]}

    def test_future_prices_are_removed_from_both_outputs(self):
        now = datetime(2026, 10, 28, 19, tzinfo=timezone.utc)
        payload = module.build_payload(self.data(), Calendar(), now)
        history = module.build_history(self.data(), Calendar(), now)
        self.assertEqual([p['date'] for p in payload['prices']], ['2026-10-26', '2026-10-27'])
        self.assertEqual(history['dates'], ['2026-10-26', '2026-10-27'])
        self.assertEqual(len(history['prices']), 2)

    def test_missing_latest_close_fails_before_publication(self):
        data = self.data(); data['dates'].pop(); data['prices'].pop()
        with self.assertRaisesRegex(module.DataError, '2026-10-29'):
            module.build_payload(data, Calendar(), datetime(2026, 10, 29, 22, tzinfo=timezone.utc))

    def test_missing_earlier_exchange_session_is_not_silently_skipped(self):
        data = self.data(); data['dates'].pop(1); data['prices'].pop(1)
        with self.assertRaisesRegex(module.DataError, '2026-10-27'):
            module.build_payload(data, Calendar(), datetime(2026, 10, 29, 22, tzinfo=timezone.utc))

    def test_invalid_vectors_duplicates_and_demo_are_rejected(self):
        for kind in ['nan', 'short', 'duplicate', 'demo', 'symbol']:
            data = self.data()
            if kind == 'nan': data['prices'][0][0] = float('nan')
            if kind == 'short': data['prices'].pop()
            if kind == 'duplicate': data['dates'][1] = data['dates'][0]
            if kind == 'demo': data['demo'] = True
            if kind == 'symbol': data['assets'][0]['symbol'] = '../bad'
            with self.assertRaises(module.DataError): module.validate_data(data)

    def test_previous_close_cutoff_is_unchanged(self):
        payload = module.build_payload(self.data(), Calendar(), datetime(2026, 10, 29, 22, tzinfo=timezone.utc))
        self.assertEqual(payload['periods'][1]['previousDate'], '2026-10-27')
        self.assertTrue(payload['periods'][1]['cutoff'].startswith('2026-10-27T20:00'))

    def test_storage_upload_contains_only_market_json_and_expected_headers(self):
        data = module.build_history(self.data(), Calendar(), datetime(2026, 10, 29, 22, tzinfo=timezone.utc))
        with patch.object(module, 'send', return_value={}) as send:
            checksum = module.publish_history('https://example.supabase.co', 'sb_secret_test', data)
        request = send.call_args.args[0]
        self.assertTrue(request.full_url.endswith('/storage/v1/object/tm-market-data/portfolio/yahoo-30.json'))
        self.assertEqual(request.get_header('X-upsert'), 'true')
        self.assertIsNone(request.get_header('Authorization'))
        body = json.loads(request.data)
        self.assertEqual(body['kind'], 'portfolio'); self.assertNotIn('accounts', body)
        self.assertEqual(len(checksum), 64)

    def test_legacy_server_key_uses_bearer_header(self):
        self.assertEqual(module.headers('legacy-test')['Authorization'], 'Bearer legacy-test')

    def test_publishable_key_is_rejected_for_the_publisher(self):
        with patch.dict('os.environ', {'TM_SUPABASE_URL': 'https://example.supabase.co', 'TM_SUPABASE_SERVICE_ROLE_KEY': 'sb_publishable_test'}):
            with self.assertRaisesRegex(module.DataError, 'browser key'): module.server_settings()

    def test_transient_requests_retry_but_permission_errors_do_not(self):
        request = module.Request('https://example.supabase.co', data=b'{}')
        response = BytesIO(b'{"ok":true}')
        with patch.object(module, 'urlopen', side_effect=[HTTPError(request.full_url, 503, 'busy', {}, None), response]) as call, patch.object(module.time, 'sleep'):
            self.assertTrue(module.send(request)['ok']); self.assertEqual(call.call_count, 2)
        with patch.object(module, 'urlopen', side_effect=HTTPError(request.full_url, 403, 'denied', {}, None)) as call:
            with self.assertRaises(HTTPError): module.send(request)
            self.assertEqual(call.call_count, 1)


if __name__ == '__main__': unittest.main()
