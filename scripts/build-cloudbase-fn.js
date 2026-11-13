#!/usr/bin/env node
'use strict';
/* 诺瓦 Nova · 组装 CloudBase HTTP 云函数部署包
 *
 * 源仓库保持原样（前后端同源可本地 npm start），这里只做「取子集 + 落入口文件」：
 *   .deploy/cloudbase-functions/nova/
 *
 * 用法：node scripts/build-cloudbase-fn.mjs
 * 之后用 functionRootPath = .deploy/cloudbase-functions 交给 CloudBase 部署。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, '.deploy', 'cloudbase-functions');
const FN_DIR = path.join(OUT_ROOT, 'nova');

/* 函数包只需要「运行时 + 静态资源」，不含测试、文档、部署脚本与本地缓存 */
const COPY = ['index.html', 'assets', 'shared', 'server'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/* 手工递归复制：本机 fs.cpSync 在含中文的工作区路径下会静默中断（exit 127），
   改用 readdir + copyFileSync 的等价实现，行为可预期。 */
function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      copyTree(path.join(src, e.name), path.join(dst, e.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function build() {
  rmrf(FN_DIR);
  fs.mkdirSync(FN_DIR, { recursive: true });

  for (const rel of COPY) {
    const src = path.join(ROOT, rel);
    const dst = path.join(FN_DIR, rel);
    if (!fs.existsSync(src)) throw new Error('缺少必需文件：' + rel);
    copyTree(src, dst);
  }

  /* 云函数入口与引导脚本（来源：deploy/cloudbase/function/） */
  const entryDir = path.join(ROOT, 'deploy', 'cloudbase', 'function');
  fs.copyFileSync(path.join(entryDir, 'index.js'), path.join(FN_DIR, 'index.js'));
  const boot = path.join(FN_DIR, 'scf_bootstrap');
  fs.copyFileSync(path.join(entryDir, 'scf_bootstrap'), boot);
  fs.chmodSync(boot, 0o755);

  /* 函数包内独立的 package.json：零依赖，不继承仓库的 scripts/engines */
  const pkg = {
    name: 'nova',
    version: '1.0.0',
    private: true,
    description: '诺瓦 Nova · CloudBase HTTP 云函数（API + 静态前端同源）',
    main: 'index.js',
    license: 'MIT'
  };
  fs.writeFileSync(path.join(FN_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  let files = 0;
  let bytes = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  })(FN_DIR);

  process.stdout.write('部署包已生成：' + FN_DIR + '\n');
  process.stdout.write('  文件 ' + files + ' 个，合计 ' + (bytes / 1024).toFixed(0) + ' KB\n');
  process.stdout.write('  functionRootPath = ' + OUT_ROOT + '\n');
}

build();
