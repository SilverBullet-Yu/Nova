/* =========================================================
   诺瓦 v3 素材生成器（零依赖）
   node scripts/build-mascot-v3.js  →  输出到 assets/img/
     mascot-v3.svg          主立绘 · 琥珀涂装（产品内用）
     mascot-v3-classic.svg  主立绘 · 原味涂装（周边/表情包，不进产品 UI）
     mascot-v3-listen.svg   ② 聆听态（对话输入聚焦）
     mascot-v3-focus.svg    ④ 专注态（计时进行中）
     avatar-v3.svg          章式头像（顶栏 .seal / 对话 .avatar）
     favicon-v3.svg         16px 最小形
   造型语言取自《赛尔号》超能NoNo 的轮廓类别（斜向长耳天线 / 球形机身 /
   深色大面罩 / 竖胶囊发光眼 / 悬浮尾迹 / 水滴推进器），具体形状、比例、
   配色与胸口朱砂「诺」印均为原创构型，非原设描摹。
   ========================================================= */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'assets', 'img');

/* 涂装：全部色值取自 assets/css/app.css（琥珀版）或原味涂装色板 */
const AMBER = {
  shell: '#FCF9F1', line: '#241E16', visor: '#2A2318', rim: '#D9A44A',
  lens: '#D9A44A', lensCore: '#F1C97F', eye: '#D9A44A', eyeHi: 'rgba(252,249,241,.55)',
  mouth: 'rgba(217,164,74,.8)', visorHi: 'rgba(252,249,241,.12)',
  seal: '#9C3B2B', sealInk: '#FCF9F1', joint: '#EFE6D2',
  grid: 'rgba(36,30,22,.05)', shade: 'rgba(36,30,22,.05)', hi: 'rgba(255,255,255,.55)',
  shadow: 'rgba(36,30,22,.13)', tail: 'rgba(217,164,74,.30)', tail2: 'rgba(217,164,74,.24)', tail3: 'rgba(217,164,74,.36)',
  thruster: '#EFE6D2', heart: '#D9A44A', sealRing: null
};
const CLASSIC = {
  shell: '#F2F6F8', line: '#2B3440', visor: '#1D2B52', rim: '#3FCBEA',
  lens: '#3FCBEA', lensCore: '#C9F4FC', eye: '#5CE6F7', eyeHi: 'rgba(255,255,255,.7)',
  mouth: 'rgba(92,230,247,.8)', visorHi: 'rgba(255,255,255,.12)',
  seal: '#9C3B2B', sealInk: '#FFF5EF', joint: '#E4EAEF',
  grid: 'rgba(43,52,64,.06)', shade: 'rgba(43,52,64,.06)', hi: 'rgba(255,255,255,.6)',
  shadow: 'rgba(43,52,64,.15)', tail: 'rgba(63,203,234,.28)', tail2: 'rgba(63,203,234,.22)', tail3: 'rgba(63,203,234,.44)',
  thruster: '#E4EAEF', heart: '#3FCBEA', sealRing: null
};

