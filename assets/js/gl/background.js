/* =========================================================
   诺瓦 Nova · GL 氛围层：纸面 shader（WebGL 全屏底层）
   ---------------------------------------------------------
   替代 CSS 版 body::before 网点 / body::after 纤维，升级为：
   · 网点缓慢漂移呼吸（原静态 24px 阵）
   · 纸面对角光斑低速摆动（纸面在呼吸）
   · 集中线脉冲：切页 / 发送消息时从页签区放射（漫画集中线语言）
   开关：html[data-grid]/html[data-glow] 照常生效（MutationObserver 联动）。
   挂载 window.ZX_GL_BG，经 engine.mount 接入。经典 script。
   ========================================================= */
window.ZX_GL_BG = (function () {
  'use strict';

  if (!window.THREE) return null;
  var uniforms = null;
  /* Summer Checkin 氛围：深色玻璃底 + 薄荷青呼吸点 */
  var paper = new THREE.Color('#07130D');
  var ink = new THREE.Color('#8FE3CF');

  var FRAG = [
    'precision highp float;',
    'uniform vec2 uRes;', 'uniform float uTime;', 'uniform float uPulse;',
    'uniform float uDotA;', 'uniform float uGlow;',
    'uniform vec3 uPaper;', 'uniform vec3 uInk;',
    'varying vec2 vUv;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'void main(){',
    '  vec2 px = vUv * uRes;',
    '  vec2 top = vec2(uRes.x * 0.5, 0.0);',
    /* 纸底：上下 3% 明度呼吸 */
    '  vec3 c = uPaper * (1.0 + 0.015 * sin(uTime * 0.12 + vUv.y * 3.0));',
    /* 对角光斑 → 双侧氛围光斑：左上薰衣草加亮、右下微收（与 DOM 版 body 背景同构，纸面在呼吸） */
    '  vec2 lp1 = vec2(uRes.x * 0.08, uRes.y * 0.94);',
    '  c += vec3(0.055, 0.030, 0.10) * (1.0 - smoothstep(0.0, uRes.x * 0.5, length(px - lp1)));',
    '  vec2 lp2 = vec2(uRes.x * 0.94, uRes.y * 0.10);',
    '  c -= vec3(0.012, 0.018, 0.004) * (1.0 - smoothstep(0.0, uRes.x * 0.5, length(px - lp2)));',
    /* 黏土软点：26px 阵、缓慢漂移；底部 14% 渐隐（原 CSS mask 语义） */
    '  vec2 gp = px + vec2(sin(uTime * 0.15) * 1.5, cos(uTime * 0.11) * 1.5);',
    '  vec2 cell = mod(gp, 26.0) - 13.0;',
    '  float dotm = (1.0 - smoothstep(0.9, 1.3, length(cell))) * uDotA;',
    '  float fade = smoothstep(1.0, 0.86, vUv.y);',
    '  c = mix(c, uInk, dotm * 0.14 * fade);',
    /* 纸纤维：横向 1px 纹，行间 hash 差异 */
    '  float fy = floor(px.y / 4.0);',
    '  float fibre = step(0.78, hash(vec2(fy, floor(uTime * 0.0)))) * (1.0 - fract(px.y / 4.0)) * uGlow;',
    '  c = mix(c, uInk, fibre * 0.05);',
    /* 集中线脉冲：锚点页签区上缘，90 条放射线，距离衰减 */
    '  vec2 pa = px - top;',
    '  float ang = atan(pa.y, pa.x);',
    '  float radial = length(pa) / max(uRes.x, uRes.y * 1.2);',
    '  float stripes = step(0.5, fract(ang / 6.2831853 * 90.0 + uTime * 0.05));',
    '  float beam = stripes * smoothstep(0.06, 0.22, radial) * (1.0 - smoothstep(0.22, 0.55, radial));',
    '  c = mix(c, uInk, beam * uPulse * 0.16);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

  function syncSwitches() {
    var r = document.documentElement;
    uniforms.uDotA.value = r.dataset.grid === 'off' ? 0 : 1;
    uniforms.uGlow.value = r.dataset.glow === 'off' ? 0 : 1;
  }

  function mount(api) {
    uniforms = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uDotA: { value: 1 },
      uGlow: { value: 1 },
      uPaper: { value: paper },
      uInk: { value: ink }
    };
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms, vertexShader: VERT, fragmentShader: FRAG, depthWrite: false
    });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.position.z = 0;
    bgSceneProxy(api, mesh);
    syncSwitches();
    new MutationObserver(syncSwitches)
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-grid', 'data-glow'] });
  }

  /* bgScene 由 engine 私有——resize 时同步 quad 尺寸与 uRes（与漫画页框内沿对齐：body padding 10 + border 2） */
  function bgSceneProxy(api, mesh) {
    api.onResize.push(function (w, h) {
      mesh.scale.set(w - 24, h - 24, 1);
      uniforms.uRes.value.set(w - 24, h - 24);
    });
    api.addBG(mesh);
  }

  return { mount: mount, uniforms: function () { return uniforms; } };
})();
