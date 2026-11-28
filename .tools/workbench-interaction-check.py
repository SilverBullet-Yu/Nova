import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit
from datetime import datetime

if not __debug__:
    raise SystemExit('workbench-interaction-check.py 不允许在 python -O / PYTHONOPTIMIZE 下运行')

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default=os.environ.get('NOVA_TEST_URL'))
parser.add_argument('--out-dir', type=Path, default=Path(__file__).resolve().parent / 'workbench-check' / datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
args = parser.parse_args()
if not args.url:
    parser.error('必须显式提供 --url 或 NOVA_TEST_URL；本工具不默认访问既有 8787 服务')
URL = args.url
out = args.out_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
fail = []
results = []


def origin_key(parts):
    if parts.scheme.lower() not in ('http', 'https') or not parts.hostname:
        return None
    port = parts.port
    if port is None:
        port = 443 if parts.scheme.lower() == 'https' else 80
    return parts.scheme.lower(), parts.hostname.lower(), port


try:
    target = urlsplit(URL)
    ORIGIN = origin_key(target)
except ValueError as exc:
    parser.error(str(exc))
if ORIGIN is None or target.username or target.password:
    parser.error('--url 必须是不带凭证的 HTTP(S) URL')

# 仅放行同源静态资源；API、外域资源和其他请求一律在浏览器内中断。
STATIC_RESOURCE_TYPES = {'document', 'script', 'stylesheet', 'image', 'font', 'media'}
network = {'allowed_static': 0, 'aborted_api': 0, 'aborted_external_origin': 0,
           'aborted_non_static': 0, 'aborted_total': 0}


def guard_request(route):
    request = route.request
    parts = urlsplit(request.url)
    path = '/' + unquote(parts.path).lstrip('/')
    if path == '/api' or path.startswith('/api/'):
        reason = 'aborted_api'
    elif origin_key(parts) != ORIGIN:
        reason = 'aborted_external_origin'
    elif request.resource_type not in STATIC_RESOURCE_TYPES:
        reason = 'aborted_non_static'
    else:
        network['allowed_static'] += 1
        route.continue_()
        return
    network[reason] += 1
    network['aborted_total'] += 1
    route.abort()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader'])
    for mode in ('dom', 'gl'):
        for width, height in ((1440, 900), (768, 1024), (390, 844), (360, 740)):
            context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
            # 每个视口使用独立本机存储；时段与弹性位操作只走页面本地状态和 UI。
            context.route('**/*', guard_request)
            context.add_init_script("(()=>{const apply=()=>{const r=document.documentElement;if(!r)return false;r.dataset.gl3d='" + ('off' if mode == 'dom' else 'on') + "';return true;};if(!apply()){const o=new MutationObserver(()=>{if(apply())o.disconnect();});o.observe(document,{childList:true,subtree:true});}localStorage.setItem('zx.ui_prefs',JSON.stringify({motion:false,gl3d:" + ('false' if mode == 'dom' else 'true') + "}));})()")
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(URL, wait_until='domcontentloaded')
                page.wait_for_selector('#rail button[data-tab="chat"]')
                page.wait_for_timeout(1000)
                expected_mode = 'off' if mode == 'dom' else 'on'
                if page.evaluate('document.documentElement.dataset.gl3d') != expected_mode:
                    raise AssertionError('GL 模式未生效：' + mode)
                if mode == 'gl':
                    page.evaluate("""() => {
                      document.getElementById('gl').style.display = 'block';
                      document.getElementById('css3d').style.display = 'block';
                      window.dispatchEvent(new Event('resize'));
                    }""")
                    page.wait_for_function("document.documentElement.dataset.gl3d === 'on' && document.documentElement.classList.contains('gl-on') && !!document.querySelector('.gl-stream')", timeout=15000)
                for tab in ['today', 'plan', 'data', 'me']:
                    page.locator('#rail button[data-tab="' + tab + '"]').click()
                    page.wait_for_timeout(150)
                    stat = page.evaluate("""()=>{let v=document.querySelector('#view'),s=document.querySelector('.shell'), b=document.querySelector('.bench-body'),a=document.querySelector('.workbench-aside');let target=s.scrollHeight>s.clientHeight?s:b;let elems=[...v.querySelectorAll('button')].filter(x=>x.getClientRects().length);return {tab:document.documentElement.dataset.tab,visible:!!v.getClientRects().length,overflow:document.documentElement.scrollWidth>innerWidth+1,viewOverflow:v.scrollWidth>v.clientWidth+1,aside:!!a.getClientRects().length,scrollable:target.scrollHeight>target.clientHeight,buttons:elems.length,colors:getComputedStyle(v).color}}""")
                    if not (stat['tab'] == tab and stat['visible'] and stat['aside'] and not stat['overflow']):
                        raise AssertionError(str(stat))
                    if width in (1440, 390) and mode == 'gl':
                        page.screenshot(path=str(out / (tab + '-' + str(width) + '.png')))
                    results.append({'mode': mode, 'width': width, **stat})
                page.locator('#view button[data-act="avail"][data-day="0"][data-slot="0"]').click()
                page.wait_for_timeout(100)
                cell = page.locator('#view button[data-act="avail"][data-day="0"][data-slot="0"]')
                before = cell.get_attribute('aria-pressed')
                cell.click()
                page.wait_for_timeout(100)
                after = page.locator('#view button[data-act="avail"][data-day="0"][data-slot="0"]').get_attribute('aria-pressed')
                assert before != after, '可用时段切换未生效'
                page.locator('#rail button[data-tab="today"]').click()
                page.wait_for_timeout(100)
                buffer = page.locator('#view button[data-act="buffer"]')
                if buffer.is_disabled():
                    assert '用量自动记账' in buffer.inner_text()
                else:
                    before = buffer.inner_text()
                    buffer.click()
                    page.wait_for_timeout(100)
                    page.locator('[data-yes]').click() if page.locator('[data-yes]').count() else None
                    page.wait_for_timeout(100)
                    after = page.locator('#view button[data-act="buffer"]').inner_text()
                    assert before != after, '弹性位未切换'
                page.locator('#rail button[data-tab="plan"]').click()
                page.wait_for_timeout(100)
                assert page.locator('#view [data-goal-new]').count() > 0, '新建目标缺失'
                page.locator('#rail button[data-tab="data"]').click()
                page.wait_for_timeout(100)
                assert page.locator('#view .report').count() > 0, '周报缺失'
                assert not errors, errors
            except Exception as exc:
                fail.append({'mode': mode, 'width': width, 'error': str(exc), 'pageerrors': errors})
            context.close()
    browser.close()
print(json.dumps({'results': results, 'failures': fail, 'network': network}, ensure_ascii=False, indent=2))
sys.exit(bool(fail))