/* 主立绘：几何对所有涂装/状态一致，只换色与局部零件 */
function body(c, o) {
  o = o || {};
  const eyeH = o.eyeH || 36;
  const eyeY = Math.round(157 - eyeH / 2);
  const lens = o.earLens || c.lens;
  const lensCore = o.earCore || c.lensCore;
  const arcs = o.arcs
    ? '<path d="M46 52C40 58 40 68 46 74" fill="none" stroke="' + c.rim + '" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M38 44C28 54 28 72 38 82" fill="none" stroke="' + c.rim + '" stroke-width="3" stroke-linecap="round" opacity=".55"/>' +
      '<path d="M194 52C200 58 200 68 194 74" fill="none" stroke="' + c.rim + '" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M202 44C212 54 212 72 202 82" fill="none" stroke="' + c.rim + '" stroke-width="3" stroke-linecap="round" opacity=".55"/>'
    : '';
  const ring = o.ring
    ? '<circle cx="120" cy="223" r="18.5" fill="none" stroke="rgba(157,59,43,.22)" stroke-width="2.4"/>' +
      '<circle cx="120" cy="223" r="18.5" fill="none" stroke="#9C3B2B" stroke-width="3" stroke-linecap="round" stroke-dasharray="50 66" transform="rotate(-90 120 223)"/>'
    : '';
  const sealFill = o.sealFill || c.seal;
  const sealInk = o.sealInk || c.sealInk;

  return '<defs>' +
    '<pattern id="gridp" width="12" height="12" patternUnits="userSpaceOnUse">' +
      '<path d="M12 0H0V12" fill="none" stroke="' + c.grid + '" stroke-width="1"/>' +
    '</pattern>' +
    '<clipPath id="ballClip"><ellipse cx="120" cy="168" rx="78" ry="72"/></clipPath>' +
  '</defs>' +

  /* 纸影（悬浮） */
  '<ellipse cx="120" cy="270" rx="50" ry="7" fill="' + c.shadow + '"/>' +

  /* 悬浮尾迹（身后右侧） */
  '<path d="M180 182C202 187 216 199 223 216C205 210 191 201 180 191Z" fill="' + c.tail + '"/>' +
  '<path d="M184 187C200 191 211 200 217 212C203 207 193 199 184 192Z" fill="' + c.tail2 + '"/>' +
  '<path d="M187 190C198 194 206 200 211 209C200 205 193 199 187 194Z" fill="' + c.tail3 + '"/>' +

  /* 水滴悬浮推进器 ×2 */
  '<g stroke="' + c.line + '" stroke-width="2.5" fill="' + c.thruster + '">' +
    '<ellipse cx="76" cy="234" rx="16" ry="11" transform="rotate(-22 76 234)"/>' +
    '<ellipse cx="164" cy="234" rx="16" ry="11" transform="rotate(22 164 234)"/>' +
  '</g>' +
  '<g fill="' + c.heart + '">' +
    '<ellipse cx="77" cy="236" rx="6" ry="3.4" transform="rotate(-22 77 236)"/>' +
    '<ellipse cx="163" cy="236" rx="6" ry="3.4" transform="rotate(22 163 236)"/>' +
  '</g>' +

  /* 双耳天线：斜向长椭圆壳 + 琥珀内透镜 */
  '<g transform="rotate(-26 86 60)">' +
    '<ellipse cx="86" cy="60" rx="13" ry="42" fill="' + c.shell + '" stroke="' + c.line + '" stroke-width="2.5"/>' +
    '<rect x="81.5" y="32" width="9" height="56" rx="4.5" fill="' + lens + '"/>' +
    '<rect x="83.5" y="36" width="5" height="48" rx="2.5" fill="' + lensCore + '"/>' +
  '</g>' +
  '<g transform="rotate(26 154 60)">' +
    '<ellipse cx="154" cy="60" rx="13" ry="42" fill="' + c.shell + '" stroke="' + c.line + '" stroke-width="2.5"/>' +
    '<rect x="149.5" y="32" width="9" height="56" rx="4.5" fill="' + lens + '"/>' +
    '<rect x="151.5" y="36" width="5" height="48" rx="2.5" fill="' + lensCore + '"/>' +
  '</g>' +

  /* 球形机身 */
  '<ellipse cx="120" cy="168" rx="78" ry="72" fill="' + c.shell + '" stroke="' + c.line + '" stroke-width="2.5"/>' +
  '<ellipse cx="120" cy="168" rx="78" ry="72" fill="url(#gridp)" clip-path="url(#ballClip)"/>' +
  '<ellipse cx="150" cy="212" rx="44" ry="18" fill="' + c.shade + '" clip-path="url(#ballClip)"/>' +
  '<ellipse cx="95" cy="120" rx="22" ry="10" fill="' + c.hi + '" transform="rotate(-24 95 120)"/>' +

  /* 耳根关节 ×2 */
  '<g stroke="' + c.line + '" stroke-width="2.5" fill="' + c.joint + '">' +
    '<circle cx="104" cy="98" r="7"/><circle cx="136" cy="98" r="7"/>' +
  '</g>' +

  /* 大面罩：深色 + 活性色描边（原设的「发光屏」转译） */
  '<rect x="56" y="110" width="128" height="94" rx="42" fill="' + c.visor + '"/>' +
  '<rect x="56" y="110" width="128" height="94" rx="42" fill="none" stroke="' + c.rim + '" stroke-width="2.5"/>' +
  '<rect x="61" y="115" width="118" height="84" rx="37" fill="none" stroke="' + c.visorHi + '" stroke-width="1"/>' +
  /* 面罩反光斜块 */
  '<rect x="134" y="118" width="32" height="13" rx="6.5" fill="' + c.visorHi + '" transform="rotate(-10 150 124)"/>' +
  /* 竖胶囊眼 ×2 */
  '<rect x="98" y="' + eyeY + '" width="14" height="' + eyeH + '" rx="7" fill="' + c.eye + '"/>' +
  '<rect x="128" y="' + eyeY + '" width="14" height="' + eyeH + '" rx="7" fill="' + c.eye + '"/>' +
  '<rect x="101.5" y="' + (eyeY + 5) + '" width="4.5" height="12" rx="2.25" fill="' + c.eyeHi + '"/>' +
  '<rect x="131.5" y="' + (eyeY + 5) + '" width="4.5" height="12" rx="2.25" fill="' + c.eyeHi + '"/>' +
  /* 嘴 */
  '<rect x="112" y="180" width="16" height="5" rx="2.5" fill="' + c.mouth + '"/>' +

  /* 胸口：银环 + 朱砂「诺」印（身份锚点：是诺瓦，不是 NoNo） */
  '<circle cx="120" cy="223" r="13" fill="' + c.joint + '" stroke="' + c.line + '" stroke-width="2.5"/>' +
  ring +
  '<rect x="111" y="214" width="18" height="18" rx="3" fill="' + sealFill + '"/>' +
  '<text x="120" y="228" text-anchor="middle" font-family="\'Songti SC\',\'Noto Serif SC\',\'SimSun\',serif" font-size="12" font-weight="700" fill="' + sealInk + '">诺</text>' +

  arcs;
}

