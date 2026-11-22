/* =========================================================
   诺瓦 Nova · GL 舞台引擎（全量重构 · WebGL + CSS3D 双渲染器）
   ---------------------------------------------------------
   架构（index.html 三层）：
     #gl      WebGLRenderer —— 氛围纸面 shader / 3D 页签卡 / 诺瓦形象 / 脉冲
     #css3d   CSS3DRenderer —— 对话气泡 / 工作台面板：真实 DOM 进入同一相机
              （富文本、ecard 数据卡、data-act 委托事件、读屏可达性全部保留）
     .app     固定 UI 层 —— 品牌 / 同步 / 输入台 / 漫画页框（工具级稳定件不进 3D）

   关键约定：透视相机对焦 z=0 平面时 1 世界单位 = 1 CSS 像素，
   WebGL 物体与 CSS3D 元素共用同一套尺寸语言。
   降级：WebGL 不可用或初始化异常 → html[data-3d="off"]，DOM 原样接管（零损失）。
   经典 script，挂载 window.ZX_GL。业务层（state/api/engine/flows）零依赖本文件。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var T = window.THREE;
  if (!T) { window.ZX_GL = null; return; }

  var root = document.documentElement;

  /* ---------- 状态 ---------- */
  var renderer, cssRenderer, camera, bgCam;
  var glScene, bgScene, cssScene;
  var clock = { t: 0, last: 0 };
  var W = 0, H = 0, dpr = 1;
  var ray = null, pointer = { x: 0, y: 0 }, pickables = [];
  var frameHooks = [];          /* 每帧回调（nav/mascot/stage 各自注册） */
  var running = false;
  var pulse = { v: 0, decay: 2.2 };

  /* ---------- 尺寸：相机对焦 z=0 → 1 unit = 1px ---------- */
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H);
    cssRenderer.setSize(W, H);
    camera.aspect = W / H;
    camera.position.z = (H / 2) / Math.tan((camera.fov / 2) * Math.PI / 180);
    camera.updateProjectionMatrix();
    bgCam.left = -W / 2; bgCam.right = W / 2; bgCam.top = H / 2; bgCam.bottom = -H / 2;
    bgCam.updateProjectionMatrix();
    if (ZX_GL.api.onResize) ZX_GL.api.onResize.forEach(function (fn) { try { fn(W, H); } catch (e) { } });
    /* 视口变化可能伴随 hidden→visible 抖动（旋转/分屏），恢复渲染循环，
       否则 CSS3D 矩阵停在上一次 compose（实测：主格停在被顶出视口的旧位） */
    if (root.classList.contains('gl-on')) resume();
  }

  /* ---------- 渲染循环 ---------- */
  function frame(now) {
    if (!running) return;
    if (!clock.last) clock.last = now;
    var dt = Math.min(0.05, (now - clock.last) / 1000);
    clock.last = now;
    if (api.motion()) clock.t += dt;

    renderer.autoClear = false;
    /* 帧循环永不自杀：RAF 在后台标签页自动节流，保活代价可忽略；
       hidden 时跳过渲染。此前 hidden 一帧即停循环，回到前台若
       visibilitychange 事件丢失，CSS3D 矩阵就永远停在上一次 compose
       （实测：旋转/缩放视口后主格停在屏外旧位，页签整行消失） */
    requestAnimationFrame(frame);
    if (document.hidden) return;
    pulse.v = api.motion() ? Math.max(0, pulse.v - dt * pulse.decay) : 0;
    var bgU = window.ZX_GL_BG && window.ZX_GL_BG.uniforms ? window.ZX_GL_BG.uniforms() : null;
    if (bgU) { bgU.uTime.value = clock.t; bgU.uPulse.value = pulse.v; }

    for (var i = 0; i < frameHooks.length; i++) {
      try { frameHooks[i](dt, clock.t); } catch (e) { /* 单个钩子异常不拖垮循环 */ }
    }

    renderer.clear();
    renderer.render(bgScene, bgCam);        /* 纸面 */
    renderer.clearDepth();
    renderer.render(glScene, camera);       /* 3D 物体 */
    try {
      cssRenderer.render(cssScene, camera); /* DOM 内容层 */
    } catch (e) {
      /* CSS3D 单帧异常不拖垮循环；一次性报警便于定位 */
      if (!frame._cssErr) { frame._cssErr = true; if (window.console && console.warn) console.warn('[zx] CSS3D 渲染异常：', e); }
    }
  }
  function resume() { if (!running) { running = true; clock.last = 0; requestAnimationFrame(frame); } }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && root.classList.contains('gl-on')) resume();
  });

  /* ---------- 指针与拾取 ---------- */
  function pick(e) {
    pointer.x = (e.clientX / W) * 2 - 1;
    pointer.y = -(e.clientY / H) * 2 + 1;
    ray.setFromCamera(pointer, camera);
    var hits = ray.intersectObjects(pickables, false);
    return hits.length ? hits[0].object : null;
  }
  function uiHit(e) {
    /* 命中真实 UI（输入台/弹层/链接）时 3D 拾取让位 */
    var t = e.target;
    return !!(t && t.closest && t.closest('#css3d .gl-ui,.composer,.ovl,a,button,input,.chips,.topbar'));
  }
  var hovered = null;
  window.addEventListener('pointermove', function (e) {
    if (!root.classList.contains('gl-on') || !ray) return;
    if (uiHit(e)) { setHover(null); return; }
    setHover(pick(e));
    if (ZX_GL.api.onPointer) ZX_GL.api.onPointer.forEach(function (fn) { fn(e.clientX, e.clientY); });
  }, { passive: true });
  window.addEventListener('click', function (e) {
    if (!root.classList.contains('gl-on') || !ray) return;
    if (uiHit(e)) return;
    var o = pick(e);
    if (o && o.userData.onClick) { e.preventDefault(); o.userData.onClick(o.userData.arg); }
  });
  function setHover(o) {
    if (hovered === o) return;
    if (hovered && hovered.userData.onHover) hovered.userData.onHover(false);
    hovered = o;
    if (o && o.userData.onHover) o.userData.onHover(true);
    document.body.style.cursor = o ? 'pointer' : '';
  }

  /* ---------- 对外 API ---------- */
  var api = {
    onResize: [], onPointer: [], onFrame: frameHooks,   /* 模块直 push 数组 */
    register: function (obj) { pickables.push(obj); },
    unregister: function (obj) {
      var i = pickables.indexOf(obj);
      if (i >= 0) pickables.splice(i, 1);
    },
    pulse: function (v) { pulse.v = Math.max(pulse.v, v === undefined ? 1 : v); },
    addBG: function (o) { bgScene.add(o); },
    addGL: function (o) { glScene.add(o); },
    addCSS: function (o) { cssScene.add(o); },
    size: function () { return { w: W, h: H }; },
    time: function () { return clock.t; },
    motion: function () { return root.dataset.motion !== 'off'; }
  };

  /* ---------- 初始化（失败即整体降级，不接管 DOM） ---------- */
  function init() {
    try {
      var canvas = document.getElementById('gl');
      var probe = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!probe) throw new Error('WebGL unavailable');

      renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0);
      cssRenderer = new window.ZX_CSS3D.CSS3DRenderer();
      var cssRoot = document.getElementById('css3d');
      cssRoot.appendChild(cssRenderer.domElement);
      cssRenderer.domElement.style.position = 'absolute';
      cssRenderer.domElement.style.inset = '0';

      camera = new T.PerspectiveCamera(50, 1, 1, 4000);
      bgScene = new T.Scene();
      bgScene.userData.uniforms = null;
      bgCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      bgCam.position.z = 5;
      glScene = new T.Scene();
      cssScene = new T.Scene();
      ray = new T.Raycaster();

      /* Toon/标准材质的灯光：主平行光 + 环境补光（Basic 材质的页签卡不受影响） */
      var sun = new T.DirectionalLight(0xffffff, 1.15);
      sun.position.set(0.5, 1, 0.8);
      glScene.add(sun);
      glScene.add(new T.AmbientLight(0x8FA0B8, 0.6));

      resize();
      window.addEventListener('resize', resize);

      /* 模块挂载：各自向 engine 注册场景物体与帧钩子（挂载失败仅缺该模块，不整体降级） */
      var mods = [ZX_GL_BG, ZX_GL_NAV, ZX_GL_MASCOT, ZX_GL_STAGE];
      for (var i = 0; i < mods.length; i++) {
        if (mods[i] && mods[i].mount) mods[i].mount(api);
      }

      root.classList.add('gl-on');
      root.classList.remove('gl-off');
      resize();
      resume();
      return true;
    } catch (e) {
      if (window.console && console.warn) console.warn('[zx] WebGL 舞台初始化失败，回退 DOM 模式：', e);
      running = false;
      window.removeEventListener('resize', resize);
      root.dataset.gl3d = 'off';
      root.classList.remove('gl-on');
      root.classList.add('gl-off');
      return false;
    }
  }

  window.ZX_GL_BG = window.ZX_GL_BG || null;
  window.ZX_GL_NAV = window.ZX_GL_NAV || null;
  window.ZX_GL_MASCOT = window.ZX_GL_MASCOT || null;
  window.ZX_GL_STAGE = window.ZX_GL_STAGE || null;

  window.ZX_GL = { init: init, api: api };
})(window.ZX);
