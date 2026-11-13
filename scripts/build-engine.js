#!/usr/bin/env node
'use strict';
/* 诺瓦 Nova · 浏览器引擎产物构建
 *
 * 唯一实现：shared/engine/{feasibility,schedule,replan,attribute}.js（UMD 双模）
 * 产物：assets/js/rhythm.build.js —— 供 index.html 以经典 script 加载，
 *       保持 window.Rhythm.<name>.<fn> 全局契约，file:// 双击打开同样可用。
 *
 * 约束：
 * · 产物完全由本脚本拼接生成，禁止手写或复制粘贴到 assets/；
 * · 不写入时间戳等易变内容，保证同源码多次构建字节一致；
 * · 构建后校验每个源文件仍保留 UMD 的 Rhythm 挂载，避免产物在浏览器侧静默失效。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = ['feasibility.js', 'schedule.js', 'replan.js', 'attribute.js'];
const OUT = path.join(ROOT, 'assets', 'js', 'rhythm.build.js');

const BANNER = [
  '/* 自动生成文件，请勿手改。',
  ' * 来源：shared/engine/' + SOURCES.join('、'),
  ' * 生成：node scripts/build-engine.js（npm run build:engine）',
  ' */',
  ''
].join('\n');

function readSource(name) {
  const file = path.join(ROOT, 'shared', 'engine', name);
  const code = fs.readFileSync(file, 'utf8');
  if (code.indexOf('root.Rhythm') < 0) {
    throw new Error('shared/engine/' + name + ' 缺少 UMD 的 root.Rhythm 挂载，浏览器产物将不可用');
  }
  return '/* ==== shared/engine/' + name + ' ==== */\n' + code.replace(/\s+$/, '') + '\n';
}

function build() {
  const output = BANNER + '\n' + SOURCES.map(readSource).join('\n');
  fs.writeFileSync(OUT, output, 'utf8');
  return { file: OUT, bytes: Buffer.byteLength(output), modules: SOURCES.length };
}

if (require.main === module) {
  const r = build();
  process.stdout.write('引擎产物已生成：' + path.relative(ROOT, r.file) +
    '（' + r.modules + ' 个模块，' + r.bytes + ' 字节）\n');
}

module.exports = { build: build };