function svg(w, h, label, inner) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + label + '">' +
    '<!-- 诺瓦 v3 · 原创构型；造型类别致敬《赛尔号》超能NoNo，细节与配色均非原设 -->' +
    inner + '</svg>';
}

/* 章式头像（96 网格）：墨底 + 斜耳 + 双眼 + 朱砂印 */
function avatar() {
  return svg(96, 96, '诺瓦 v3 头像：章式简化版（斜耳 + 双眼）',
    '<rect width="96" height="96" rx="14" fill="#241E16"/>' +
    '<g transform="rotate(-33 32 34)"><rect x="25.5" y="5" width="13" height="34" rx="6.5" fill="#D9A44A"/></g>' +
    '<g transform="rotate(33 64 34)"><rect x="57.5" y="5" width="13" height="34" rx="6.5" fill="#D9A44A"/></g>' +
    '<rect x="34" y="52" width="9" height="18" rx="4.5" fill="#D9A44A"/>' +
    '<rect x="53" y="52" width="9" height="18" rx="4.5" fill="#D9A44A"/>' +
    '<rect x="43.5" y="77" width="9" height="9" rx="1.8" fill="#9C3B2B"/>');
}

/* favicon（16 网格）：最小可辨识形 */
function favicon() {
  return svg(16, 16, '诺瓦 v3 favicon',
    '<rect width="16" height="16" rx="3" fill="#241E16"/>' +
    '<path d="M6.2 7.6C4.9 5.7 3.8 3.6 3.3 2Q3.1 1.2 3.9 1.2Q4.5 1.3 4.9 2.3C5.6 3.9 6.2 5.7 7 7.1Z" fill="#D9A44A"/>' +
    '<path d="M9.8 7.6C11.1 5.7 12.2 3.6 12.7 2Q12.9 1.2 12.1 1.2Q11.5 1.3 11.1 2.3C10.4 3.9 9.8 5.7 9 7.1Z" fill="#D9A44A"/>' +
    '<rect x="4.4" y="7" width="2.4" height="5" rx="1.2" fill="#D9A44A"/>' +
    '<rect x="9.2" y="7" width="2.4" height="5" rx="1.2" fill="#D9A44A"/>' +
    '<rect x="7" y="13" width="2" height="2" rx=".5" fill="#9C3B2B"/>');
}

/* 章式头像 · 聆听态（②）：眼拉高 + 两侧声弧 */
function avatarListen() {
  return svg(96, 96, '诺瓦 v3 头像：聆听态（眼拉高 + 声弧）',
    '<rect width="96" height="96" rx="14" fill="#241E16"/>' +
    '<g transform="rotate(-33 32 34)"><rect x="25.5" y="5" width="13" height="34" rx="6.5" fill="#D9A44A"/></g>' +
    '<g transform="rotate(33 64 34)"><rect x="57.5" y="5" width="13" height="34" rx="6.5" fill="#D9A44A"/></g>' +
    '<rect x="34.5" y="46" width="8" height="26" rx="4" fill="#D9A44A"/>' +
    '<rect x="53.5" y="46" width="8" height="26" rx="4" fill="#D9A44A"/>' +
    '<path d="M16 44C12 48 12 55 16 59" fill="none" stroke="#D9A44A" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M80 44C84 48 84 55 80 59" fill="none" stroke="#D9A44A" stroke-width="3" stroke-linecap="round"/>' +
    '<rect x="43.5" y="77" width="9" height="9" rx="1.8" fill="#9C3B2B"/>');
}

const files = {
  'mascot-v3.svg': svg(240, 300, '诺瓦 v3：球形悬浮机器管家（琥珀涂装）', body(AMBER, {})),
  'mascot-v3-classic.svg': svg(240, 300, '诺瓦 v3：球形悬浮机器管家（原味涂装）', body(CLASSIC, {})),
  'mascot-v3-listen.svg': svg(240, 300, '诺瓦 v3：聆听态', body(AMBER, { eyeH: 46, arcs: true })),
  'mascot-v3-focus.svg': svg(240, 300, '诺瓦 v3：专注态（计时进行中）', body(AMBER, { earLens: '#9C3B2B', earCore: '#C9705F', ring: true })),
  'avatar-v3.svg': avatar(),
  'avatar-v3-listen.svg': avatarListen(),
  'favicon-v3.svg': favicon()
};

fs.mkdirSync(OUT, { recursive: true });
Object.keys(files).forEach(function (name) {
  fs.writeFileSync(path.join(OUT, name), files[name], 'utf8');
  console.log('wrote assets/img/' + name + ' (' + files[name].length + ' bytes)');
});
