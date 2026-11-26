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
   降级：WebGL 不可用、初始化或渲染异常 → html[data-gl3d="off"]，DOM 原样接管（零损失）。
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
  var initialized = false;
  var initializing = false;
  var failed = false;
  var rafId = null;
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
    syncStage();
  }

  /* ---------- 渲染循环 ---------- */
  function stageAvailable() {
    var canvas = document.getElementById('gl');
    var css = document.getElementById('css3d');
    return !document.hidden && root.dataset.gl3d !== 'off' && !!canvas && !!css &&
      getComputedStyle(canvas).display !== 'none' && getComputedStyle(css).display !== 'none';
  }
  function stageVisible() {
    return stageAvailable() && root.classList.contains('gl-on');
  }
  function pause() {
    running = false;
    clock.last = 0;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function syncStage() {
    if (failed || root.dataset.gl3d === 'off') { pause(); return; }
    if (!initialized) {
      if (!initializing && stageAvailable()) init();
      return;
    }
    if (!stageVisible()) { pause(); return; }
    resume();
    if (window.ZX_GL_STAGE && window.ZX_GL_STAGE.refresh) window.ZX_GL_STAGE.refresh();
  }
  function handleResize() {
    if (initialized) resize();
    else syncStage();
  }
  window.addEventListener('resize', handleResize);

  function fallback(message, error) {
    if (window.console && console.warn) console.warn(message, error);
    failed = true;
    initialized = false;
    pause();
    window.removeEventListener('resize', handleResize);
    root.dataset.gl3d = 'off';
    root.classList.remove('gl-on');
    root.classList.add('gl-off');
  }
  function frame(now) {
    rafId = null;
    if (!running) return;
    if (document.hidden || !stageVisible()) { pause(); return; }
    if (!clock.last) clock.last = now;
    var dt = Math.min(0.05, (now - clock.last) / 1000);
    clock.last = now;
    if (api.motion()) clock.t += dt;

    pulse.v = api.motion() ? Math.max(0, pulse.v - dt * pulse.decay) : 0;
    var bgU = window.ZX_GL_BG && window.ZX_GL_BG.uniforms ? window.ZX_GL_BG.uniforms() : null;
    if (bgU) { bgU.uTime.value = clock.t; bgU.uPulse.value = pulse.v; }

    for (var i = 0; i < frameHooks.length; i++) {
      try { frameHooks[i](dt, clock.t); } catch (e) { /* 单个钩子异常不拖垮循环 */ }
    }

    try {
      renderer.clear();
      renderer.render(bgScene, bgCam);
      renderer.clearDepth();
      renderer.render(glScene, camera);
    } catch (e) {
      fallback('[zx] WebGL 渲染异常，回退 DOM 模式：', e);
      return;
    }
    try {
      cssRenderer.render(cssScene, camera);
    } catch (e) {
      fallback('[zx] CSS3D 渲染异常，回退 DOM 模式：', e);
      return;
    }
    rafId = requestAnimationFrame(frame);
  }
  function resume() {
    if (!running && stageVisible()) { running = true; clock.last = 0; rafId = requestAnimationFrame(frame); }
  }
  document.addEventListener('visibilitychange', syncStage);
  if (typeof MutationObserver === 'function') {
    new MutationObserver(syncStage).observe(root, { attributes: true, attributeFilter: ['class', 'data-tab', 'data-gl3d', 'style'] });
  }

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
    if (!root.classList.contains('gl-on') || !ray || getComputedStyle(document.getElementById('gl')).display === 'none') return;
    if (uiHit(e)) { setHover(null); return; }
    setHover(pick(e));
    if (ZX_GL.api.onPointer) ZX_GL.api.onPointer.forEach(function (fn) { fn(e.clientX, e.clientY); });
  }, { passive: true });
  window.addEventListener('click', function (e) {
    if (!root.classList.contains('gl-on') || !ray || getComputedStyle(document.getElementById('gl')).display === 'none') return;
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
    if (initialized || initializing) return initialized;
    if (failed || !stageAvailable()) return false;
    initializing = true;
    try {
      var canvas = document.getElementById('gl');
      var probe = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!probe) throw new Error('WebGL unavailable');

      renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        fallback('[zx] WebGL 上下文丢失，回退 DOM 模式：', e);
      });
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

      /* 模块挂载：各自向 engine 注册场景物体与帧钩子（挂载失败仅缺该模块，不整体降级） */
      var mods = [ZX_GL_BG, ZX_GL_NAV, ZX_GL_MASCOT, ZX_GL_STAGE];
      for (var i = 0; i < mods.length; i++) {
        if (mods[i] && mods[i].mount) mods[i].mount(api);
      }

      root.classList.add('gl-on');
      root.classList.remove('gl-off');
      initialized = true;
      initializing = false;
      resize();
      resume();
      return true;
    } catch (e) {
      initializing = false;
      fallback('[zx] WebGL 舞台初始化失败，回退 DOM 模式：', e);
      return false;
    }
  }

  window.ZX_GL_BG = window.ZX_GL_BG || null;
  window.ZX_GL_NAV = window.ZX_GL_NAV || null;
  window.ZX_GL_MASCOT = window.ZX_GL_MASCOT || null;
  window.ZX_GL_STAGE = window.ZX_GL_STAGE || null;

  window.ZX_GL = { init: init, api: api };
})(window.ZX);
