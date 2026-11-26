#!/usr/bin/env node
/* =========================================================
   vendor three.js 提取脚本（零依赖，Node 22+）
   ---------------------------------------------------------
   背景：WebGL 全量重构需要 three.js + CSS3DRenderer。
   file:// 双击直开是产品契约 → 只能用经典 script（UMD 全局），
   不能走 ESM/importmap（file:// 下 CORS 拦截）。
   three 0.152.2 的 build/three.min.js 就是 UMD（全局 THREE），
   但 examples 里的 CSS3DRenderer.js 只有 ESM 版（import … from 'three'），
   需要机械转换：import 块 → window.THREE 解构，export 尾 → window.ZX_CSS3D 赋值。

   用法（先在任意目录 npm pack three@0.152.2 并解包）：
     node scripts/build-vendor-three.mjs <解包后的 package 目录>
   产物（禁止手改，与 mascot 素材同纪律）：
     assets/vendor/three.min.js          ← 原样拷贝（UMD，全局 THREE）
     assets/vendor/three-css3d.js        ← CSS3DRenderer 转换（全局 ZX_CSS3D）
   ========================================================= */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Script } from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_VERSION = '0.152.2';
const pkg = process.argv[2];
if (!pkg) { console.error('用法：node scripts/build-vendor-three.mjs <解包后的 package 目录>'); process.exit(1); }

const packageJson = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error('three 版本必须是 ' + EXPECTED_VERSION + '，当前为 ' + packageJson.version);
}

const three = readFileSync(join(pkg, 'build', 'three.min.js'));
const cssSource = readFileSync(join(pkg, 'examples', 'jsm', 'renderers', 'CSS3DRenderer.js'), 'utf8');
let importConverted = false;
let exportConverted = false;
let css3d = cssSource.replace(
  /import\s*\{([^}]*)\}\s*from\s*'three';/,
  (_, names) => {
    importConverted = true;
    const list = names.split(',').map((s) => s.trim()).filter(Boolean)
      .map((n) => n.includes(' as ') ? n.split(/\s+as\s+/)[1] + ': ' + n.split(/\s+as\s+/)[0] : n)
      .join(', ');
    return 'const { ' + list + ' } = window.THREE;';
  }
);
css3d = css3d.replace(
  /export\s*\{([^}]*)\};?/,
  (_, names) => {
    exportConverted = true;
    return 'window.ZX_CSS3D = { ' + names.split(',').map((s) => s.trim()).filter(Boolean).join(', ') + ' };';
  }
);
if (!importConverted || !exportConverted || /\b(?:import|export)\s/.test(css3d)) {
  throw new Error('CSS3DRenderer 的 ESM 转换不完整，拒绝写入 vendor');
}
css3d = '/* Three.js Authors / CSS3DRenderer · MIT License · three@' + EXPECTED_VERSION + ' */\n' + css3d;
new Script(three.toString('utf8'), { filename: 'three.min.js' });
new Script(css3d, { filename: 'three-css3d.js' });

function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp';
  let created = false;
  try {
    writeFileSync(tmp, data, { flag: 'wx' });
    created = true;
    renameSync(tmp, file);
    created = false;
  } finally {
    if (created) { try { unlinkSync(tmp); } catch (e) { /* retain original error */ } }
  }
}

const outDir = join(ROOT, 'assets', 'vendor');
mkdirSync(outDir, { recursive: true });
atomicWrite(join(outDir, 'three.min.js'), three);
atomicWrite(join(outDir, 'three-css3d.js'), css3d);

console.log('vendor 完成：assets/vendor/three.min.js（UMD 全局 THREE）+ assets/vendor/three-css3d.js（全局 ZX_CSS3D）');
