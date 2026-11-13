/* =========================================================
   诺瓦 v4 素材生成器（零依赖）
   node scripts/build-mascot-v4.js  →  输出到 assets/img/
     mascot-v4.svg          ① 待机 idle（琥珀涂装，主形象）
     mascot-v4-classic.svg  ① 主立绘 · 原味涂装（周边/表情包，不进产品 UI）
     mascot-v4-listen.svg   ② 聆听态（输入聚焦）
     mascot-v4-focus.svg    ④ 专注态（计时进行中）
     mascot-v4-calc.svg     ③ 计算中（排程 / 重排 / 可行性等待）
     mascot-v4-done.svg     ⑤ 达成（任务完成）
     mascot-v4-rescue.svg   ⑥ 挽救（中断后把计划接回来）
     mascot-v4-warn.svg     ⑦ 提醒（偏差归因 / 负载预警）
     mascot-v4-offline.svg  ⑧ 离线（本地兜底）
     mascot-v4-unknown.svg  ⑨ 兜底（关键词未命中）
     avatar-v4.svg / avatar-v4-listen.svg / avatar-v4-offline.svg   章式头像
     favicon-v4.svg         16px 最小形
   造型语言取自《赛尔号》超能NoNo 的轮廓类别（斜向细长光柱耳 / 白球机身 /
   椭圆大面罩 + 活性色描边 / 发光竖条眼 / 外挂小圆点 / 悬浮飞溅），
   具体形状、比例与胸口朱砂「诺」印均为原创构型，非原设描摹。
   ========================================================= */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'assets', 'img');

/* 主涂装：墨蓝（与产品主题一致：纸白机身 + 墨蓝描边与发光眼耳） */
const BLUE = {
  body: '#FFFFFF', bodyHi: 'rgba(224,234,248,.55)', bodySh: 'rgba(18,26,40,.07)', line: '#141922',
  visor: '#1A2230', rim: '#4C7FD0',
  eye: '#4C7FD0', eyeCore: '#A9C4E8', eyeHi: 'rgba(255,255,255,.55)',
  glare: 'rgba(255,255,255,.42)',
  shaft: 'rgba(76,127,208,.42)', shaft2: 'rgba(76,127,208,.20)',
  lens: 'rgba(76,127,208,.94)', lensCore: 'rgba(169,196,232,.88)',
  joint: '#E7ECF3', seal: '#A03B2C', sealInk: '#FFFFFF',
  splash: 'rgba(76,127,208,.16)', splash2: 'rgba(76,127,208,.11)',
  shadow: 'rgba(18,26,40,.11)', paper: '#FFFFFF', paperLine: '#141922'
};
const CLASSIC = {
  body: '#F7FAFB', bodyHi: 'rgba(255,255,255,.7)', bodySh: 'rgba(43,52,64,.05)', line: '#2B3440',
  visor: '#05070B', rim: '#2FE3F2',
  eye: '#2FE3F2', eyeCore: '#C9F4FC', eyeHi: 'rgba(255,255,255,.75)',
  glare: 'rgba(255,255,255,.5)',
  shaft: 'rgba(161,234,236,.6)', shaft2: 'rgba(161,234,236,.28)',
  lens: 'rgba(120,226,232,.94)', lensCore: 'rgba(201,244,252,.9)',
  joint: '#FFFFFF', seal: '#9C3B2B', sealInk: '#FFF5EF',
  splash: 'rgba(47,227,242,.2)', splash2: 'rgba(47,227,242,.13)',
  shadow: 'rgba(43,52,64,.12)', paper: '#FFFFFF', paperLine: '#2B3440'
};
/* ⑧ 离线：整体褪色（低饱和暖灰） */
const OFFLINE = {
  body: '#EAEDF2', bodyHi: 'rgba(255,255,255,.45)', bodySh: 'rgba(18,26,40,.07)', line: '#3A424E',
  visor: '#333B47', rim: '#A9B2BE',
  eye: '#A9B2BE', eyeCore: '#C8CFD8', eyeHi: 'rgba(255,255,255,.3)',
  glare: 'rgba(255,255,255,.2)',
  shaft: 'rgba(18,26,40,.10)', shaft2: 'rgba(18,26,40,.06)',
  lens: 'rgba(18,26,40,.22)', lensCore: 'rgba(18,26,40,.14)',
  joint: '#DDE2EA', seal: '#A03B2C', sealInk: '#FFFFFF',
  splash: 'rgba(18,26,40,.08)', splash2: 'rgba(18,26,40,.05)',
  shadow: 'rgba(18,26,40,.08)', paper: '#F4F6F9', paperLine: '#3A424E'
};
/* ⑦ 提醒：耳变深赭 */
const WARN = Object.assign({}, BLUE, {
  shaft: 'rgba(44,90,158,.44)', shaft2: 'rgba(44,90,158,.22)',
  lens: 'rgba(44,90,158,.96)', lensCore: 'rgba(126,164,214,.9)'
});

