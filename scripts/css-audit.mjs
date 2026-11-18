#!/usr/bin/env node
/* =========================================================
   CSS 完整性审计（零依赖，Node 22+）
   ---------------------------------------------------------
   背景：视觉层多次迭代后曾出现——破损选择器（::-webkit-4px）、
   未定义 token（--bad-a20 导致刻度条透明）、换肤暖色残留
   （#FDFAF3）、死 token / 死动画 / 死类。本脚本把人工审计固化：
     1. 括号平衡
     2. var() 引用了未定义的 token（error）
     3. 定义后从未被 var() 引用的死 token（warn；豁免见 EXEMPT_TOKENS）
     4. :root 之外出现硬编码十六进制色（error；mask 的 #000 豁免）
     5. 破损选择器片段（error）
     6. CSS 类在 JS/HTML 中零引用（warn，人工确认后删除）
   用法：npm run audit
   退出码：存在 error → 1，仅 warn → 0
   ========================================================= */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CSS_PATH = join(ROOT, 'assets', 'css', 'app.css');
const css = readFileSync(CSS_PATH, 'utf8');

const errors = [];
const warns = [];

/* ---- 1. 括号平衡（忽略注释与字符串内的花括号近似处理：本项目无 url({ 场景） ---- */
{
  let depth = 0, line = 1, inComment = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (c === '\n') line++;
    if (inComment) { if (c === '*' && n === '/') { inComment = false; i++; } continue; }
    if (c === '/' && n === '*') { inComment = true; i++; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth < 0) { errors.push(`L${line} 多余的 }`); depth = 0; } }
  }
  if (depth !== 0) errors.push(`括号不平衡：还剩 ${depth} 个未闭合的 {`);
}

/* ---- 2/3. token 引用完整性 ---- */
{
  const defined = new Set();
  for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  // 使用来源 = CSS 自身 + JS/HTML（行内 style 可引用任意 token，如 state.js 的科目色）
  const used = new Set();
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) used.add(m[1]);

  const sources = [];
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.(js|html)$/.test(f)) sources.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(ROOT, 'assets', 'js'));
  walk(join(ROOT, 'shared'));
  sources.push(readFileSync(join(ROOT, 'index.html'), 'utf8'));
  const extRefs = sources.join('\n');
  for (const m of extRefs.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) used.add(m[1]);

  // 行内样式注入（JS 模板拼 style="--c:..." / style="--d:..."）的 token 不在 CSS 中定义
  // --c：科目色；--d：diff 逐条过账的序号（assistant.js 的 .diff-line 行内注入）
  const EXEMPT_UNDEFINED = new Set(['--c', '--d']);
  for (const t of used) {
    if (!defined.has(t) && !EXEMPT_UNDEFINED.has(t)) errors.push(`var(${t}) 未定义`);
  }

  // 死 token：定义了但 CSS 与 JS/HTML 中均无 var() 引用
  const unused = [...defined].filter(t => !used.has(t));
  for (const t of unused) warns.push(`死 token ${t}（定义后无 var() 引用）`);
}

/* ---- 4. 硬编码十六进制色（换肤残留防线）：仅 :root 基础定义与 mask 的 #000 允许 ---- */
{
  let inRoot = false, line = 1, inComment = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (c === '\n') line++;
    if (inComment) { if (c === '*' && n === '/') { inComment = false; i++; } continue; }
    if (c === '/' && n === '*') { inComment = true; i++; continue; }
    if (c === '{') { /* 判定是否进入 :root */ }
    // 粗粒度：仅在文件头 :root 块内允许 hex。以首个 "}"（:root 结束）之后的 hex 为违例。
  }
  const rootEnd = css.indexOf('}', css.indexOf(':root'));
  const rest = css.slice(rootEnd);
  const restLineOffset = css.slice(0, rootEnd).split('\n').length - 1;
  for (const m of rest.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
    const v = m[0].toLowerCase();
    if (v === '#000' || v === '#000000') continue; // mask-image 黑白遮罩
    const line = restLineOffset + rest.slice(0, m.index).split('\n').length;
    errors.push(`L${line} :root 之外出现硬编码色 ${m[0]}（应走 token）`);
  }
}

