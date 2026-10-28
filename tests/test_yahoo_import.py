import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('yahoo_import', ROOT / 'tools' / 'prepare-yahoo.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class YahooImportTests(unittest.TestCase):
    def test_intersection_keeps_complete_dates_without_backfilling(self):
        demo = json.loads((ROOT / 'data/portfolio/demo-30.json').read_text())
        assets = [dict(asset, currency='USD') for asset in demo['assets']]
        series = [dict(zip(demo['dates'], [row[i] for row in demo['prices']])) for i in range(30)]
        missing = demo['dates'][20]
        del series[4][missing]
        data, windows = module.build_dataset(assets, series)
        self.assertNotIn(missing, data['dates'])
        self.assertGreater(windows, 1)
        self.assertEqual(data['source'], 'Yahoo Finance')
        self.assertEqual(len(data['prices'][0]), 30)

    def test_raw_close_is_not_silently_used_as_adjusted_close(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.csv'
            path.write_text('Date,Close\n2020-01-01,100\n')
            with self.assertRaisesRegex(ValueError, 'Adj Close'):
                module.read_prices(path)

    def test_missing_rows_are_dropped_and_duplicates_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.csv'
            path.write_text('Date,Adj Close\n2020-01-01,100\n2020-01-02,null\n')
            self.assertEqual(module.read_prices(path), {'2020-01-01': 100})
            path.write_text('Date,Adj Close\n2020-01-01,100\n2020-01-01,110\n')
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                module.read_prices(path)


if __name__ == '__main__':
    unittest.main()