const SERIF = "'Songti SC','Noto Serif SC','SimSun',serif";

/* 锥形光柱段：P0 → P1，半宽 wb → wt */
function shaftEar(p0, p1, wb, wt) {
  var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var nx = -dy / len, ny = dx / len;
  function pt(p, s) { return [p[0] + nx * s, p[1] + ny * s]; }
  var m = pt(p0, wb), l1 = pt(p1, wt), l2 = pt(p1, -wt), b = pt(p0, -wb);
  return 'M' + m[0].toFixed(1) + ' ' + m[1].toFixed(1) +
    'L' + l1[0].toFixed(1) + ' ' + l1[1].toFixed(1) +
    'L' + l2[0].toFixed(1) + ' ' + l2[1].toFixed(1) +
    'L' + b[0].toFixed(1) + ' ' + b[1].toFixed(1) + 'Z';
}

/* 三段递减光柱：由实到淡，尖端收细 */
function taperShaft(p0, p1, wb, wt, fills) {
  var d1 = [p0[0] + (p1[0] - p0[0]) * 0.42, p0[1] + (p1[1] - p0[1]) * 0.42];
  var d2 = [p0[0] + (p1[0] - p0[0]) * 0.78, p0[1] + (p1[1] - p0[1]) * 0.78];
  var w1 = wb + (wt - wb) * 0.42, w2 = wb + (wt - wb) * 0.78;
  return '<path d="' + shaftEar(p0, d1, wb, w1) + '" fill="' + fills[0] + '"/>' +
    '<path d="' + shaftEar(d1, d2, w1, w2) + '" fill="' + fills[1] + '"/>' +
    '<path d="' + shaftEar(d2, p1, w2, wt) + '" fill="' + fills[2] + '"/>' +
    '<circle cx="' + p1[0] + '" cy="' + p1[1] + '" r="' + wt + '" fill="' + fills[2] + '"/>';
}

/* ---------- 面罩内的“脸”：每态只改这部分 ---------- */
function faceIdle(c, o) {
  var eyeH = o.eyeH || 1;
  var lh = 24 * eyeH, rh = 22 * eyeH;
  var ly = 143 - lh / 2, ry = 133 - rh / 2;
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' +
    '<rect x="117" y="' + ly.toFixed(1) + '" width="7" height="' + lh.toFixed(1) + '" rx="3.5" fill="' + c.eye + '"/>' +
    '<rect x="151" y="' + ry.toFixed(1) + '" width="6.5" height="' + rh.toFixed(1) + '" rx="3.25" fill="' + c.eye + '"/>' +
    '<rect x="118.4" y="' + (ly + 4).toFixed(1) + '" width="2.3" height="' + (lh * 0.4).toFixed(1) + '" rx="1.15" fill="' + c.eyeHi + '"/>' +
    '<rect x="152.4" y="' + (ry + 4).toFixed(1) + '" width="2.1" height="' + (rh * 0.4).toFixed(1) + '" rx="1.05" fill="' + c.eyeHi + '"/>';
}