/* ---- 5. 破损选择器片段（历史事故模式：::-webkit-4px 这类无规则体悬空行） ---- */
{
  const lines = css.split('\n');
  lines.forEach((ln, idx) => {
    const t = ln.trim();
    // 选择器样式的行（以 { 结尾才算完整规则开头）；此处只抓已知事故形态
    if (/::-webkit-[0-9]/.test(t)) errors.push(`L${idx + 1} 破损选择器片段: ${t}`);
    // 悬空行：像选择器（含 . 或 ::）但行尾既非 { 也非 , 也非 ; 也不是注释尾
    if (/^[.#][a-zA-Z][^{}/;]*$/.test(t) && !t.endsWith('{') && !t.endsWith(',')) {
      errors.push(`L${idx + 1} 悬空选择器行: ${t}`);
    }
  });
}

/* ---- 6. 死类候选：CSS 类在 JS/HTML 文本中零引用（word 边界，人工确认） ---- */
{
  const sources = [];
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.(js|html)$/.test(f)) sources.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(ROOT, 'assets', 'js'));
  walk(join(ROOT, 'shared'));
  sources.push(readFileSync(join(ROOT, 'index.html'), 'utf8'));
  const refs = sources.join('\n');

  // 精确收集「真正出现在 DOM 上的 class token」：
  //   1) class="..." 属性值按空白切分（class="a b" / class="x ' + y + '"）
  //   2) classList.add/remove/toggle/contains('...')
  // 用词边界搜索整个源码会产生假阴性（flow.step 让 .step 被判为在用）、
  // 也会有假阳性（子串命中），故改为 token 精确比对。
  const usedTokens = new Set();
  // 1) class="..." 属性字面量
  for (const m of refs.matchAll(/class\s*=\s*["']([^"']*)["']/g)) {
    for (const t of m[1].split(/\s+/)) if (t) usedTokens.add(t);
  }
  // 2) el.className = 'a b' 赋值
  for (const m of refs.matchAll(/className\s*=\s*["']([^"']*)["']/g)) {
    for (const t of m[1].split(/\s+/)) if (t) usedTokens.add(t);
  }
  // 3) classList.add/remove/toggle/contains('...')
  for (const m of refs.matchAll(/classList\.(?:add|remove|toggle|contains)\s*\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/["'`]([^"'`]*)["'`]/g)) {
      for (const t of q[1].split(/\s+/)) if (t) usedTokens.add(t);
    }
  }
  // 4) 拼接字面量中的类名：' silent'、' tt-sub'、' gap' + ' zero'、' is-locked' 等。
  //    这些以空格开头的片段挂在既有 class 后面。JS 源码里的 \" 转义引号会破坏字面量配对，
  //    故不做引号配对解析，直接在全量文本中按「类名形态」取词元
  //    （小写字母开头，可含数字与连字符），可覆盖变量拼接与三元表达式。
  for (const t of (refs.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g) || [])) usedTokens.add(t);

  // 类选择器：先剥离 CSS 注释，避免把「统一 .sa- 前缀」这类说明文字当成类名。
  // 剥离后仍需剔除「命名空间前缀」残留（如 .sa- 单独出现），只保留真实类名形态。
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set();
  // 类选择器（排除 var/属性值场景）：.name 出现在选择器位置（行首或 { 前/逗号后/组合符后）
  for (const m of cssNoComment.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) classes.add(m[1]);
  // 去掉末尾连字符的前缀碎片（.sa- / .sc2- 之类，无实际元素挂载）
  for (const c of [...classes]) if (c.endsWith('-')) classes.delete(c);
  const dead = [...classes].filter(c => !usedTokens.has(c)).sort();
  for (const c of dead) warns.push(`死类候选 .${c}（JS/HTML 零引用，确认后删除）`);
}

/* ---- 报告 ---- */
const all = [...errors.map(e => ['ERROR', e]), ...warns.map(w => ['WARN ', w])];
if (all.length === 0) {
  console.log('✓ CSS 审计通过：括号平衡、token 完整、无硬编码色、无破损选择器、无死类候选');
  process.exit(0);
}
for (const [lvl, msg] of all) console.log(lvl + ' ' + msg);
console.log(`\n${errors.length} error, ${warns.length} warn`);
process.exit(errors.length > 0 ? 1 : 0);
