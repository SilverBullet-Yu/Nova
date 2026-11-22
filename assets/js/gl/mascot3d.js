/* =========================================================
   诺瓦 Nova · GL 形象：精修立绘精灵（billboard）
   ---------------------------------------------------------
   质感层级裁决：低模 Toon 3D 与精修 2D 漫画 UI 存在不可弥合的质感差
   （试过：背壳描边/面罩收窄/竖椭圆眼——仍「不在一个层级」）。
   形象改用 IP 的既有精修资产 mascot-v4.svg 作纹理贴入 3D 场景
   （Sprite/billboard 标准手法）：形象质感与 UI 同源同级，
   3D 感由场景中的漂浮 / 呼吸 / 盖章弹跳 / 指针轻倾提供。
   动画档位沿用 IP 纪律：novaFloat 3.6s + novaBreathe 2.6s（低速小幅）+
   novaPop 0.55s 一次性盖章；只在对话页在场（stage.go 联动）。
   SVG 纹理异步加载，加载完成前占位隐藏。挂载 window.ZX_GL_MASCOT。
   经典 script。
   ========================================================= */
window.ZX_GL_MASCOT = (function () {
  'use strict';

  var T = window.THREE;
  var api = null;
  var nova = null;
  var pageVisible = document.documentElement.dataset.tab === 'chat';
  var pop = -1;                       /* 盖章弹跳起点时间；-1 = 空闲 */
  var look = { x: 0, y: 0 };
  var home = { x: 0, y: 0, scale: 1 }; /* 站位：主格左列，由 stage.layout 同源提供 */

  var W = 148, H = 130;               /* 与 DOM 版欢迎位同尺寸（msg-mascot 148×130） */

  function svgTexture(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var cv = document.createElement('canvas');
        cv.width = W * dpr * 2; cv.height = H * dpr * 2;   /* 2× 超采样：矢量源放大不出锯齿 */
        var ctx = cv.getContext('2d');
        ctx.scale(cv.width / W, cv.height / H);
        ctx.drawImage(img, 0, 0, W, H);
        var tex = new T.CanvasTexture(cv);
        tex.minFilter = T.LinearFilter;
        tex.colorSpace = T.SRGBColorSpace;
        resolve(tex);
      };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function build() {
    nova = new T.Group();
    nova.visible = false;
    api.addGL(nova);

    svgTexture('assets/img/mascot-v4.svg').then(function (tex) {
      if (!tex || !nova) return;
      var plane = new T.Mesh(
        new T.PlaneGeometry(W, H),
        new T.MeshBasicMaterial({ map: tex, transparent: true })
      );
      nova.add(plane);
      nova.position.set(home.x, home.y, 20);
      nova.scale.setScalar(home.scale);
      nova.visible = pageVisible && api.size().w >= 1280;
    });
  }

  function mount(engineApi) {
    api = engineApi;
    build();

    api.onPointer.push(function (x, y) {
      var s = api.size();
      look.x = (x / s.w - 0.5) * 2;
      look.y = (0.5 - y / s.h) * 2;
    });

    /* 消息发送 → 盖章弹跳（main.js playSeal 链路调用） */
    window.ZX_GL_MASCOT.stamp = function () {
      if (!api.motion()) return;
      pop = api.time();
      api.pulse(0.7);
    };
    /* 诺瓦只在对话页在场（stage.go 联动显隐） */
    window.ZX_GL_MASCOT.show = function (v) {
      pageVisible = !!v;
      nova.visible = pageVisible && api.size().w >= 1280 && nova.children.length > 0;
    };
    /* 站位由 stage.layout 同源提供：骑主格左缘（sprite 半身在格外可见——
       格内区域被 CSS3D 白底覆盖，WebGL 物体只能探在格缘外，层级铁律） */
    window.ZX_GL_MASCOT.setFrame = function (frameW, w, h, bandTop) {
      var frameTop = h / 2 - bandTop;
      home.x = -(frameW / 2 + 40);   /* 探进格来 2/3：中心在缘外 40，右 2/3 身位越过格缘
                                        被 CSS3D 白底裁掉 =「诺瓦从格边探进来」（破格） */
      home.y = frameTop - 130;
      home.scale = 1;
      nova.visible = pageVisible && w >= 1280 && nova.children.length > 0;
    };

    api.onFrame.push(function (dt) {
      if (!nova.visible) return;
      if (!api.motion()) {
        nova.position.x = home.x;
        nova.position.y = home.y;
        nova.scale.setScalar(home.scale);
        nova.rotation.z = 0;
        pop = -1;
        return;
      }
      var t = api.time();
      /* 常驻：漂浮 novaFloat 3.6s + 呼吸 novaBreathe 2.6s（IP 灵动同档） */
      var breathe = 1 + Math.sin(t * (Math.PI * 2 / 2.6)) * 0.03;
      nova.position.y = home.y + Math.sin(t * (Math.PI * 2 / 3.6)) * 3;
      nova.position.x = home.x + Math.cos(t * (Math.PI * 2 / 5.2)) * 2;
      nova.scale.setScalar(home.scale * breathe);
      /* 指针轻倾：整体 ±0.05 rad（关切不夸张；低模时代的局部眼动已弃） */
      nova.rotation.z = -look.x * 0.05;
      /* 盖章：novaPop 曲线（0→1.14→0.95→1），0.55s 一次性 */
      if (pop >= 0) {
        var k = (t - pop) / 0.55;
        if (k >= 1) { pop = -1; nova.scale.setScalar(home.scale * breathe); }
        else {
          var s = k < 0.55 ? 0.5 + (k / 0.55) * 0.64 : 1.14 - ((k - 0.55) / 0.45) * 0.19;
          nova.scale.setScalar(home.scale * s * breathe);
        }
      }
    });
  }

  return { mount: mount };
})();