/* ③ 计算中：六点矩阵 */
function faceCalc(c) {
  var pts = '';
  [131, 141, 151].forEach(function (y) {
    pts += '<circle cx="123" cy="' + y + '" r="2.7" fill="' + c.eye + '"/>';
    pts += '<circle cx="154" cy="' + y + '" r="2.7" fill="' + c.eye + '"/>';
  });
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' + pts;
}

/* ⑤ 达成：月牙眼 + 笑弧 */
function faceDone(c) {
  var moonL = 'M117 132 A 8 8 0 0 0 125 132 A 4.5 8 0 0 1 117 132 Z';
  var moonR = 'M151 121 A 8 8 0 0 0 159 121 A 4.5 8 0 0 1 151 121 Z';
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' +
    '<path d="' + moonL + '" fill="' + c.eye + '"/>' +
    '<path d="' + moonR + '" fill="' + c.eye + '"/>' +
    '<path d="M127 151 Q138 162 149 151" fill="none" stroke="' + c.eye + '" stroke-width="2.6" stroke-linecap="round"/>';
}

/* ⑥ 挽救：闭眼下弯 + 安静平嘴 */
function faceRescue(c) {
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' +
    '<path d="M117 136 Q122 144 127 136" fill="none" stroke="' + c.eye + '" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M152 135 Q157 143 162 135" fill="none" stroke="' + c.eye + '" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M132 156 L144 156" stroke="' + c.eye + '" stroke-width="2.4" stroke-linecap="round"/>';
}

/* ⑦ 提醒：紧张眼「><」 */
function faceWarn(c) {
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' +
    '<path d="M118 135 L124 141 L118 147" fill="none" stroke="' + c.eye + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M158 135 L152 141 L158 147" fill="none" stroke="' + c.eye + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M133 157 L143 157" stroke="' + c.eye + '" stroke-width="2.4" stroke-linecap="round"/>';
}

/* ⑧ 离线：横条眼 */
function faceOffline(c) {
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' +
    '<rect x="118" y="138" width="11" height="4" rx="2" fill="' + c.eye + '"/>' +
    '<rect x="152" y="137" width="10" height="4" rx="2" fill="' + c.eye + '"/>';
}

/* ⑨ 兜底：单眼 + 「?」 + o 嘴 */
function faceUnknown(c) {
  return '<rect x="140" y="104" width="31" height="23" rx="8" fill="' + c.glare + '"/>' +
    '<rect x="119" y="131" width="7" height="22" rx="3.5" fill="' + c.eye + '"/>' +
    '<text x="152" y="152" text-anchor="middle" font-family="' + SERIF + '" font-size="26" font-weight="700" fill="' + c.eye + '">?</text>' +
    '<circle cx="138" cy="156" r="3.4" fill="none" stroke="' + c.eye + '" stroke-width="2"/>';
}

