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
const vm = require('node:vm');
const crypto = require('node:crypto');

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
  new vm.Script(code, { filename: file });
  const sandbox = { self: {} };
  vm.runInNewContext(code, sandbox, { filename: file });
  const exportName = name.replace(/\.js$/, '');
  if (!sandbox.self.Rhythm || !sandbox.self.Rhythm[exportName]) {
    throw new Error('shared/engine/' + name + ' 未导出 window.Rhythm.' + exportName);
  }
  return '/* ==== shared/engine/' + name + ' ==== */\n' + code.replace(/\s+$/, '') + '\n';
}

function render() {
  const output = BANNER + '\n' + SOURCES.map(readSource).join('\n');
  new vm.Script(output, { filename: OUT });
  return output;
}

function build() {
  const output = render();
  const tmp = OUT + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let created = false;
  try {
    fs.writeFileSync(tmp, output, { encoding: 'utf8', flag: 'wx' });
    created = true;
    fs.renameSync(tmp, OUT);
    created = false;
  } finally {
    if (created) { try { fs.unlinkSync(tmp); } catch (e) { /* retain original error */ } }
  }
  return { file: OUT, bytes: Buffer.byteLength(output), modules: SOURCES.length };
}

function check() {
  const expected = render();
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  return { file: OUT, current: current === expected, bytes: Buffer.byteLength(expected), modules: SOURCES.length };
}

if (require.main === module) {
  const mode = process.argv[2];
  if (mode !== undefined && mode !== '--check') throw new Error('未知参数：' + mode);
  const r = mode === '--check' ? check() : build();
  if (mode === '--check' && !r.current) {
    process.stderr.write('引擎产物与源码不一致，请运行 npm run build:engine\n');
    process.exitCode = 1;
  } else {
    process.stdout.write((mode === '--check' ? '引擎产物校验：' : '引擎产物已生成：') + path.relative(ROOT, r.file) +
      '（' + r.modules + ' 个模块，' + r.bytes + ' 字节）\n');
  }
}

module.exports = { build: build, render: render, check: check };
