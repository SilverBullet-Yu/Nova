'use strict';
/* 诺瓦 Nova · 形象素材与内联副本一致性
 * 契约：docs/IP-DESIGN.md §5.1 / §7、docs/FRONTEND-CONTRACT.md §2.1 / §8
 * 运行：npm test
 * 目的：素材是 scripts/build-mascot-v4.js 的产物，禁止手改——
 *       这里把「产物与脚本同源」「内联副本与源素材逐字节一致」变成可自动拦截的门禁。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const IMG = path.join(ROOT, 'assets', 'img');
const INLINE = path.join(ROOT, 'assets', 'js', 'mascot-inline.js');
const HTML = path.join(ROOT, 'index.html');
const BUILDER = path.join(ROOT, 'scripts', 'build-mascot-v4.js');

/* 内联副本的键 → 源素材文件 */
const AVATAR_MAP = {
  idleAvatar: 'avatar-v4.svg',
  listenAvatar: 'avatar-v4-listen.svg',
  offlineAvatar: 'avatar-v4-offline.svg'
};

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('assets/img 素材齐全：10 个 mascot-v4* + 3 个 avatar-v4* + favicon-v4', () => {
  const files = fs.readdirSync(IMG).filter((f) => f.endsWith('.svg')).sort();
  assert.equal(files.length, 14, '素材总数应为 14：' + files.join(', '));
  assert.equal(files.filter((f) => f.startsWith('mascot-v4')).length, 10);
  assert.equal(files.filter((f) => f.startsWith('avatar-v4')).length, 3);
  assert.ok(files.includes('favicon-v4.svg'));
});

test('内联副本与源素材逐字节一致（idle / listen / offline）', () => {
  const inline = fs.readFileSync(INLINE, 'utf8');
  for (const [key, file] of Object.entries(AVATAR_MAP)) {
    const m = new RegExp('window\\.ZX_MASCOT\\.' + key + ' = "data:image/svg\\+xml;base64,([A-Za-z0-9+/=]+)"').exec(inline);
    assert.ok(m, key + ' 未在 mascot-inline.js 中定义');
    const decoded = Buffer.from(m[1], 'base64');
    const src = fs.readFileSync(path.join(IMG, file));
    assert.ok(decoded.equals(src),
      key + ' 与 assets/img/' + file + ' 不一致：需重跑 node scripts/build-mascot-v4.js');
  }
});

test('index.html 按序加载内联副本，并挂载输入台聆听头像', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  /* 按 script 标签定位：正文注释里也出现过 assets/js/util.js（首帧脚本的存储键说明） */
  const inlineIdx = html.indexOf('<script src="assets/js/mascot-inline.js">');
  const utilIdx = html.indexOf('<script src="assets/js/util.js">');
  assert.ok(inlineIdx > 0, 'index.html 未引用 assets/js/mascot-inline.js');
  assert.ok(utilIdx > inlineIdx, 'mascot-inline.js 必须在 util.js 之前加载');
  assert.match(html, /<img[^>]*class="cp-listen"[^>]*id="cpListen"[^>]*>/,
    '输入台缺少 #cpListen 聆听头像');
});

test('生成器幂等：重跑 build-mascot-v4.js 不改变任何产物', () => {
  /* 先把全部产物读进内存，跑生成器后逐个比对；不一致时写回原字节，保证工作区不被污染 */
  const before = new Map();
  for (const f of fs.readdirSync(IMG)) before.set(path.join(IMG, f), fs.readFileSync(path.join(IMG, f)));
  before.set(INLINE, fs.readFileSync(INLINE));
  const beforeHash = new Map([...before].map(([k, v]) => [k, crypto.createHash('sha256').update(v).digest('hex')]));

  const r = spawnSync(process.execPath, [BUILDER], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, '生成器执行失败：' + (r.stderr || '').slice(0, 300));

  const changed = [];
  for (const [file, hash] of beforeHash) {
    if (!fs.existsSync(file)) { changed.push(path.basename(file) + '（被删除）'); continue; }
    if (sha(file) !== hash) changed.push(path.basename(file));
  }
  const extra = fs.readdirSync(IMG).filter((f) => !beforeHash.has(path.join(IMG, f)));
  changed.push(...extra.map((f) => f + '（新增）'));

  if (changed.length) {
    /* 还原工作区，再失败：门禁只报错，不留脏状态 */
    for (const [file, buf] of before) fs.writeFileSync(file, buf);
    assert.fail('重跑生成器后产物发生变化，说明仓库内素材与生成脚本不同步：' + changed.join(', '));
  }
});
