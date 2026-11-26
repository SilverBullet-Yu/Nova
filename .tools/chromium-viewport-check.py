import argparse
import json
import os
from pathlib import Path
from datetime import datetime
from playwright.sync_api import sync_playwright

if not __debug__:
    raise SystemExit('chromium-viewport-check.py 不允许在 python -O / PYTHONOPTIMIZE 下运行')

parser = argparse.ArgumentParser()
parser.add_argument('--url', default=os.environ.get('NOVA_TEST_URL'))
parser.add_argument('--out-dir', type=Path, default=Path(__file__).resolve().parent / ('chromium-check-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f')))
args = parser.parse_args()
if not args.url:
    parser.error('必须显式提供 --url 或 NOVA_TEST_URL；本工具不默认访问既有 8787 服务')
URL = args.url
OUT_DIR = args.out_dir.resolve()
OUT_DIR.mkdir(parents=True, exist_ok=True)
RESULTS = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader'])
    for label, width, height in [('desktop',1440,900),('mobile',390,844)]:
        context = browser.new_context(viewport={'width':width,'height':height}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/api/**', lambda route: route.abort())
        result = {'viewport':label, 'width':width, 'checks':{}, 'errors':errors}
        try:
            page.goto(URL, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_selector('#rail button[data-tab="chat"]', timeout=15000)
            page.wait_for_selector('#homeSummary', state='visible', timeout=15000)
            def layout():
                return page.evaluate('''() => ({tab: document.documentElement.dataset.tab, gl:document.documentElement.className, horizontal:document.documentElement.scrollWidth > innerWidth, chatVisible:!!document.querySelector('#chat').getClientRects().length, summary:document.querySelector('#homeSummary').innerText, image: Array.from(document.querySelectorAll('.msg-mascot')).map(x=>({src:x.currentSrc, complete:x.complete, width:x.naturalWidth}))})''')
            result['initial']=layout()
            page.screenshot(path=str(OUT_DIR / ('chromium-home-' + label + '.png')))
            assert result['initial']['tab']=='chat' and result['initial']['chatVisible']
            assert not result['initial']['horizontal'], '页面横向溢出'
            result['checks']['home_visible']=True
            page.locator('#input').fill('你好')
            page.locator('#form button[type="submit"]').click()
            page.locator('#chat').get_by_text('你好', exact=False).last.wait_for(timeout=10000)
            result['checks']['send_visible']=True
            page.locator('.home-open').click()
            page.wait_for_function("document.documentElement.dataset.tab === 'today'")
            result['checks']['today_navigation']=True
            page.locator('#rail button[data-tab="chat"]').click()
            page.wait_for_function("document.documentElement.dataset.tab === 'chat'")
            result['checks']['return_chat']=page.locator('#chat').is_visible()
            result['checks']['message_retained']='你好' in page.locator('#chat').inner_text()
            result['checks']['focus_return']=page.locator('#input').evaluate('(el) => document.activeElement === el')
            assert all(result['checks'].values()), '一个或多个交互断言失败'
        except Exception as exc:
            result['failure']=str(exc)
        RESULTS.append(result)
        context.close()
    browser.close()
print(json.dumps(RESULTS,ensure_ascii=False,indent=2))
if any('failure' in r or r['errors'] for r in RESULTS):
    raise SystemExit(1)