function body(c, o) {
  o = o || {};
  var shaft = o.shaft || c.shaft;
  var shaft2 = o.shaft2 || c.shaft2;
  var lens = o.earLens || c.lens;
  var lensCore = o.earCore || c.lensCore;
  var rim = o.rim || c.rim;
  var sealFill = o.sealFill || c.seal;
  var sealInk = o.sealInk || c.sealInk;
  var face = o.face ? o.face(c, o) : faceIdle(c, o);
  var decor = o.decor ? o.decor(c, o) : '';
  if (o.earsArcs) {
    decor += '<g fill="none" stroke="' + rim + '" stroke-width="3" stroke-linecap="round">' +
      '<path d="M13 20 C5 28 5 40 13 48" opacity=".9"/>' +
      '<path d="M165 8 C173 16 173 28 165 36" opacity=".9"/>' +
      '</g>';
  }
  var tilt = o.tilt || 0;

  var ring = o.ring
    ? '<circle cx="85" cy="171" r="14" fill="none" stroke="rgba(157,59,43,.22)" stroke-width="2"/>' +
      '<circle cx="85" cy="171" r="14" fill="none" stroke="#9C3B2B" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="38 50" transform="rotate(-90 85 171)"/>'
    : '';

  var inner =
    /* 悬浮飞溅 */
    '<g fill="' + c.splash + '">' +
      '<ellipse cx="42" cy="196" rx="16" ry="4.5" transform="rotate(-18 42 196)"/>' +
      '<ellipse cx="60" cy="203" rx="10" ry="3" transform="rotate(-8 60 203)"/>' +
      '<ellipse cx="30" cy="174" rx="9" ry="3" transform="rotate(-32 30 174)"/>' +
      '<ellipse cx="202" cy="128" rx="14" ry="4" transform="rotate(28 202 128)"/>' +
      '<ellipse cx="26" cy="203" rx="7" ry="2.6" transform="rotate(-24 26 203)"/>' +
      '<ellipse cx="214" cy="146" rx="9" ry="3.4" transform="rotate(44 214 146)"/>' +
    '</g>' +
    '<g fill="' + c.splash2 + '">' +
      '<ellipse cx="214" cy="148" rx="8" ry="3" transform="rotate(40 214 148)"/>' +
      '<ellipse cx="26" cy="210" rx="6" ry="2.4" transform="rotate(-12 26 210)"/>' +
    '</g>' +
    /* 双耳光柱 */
    taperShaft([88, 92], [28, 30], 11.5, 2.2, [lens, shaft, shaft2]) +
    taperShaft([126, 92], [152, 16], 9.5, 1.8, [lens, shaft, shaft2]) +
    /* 耳根透镜 */
    '<ellipse cx="76" cy="82" rx="12" ry="7" transform="rotate(-45 76 82)" fill="' + lens + '"/>' +
    '<ellipse cx="76" cy="82" rx="7" ry="4" transform="rotate(-45 76 82)" fill="' + lensCore + '"/>' +
    '<ellipse cx="134" cy="90" rx="10" ry="6" transform="rotate(-18 134 90)" fill="' + lens + '"/>' +
    '<ellipse cx="134" cy="90" rx="5.5" ry="3.2" transform="rotate(-18 134 90)" fill="' + lensCore + '"/>' +
    /* 机身 */
    '<ellipse cx="130" cy="142" rx="55" ry="47" fill="' + c.body + '" stroke="rgba(18,26,40,.10)" stroke-width="1"/>' +
    '<ellipse cx="148" cy="170" rx="34" ry="16" fill="' + c.bodySh + '" clip-path="url(#ballClip)"/>' +
    '<ellipse cx="108" cy="119" rx="18" ry="9" fill="' + c.bodyHi + '" transform="rotate(-22 108 119)"/>' +
    /* 耳根关节 */
    '<circle cx="89" cy="95" r="6.5" fill="' + c.joint + '"/>' +
    '<circle cx="126" cy="95" r="6" fill="' + c.joint + '"/>' +
    /* 面罩 */
    '<g transform="rotate(20 138 141)">' +
      '<ellipse cx="138" cy="141" rx="34" ry="35" fill="' + c.visor + '"/>' +
      '<ellipse cx="138" cy="141" rx="34" ry="35" fill="none" stroke="' + rim + '" stroke-width="5"/>' +
      '<ellipse cx="138" cy="141" rx="29" ry="30" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="1"/>' +
      face +
    '</g>' +
    /* 状态装饰（在面罩之外） */
    decor +
    /* 外挂点 → 朱砂「诺」印 */
    ring +
    '<rect x="78" y="164" width="14" height="14" rx="2.4" fill="' + sealFill + '"/>' +
    '<text x="85" y="175" text-anchor="middle" font-family="' + SERIF + '" font-size="9.5" font-weight="700" fill="' + sealInk + '">诺</text>' +
    /* 地面投影 */
    '<ellipse cx="130" cy="196" rx="34" ry="5" fill="' + c.shadow + '"/>';

  var wrap = tilt
    ? '<g transform="rotate(' + tilt + ' 130 142)">' + inner + '</g>'
    : inner;

  return '<defs><clipPath id="ballClip"><ellipse cx="130" cy="142" rx="55" ry="47"/></clipPath></defs>' + wrap;
}

