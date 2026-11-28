import argparse
import json
import os
import sys
from playwright.sync_api import sync_playwright

if not __debug__:
    raise SystemExit('workbench-style-check.py 不允许在 python -O / PYTHONOPTIMIZE 下运行')

parser = argparse.ArgumentParser()
parser.add_argument('--url', default=os.environ.get('NOVA_TEST_URL'))
args = parser.parse_args()
if not args.url:
    parser.error('必须显式提供 --url 或 NOVA_TEST_URL；本工具不默认访问既有 8787 服务')
URL = args.url
fail = []
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader'])
    for mode in ('dom', 'gl'):
        for width, height in ((1440, 900), (390, 844)):
            context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
            # gl3d 已废弃偏好读取，改由 html[data-gl3d] 运行时闸门控制；init script 在任何页面脚本前设置该属性。
            context.add_init_script("(()=>{const apply=()=>{const r=document.documentElement;if(!r)return false;r.dataset.gl3d='" + ('off' if mode == 'dom' else 'on') + "';return true;};if(!apply()){const o=new MutationObserver(()=>{if(apply())o.disconnect();});o.observe(document,{childList:true,subtree:true});}localStorage.setItem('zx.ui_prefs',JSON.stringify({motion:false}));})()")
            context.route('**/api/**', lambda route: route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(URL, wait_until='domcontentloaded')
            page.wait_for_selector('#rail button[data-tab="chat"]')
            if mode == 'gl':
                page.evaluate("""() => {
                  document.getElementById('gl').style.display = 'block';
                  document.getElementById('css3d').style.display = 'block';
                  window.dispatchEvent(new Event('resize'));
                }""")
                page.wait_for_function("document.documentElement.dataset.gl3d === 'on' && document.documentElement.classList.contains('gl-on') && !!document.querySelector('.gl-stream')", timeout=15000)
            for tab in ['today', 'plan', 'data', 'me']:
                page.evaluate("tab => window.ZX.setTab(tab)", tab)
                page.wait_for_timeout(300)
                result = page.evaluate(r"""() => { const root=document.documentElement; const gl=root.classList.contains('gl-on'); const view=document.querySelector('#view');const nav=document.querySelector('#rail');const rgb=s=>s.match(/\d+/g)?.slice(0,3).map(Number)||[0,0,0]; const panel=view&&view.querySelector('.wrap');const c=panel?rgb(getComputedStyle(panel).color):[0,0,0];return {tab:root.dataset.tab,mode:root.className,gl,view:!!panel,nav:!!nav.getClientRects().length,light:c.reduce((a,b)=>a+b)<500,overflow:document.documentElement.scrollWidth>innerWidth,hasContent:!!(panel&&panel.innerText.trim())}; }""")
                result.update(requested_mode=mode, width=width)
                results.append(result)
                if not (result['view'] and result['nav'] and result['light'] and not result['overflow'] and result['hasContent']):
                    fail.append(result)
                if mode == 'gl' and not result['gl']:
                    fail.append(result)
            if errors:
                fail.append({'mode': mode, 'width': width, 'errors': errors})
            context.close()
    browser.close()
print(json.dumps({'results': results, 'failures': fail}, ensure_ascii=False, indent=2))
sys.exit(1 if fail else 0)
