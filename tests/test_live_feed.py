import importlib.util
from datetime import datetime,timezone
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('live_feed',ROOT/'tools/update-live-data.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Stamp:
    def __init__(self,value):self.value=value
    def date(self):return self.value.date()
class Close:
    def __init__(self,value):self.value=value
    def to_pydatetime(self):return self.value
    def isoformat(self):return self.value.isoformat()
class Calendar:
    def sessions_in_range(self,start,end):
        return [Stamp(datetime(2026,10,day,tzinfo=timezone.utc)) for day in [26,27,28,29]]
    def session_close(self,session):return Close(session.value.replace(hour=20))
class LiveFeedTests(unittest.TestCase):
    def data(self):return {'source':'Yahoo Finance','adjusted':True,'currency':'USD','demo':False,
        'assets':[{'symbol':f'T{i}'} for i in range(30)],'dates':['2026-10-26','2026-10-27','2026-10-28','2026-10-29'],
        'prices':[[100+i for i in range(30)] for _ in range(4)]}
    def test_unfinished_session_prices_are_not_published(self):
        payload=module.build_payload(self.data(),Calendar(),datetime(2026,10,28,19,tzinfo=timezone.utc))
        self.assertEqual([row['date'] for row in payload['prices']],['2026-10-26','2026-10-27'])
    def test_deadline_is_previous_exchange_close_not_after_return_is_known(self):
        payload=module.build_payload(self.data(),Calendar(),datetime(2026,10,28,21,tzinfo=timezone.utc))
        period=payload['periods'][1]
        self.assertEqual(period['previousDate'],'2026-10-27');self.assertTrue(period['cutoff'].startswith('2026-10-27T20:00'))
        self.assertTrue(period['valuation'].startswith('2026-10-28T20:00'))
    def test_synthetic_data_cannot_enter_live_scoring(self):
        data=self.data();data['demo']=True
        with self.assertRaises(ValueError):module.build_payload(data,Calendar(),datetime(2026,10,28,21,tzinfo=timezone.utc))
if __name__=='__main__':unittest.main()