function svg(w, h, label, inner) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + label + '">' +
    '<!-- 诺瓦 v4 · 原创构型；造型类别致敬《赛尔号》超能NoNo，细节与配色均非原设 -->' +
    inner + '</svg>';
}

/* 头像：脸形（透明底 + 深色面罩 + 主色竖眼 + 双耳尖）——与应用图标同一套语言，
   不再使用墨底方章：墨底在纸白主题里是一块突兀的黑砖。 */
function avatar(kind) {
  var ink = kind === 'offline' ? '#9AA3AF' : '#4C7FD0';
  var visor = kind === 'offline' ? '#39414D' : '#1A2230';
  var ears = '<path d="M30 38L20 6L26.5 8.5L34 34Z" fill="' + ink + '"/>' +
    '<path d="M66 38L76 6L69.5 8.5L62 34Z" fill="' + ink + '"/>';
  var eyes, extra = '';
  if (kind === 'listen') {
    eyes = '<rect x="38.5" y="42" width="6.5" height="25" rx="3.25" fill="' + ink + '"/>' +
      '<rect x="53" y="42" width="6.5" height="25" rx="3.25" fill="' + ink + '"/>';
    extra = '<path d="M13 40C7 46 7 58 13 64" fill="none" stroke="' + ink + '" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M83 40C89 46 89 58 83 64" fill="none" stroke="' + ink + '" stroke-width="3" stroke-linecap="round"/>';
  } else if (kind === 'offline') {
    eyes = '<rect x="38" y="53" width="8" height="4.5" rx="2.25" fill="' + ink + '"/>' +
      '<rect x="52.5" y="53" width="8" height="4.5" rx="2.25" fill="' + ink + '"/>';
  } else {
    eyes = '<rect x="39" y="46" width="6.5" height="19" rx="3.25" fill="' + ink + '"/>' +
      '<rect x="52.5" y="46" width="6.5" height="19" rx="3.25" fill="' + ink + '"/>';
  }
  return svg(96, 96, '诺瓦 v4 头像：脸形（透明底 + 深色面罩 + 主色竖眼 + 双耳尖）' + (kind ? '（' + kind + '）' : ''),
    ears + '<ellipse cx="48" cy="55" rx="24" ry="21" fill="' + visor + '"/>' + eyes + extra);
}

/* 应用图标（favicon）：产品「脸」的最小形 —— 暖纸底 + 深色面罩 + 琥珀竖眼 + 双耳尖。
   不沿用章式头像的墨底方章：章式头像用墨底是产品内的「印章」语言，
   而标签页与手机桌面图标在产品之外，墨底会变成一块认不出的小黑砖。 */
function favicon() {
  return svg(16, 16, '诺瓦 v4 应用图标：诺瓦的脸（纸白底 + 深色面罩 + 墨蓝竖眼 + 双耳尖）',
    '<rect x="0.45" y="0.45" width="15.1" height="15.1" rx="3" fill="#F5F6F8" stroke="#141922" stroke-width="0.9"/>' +
    '<path d="M4.7 6.4L3.2 1.9L5.2 2.35L6.2 5.7Z" fill="#4C7FD0"/>' +
    '<path d="M11.3 6.4L12.8 1.9L10.8 2.35L9.8 5.7Z" fill="#4C7FD0"/>' +
    '<ellipse cx="8" cy="9.3" rx="4.7" ry="4" fill="#1A2230"/>' +
    '<rect x="5.85" y="7.5" width="1.3" height="3.6" rx=".65" fill="#4C7FD0"/>' +
    '<rect x="8.85" y="7.5" width="1.3" height="3.6" rx=".65" fill="#4C7FD0"/>');
}

