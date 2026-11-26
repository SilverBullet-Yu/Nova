#!/usr/bin/env python3
"""Verify the IndexedDB overlay CAS prototype in isolated Chromium contexts."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

if not __debug__:
    raise SystemExit('indexeddb-overlay-check.py 不允许在 python -O / PYTHONOPTIMIZE 下运行')

from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parents[1]
MODULE = PROJECT / 'shared' / 'local-overlay-store.js'
TIMESTAMP = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
OUT_DIR = (PROJECT / '.tmp' / f'indexeddb-overlay-{TIMESTAMP}').resolve()
OUT_DIR.mkdir(parents=True, exist_ok=True)
REPORT_FILE = OUT_DIR / 'report.json'
ORIGIN = 'http://nova-overlay.invalid'


def write_report(report: dict) -> None:
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def start_commit(page, slot: str, expected, overlay: str, trash: str | None) -> None:
    page.evaluate(
        """({slot, expected, overlay, trash}) => {
          window[slot] = window.ZX.localOverlayStore.commit(window, expected, {overlay, trash});
        }""",
        {'slot': slot, 'expected': expected, 'overlay': overlay, 'trash': trash},
    )


def await_commit(page, slot: str) -> dict:
    return page.evaluate('(slot) => window[slot]', slot)


def exercise_http(context) -> dict:
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(ORIGIN, wait_until='domcontentloaded', timeout=30000)
    page.wait_for_function('!!window.ZX && !!window.ZX.localOverlayStore')
    assert page.evaluate('window.ZX.localOverlayStore.available(window)')

    other = context.new_page()
    other.goto(ORIGIN, wait_until='domcontentloaded', timeout=30000)
    other.wait_for_function('!!window.ZX && !!window.ZX.localOverlayStore')

    rounds = []
    for index in range(25):
        expected = page.evaluate('window.ZX.localOverlayStore.read(window)')
        start_commit(page, 'commitA', expected, f'page-a-{index}', f'trash-a-{index}')
        start_commit(other, 'commitB', expected, f'page-b-{index}', f'trash-b-{index}')
        result_a = await_commit(page, 'commitA')
        result_b = await_commit(other, 'commitB')
        statuses = sorted([result_a['status'], result_b['status']])
        assert statuses == ['committed', 'conflict'], (index, statuses)
        winner = result_a if result_a['status'] == 'committed' else result_b
        stored = page.evaluate('window.ZX.localOverlayStore.read(window)')
        assert stored == winner['current']
        assert stored['overlay'] in (f'page-a-{index}', f'page-b-{index}')
        assert stored['trash'] in (f'trash-a-{index}', f'trash-b-{index}')
        rounds.append({'round': index, 'statuses': statuses, 'revision': stored['revision']})

    before = page.evaluate('window.ZX.localOverlayStore.read(window)')
    removed = page.evaluate(
        '(expected) => window.ZX.localOverlayStore.commit(window, expected, {overlay: null, trash: null})',
        before,
    )
    assert removed['status'] == 'committed'
    assert removed['current']['overlay'] is None and removed['current']['trash'] is None
    assert other.evaluate('window.ZX.localOverlayStore.read(window)') == removed['current']
    assert not errors, errors
    result = {
        'origin': ORIGIN,
        'indexedDBAvailable': True,
        'simultaneousCommitRounds': len(rounds),
        'exactlyOneWinnerEachRound': True,
        'finalRevision': removed['current']['revision'],
        'atomicOverlayAndTrashClear': True,
        'pageErrors': errors,
    }
    other.close()
    page.close()
    return result


def exercise_file(context) -> dict:
    local_module = OUT_DIR / 'local-overlay-store.js'
    local_module.write_bytes(MODULE.read_bytes())
    fixture = OUT_DIR / 'fixture.html'
    fixture.write_text(
        '<!doctype html><meta charset="utf-8"><script src="local-overlay-store.js"></script>',
        encoding='utf-8',
    )
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('http://**/*', lambda route: route.abort())
    page.route('https://**/*', lambda route: route.abort())
    page.goto(fixture.as_uri(), wait_until='domcontentloaded', timeout=30000)
    page.wait_for_function('!!window.ZX && !!window.ZX.localOverlayStore')
    available = page.evaluate('window.ZX.localOverlayStore.available(window)')
    result = {'url': fixture.as_uri(), 'indexedDBAvailable': available, 'pageErrors': errors}
    if available:
        expected = page.evaluate('window.ZX.localOverlayStore.read(window)')
        committed = page.evaluate(
            '(expected) => window.ZX.localOverlayStore.commit(window, expected, {overlay: "file-synthetic", trash: null})',
            expected,
        )
        assert committed['status'] == 'committed'
        assert page.evaluate('window.ZX.localOverlayStore.read(window)') == committed['current']
        result['fileCommitPass'] = True
    else:
        result['fileCommitPass'] = None
        result['boundary'] = 'IndexedDB unavailable for file://; production must retain localStorage fallback'
    assert not errors, errors
    page.close()
    return result


report = {
    'schema': 'nova-indexeddb-overlay-prototype-v1',
    'startedAt': datetime.now().astimezone().isoformat(),
    'module': str(MODULE),
    'outputDir': str(OUT_DIR),
    'isolation': {
        'browser': 'ephemeral Chromium; synthetic origin and synthetic data only',
        'network': 'synthetic HTTP route only; file scenario blocks every HTTP(S) request',
        'existing8787Used': False,
        'realBrowserStorageRead': False,
        'productionOverlayWired': False,
    },
    'checks': {},
    'fatalError': None,
}

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        context.route(f'{ORIGIN}/**', lambda route: route.fulfill(
            status=200,
            content_type='text/html; charset=utf-8',
            body='<!doctype html><meta charset="utf-8"><script src="/local-overlay-store.js"></script>',
        ))
        context.route(f'{ORIGIN}/local-overlay-store.js', lambda route: route.fulfill(
            status=200,
            content_type='application/javascript; charset=utf-8',
            body=MODULE.read_text(encoding='utf-8'),
        ))
        report['checks']['httpConcurrentCas'] = exercise_http(context)
        context.close()

        file_context = browser.new_context()
        report['checks']['fileProtocol'] = exercise_file(file_context)
        file_context.close()
        browser.close()
except Exception as error:
    report['fatalError'] = str(error)

report['finishedAt'] = datetime.now().astimezone().isoformat()
report['pass'] = report['fatalError'] is None and all(
    check.get('pageErrors') == [] and check.get('exactlyOneWinnerEachRound', check.get('fileCommitPass', True))
    for check in report['checks'].values()
)
write_report(report)
print(json.dumps(report, ensure_ascii=False, indent=2))
if not report['pass']:
    raise SystemExit(1)
