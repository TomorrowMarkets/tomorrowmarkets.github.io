"""Refresh the isolated integration test's HTML fixture after editing index.html."""
from html.parser import HTMLParser
import json
from pathlib import Path


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': 'document', 'attrs': {}, 'text': '', 'children': []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {'tag': tag, 'attrs': {key: value or '' for key, value in attrs}, 'text': '', 'children': []}
        self.stack[-1]['children'].append(node)
        if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]['tag'] == tag:
                self.stack = self.stack[:i]
                break

    def handle_data(self, data):
        self.stack[-1]['text'] += data


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    parser = Tree()
    parser.feed((root / 'index.html').read_text(encoding='utf-8'))
    target = root / 'tests/fixtures/dom.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(parser.root), encoding='utf-8')