/* 状态装饰 */
function decorDone(c) {
  return '<g fill="' + c.eye + '">' +
    '<circle cx="92" cy="116" r="2.2"/><circle cx="196" cy="152" r="1.9"/>' +
    '<rect x="104" y="96" width="4.5" height="4.5" transform="rotate(22 106 98)"/>' +
    '<rect x="188" y="108" width="3.5" height="3.5" transform="rotate(-16 190 110)"/>' +
    '</g>' +
    '<g fill="' + c.splash + '"><ellipse cx="86" cy="204" rx="6" ry="2" transform="rotate(-14 86 204)"/></g>';
}
/* ⑥ 挽救：递出的纸条 */
function decorRescue(c) {
  return '<g transform="rotate(-15 64 180)">' +
    '<path d="M56 168 L74 166 L72 190 L58 192 Z" fill="' + c.paper + '" stroke="' + c.paperLine + '" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M62 170 L62 190 M66 169.4 L66 189.4" stroke="' + c.paperLine + '" stroke-width=".8" opacity=".45"/>' +
    '</g>';
}
/* ⑦ 提醒：耳尖闪线 */
function decorWarn(c) {
  return '<g stroke="#F1C97F" stroke-width="1.4" stroke-linecap="round" opacity=".9">' +
    '<path d="M34 28 L39 36"/><path d="M149 20 L146 27"/>' +
    '</g>';
}

const files = {
  'mascot-v4.svg': svg(240, 210, '诺瓦 v4：球形悬浮机器管家（琥珀涂装）', body(BLUE, {})),
  'mascot-v4-classic.svg': svg(240, 210, '诺瓦 v4：球形悬浮机器管家（原味涂装）', body(CLASSIC, {})),
  'mascot-v4-listen.svg': svg(240, 210, '诺瓦 v4：聆听态', body(BLUE, { eyeH: 1.28, earsArcs: true })),
  'mascot-v4-focus.svg': svg(240, 210, '诺瓦 v4：专注态（计时进行中）',
    body(BLUE, { earLens: 'rgba(157,59,43,.92)', earCore: 'rgba(201,112,95,.85)', rim: '#9C3B2B', ring: true })),
  'mascot-v4-calc.svg': svg(240, 210, '诺瓦 v4：计算中', body(BLUE, { face: faceCalc })),
  'mascot-v4-done.svg': svg(240, 210, '诺瓦 v4：达成', body(BLUE, { face: faceDone, decor: decorDone })),
  'mascot-v4-rescue.svg': svg(240, 210, '诺瓦 v4：挽救', body(BLUE, { face: faceRescue, decor: decorRescue, tilt: -7 })),
  'mascot-v4-warn.svg': svg(240, 210, '诺瓦 v4：提醒', body(WARN, { face: faceWarn, decor: decorWarn })),
  'mascot-v4-offline.svg': svg(240, 210, '诺瓦 v4：离线（本地兜底）', body(OFFLINE, { face: faceOffline })),
  'mascot-v4-unknown.svg': svg(240, 210, '诺瓦 v4：兜底（关键词未命中）', body(BLUE, { face: faceUnknown })),
  'avatar-v4.svg': avatar(''),
  'avatar-v4-listen.svg': avatar('listen'),
  'avatar-v4-offline.svg': avatar('offline'),
  'favicon-v4.svg': favicon()
};

fs.mkdirSync(OUT, { recursive: true });
Object.keys(files).forEach(function (name) {
  fs.writeFileSync(path.join(OUT, name), files[name], 'utf8');
  console.log('wrote assets/img/' + name + ' (' + files[name].length + ' bytes)');
});
