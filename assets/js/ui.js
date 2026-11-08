/* =========================================================
   诺瓦 Nova · 共享 UI 原语（弹层 / 确认 / 轻提示）
   ---------------------------------------------------------
   经典 script，挂载到 ZX.ui。无第三方依赖，支持 file://。
   用法见 docs/FRONTEND-CONTRACT.md 第 3 节。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var current = null;
  var lastFocus = null;

  function node(html) {
    var d = document.createElement('div');
    d.innerHTML = String(html || '').trim();
    return d.firstElementChild;
  }

  function focusables(root) {
    return Array.prototype.slice.call(root.querySelectorAll(
      'button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return el.offsetParent !== null; });
  }

  function onKey(e) {
    if (!current) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      current.close();
      return;
    }
    if (e.key !== 'Tab') return;
    var list = focusables(current.root);
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  function close(result) {
    if (!current) return;
    var c = current;
    current = null;
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('no-scroll');
    c.root.classList.add('out');
    var done = function () {
      if (c.root.parentNode) c.root.parentNode.removeChild(c.root);
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
      if (c.onClose) c.onClose(result);
    };
    setTimeout(done, 170);
  }

  /**
   * 打开一个居中弹层（≤860px 时变为底部抽屉）
   * @returns {{root:Element,$:Function,close:Function,setBody:Function,setFooter:Function}}
   */
  function sheet(opts) {
    var o = opts || {};
    if (current) close();
    lastFocus = document.activeElement;

    var root = node(
      '<div class="ovl" role="dialog" aria-modal="true" aria-label="' + U.esc(o.title || '对话框') + '">' +
        '<div class="ovl-bg" data-close="1"></div>' +
        '<section class="sheet' + (o.wide ? ' wide' : '') + '">' +
          '<header class="sheet-h">' +
            '<div class="sheet-hd">' +
              (o.eyebrow ? '<div class="sheet-eyebrow">' + U.esc(o.eyebrow) + '</div>' : '') +
              '<h2>' + U.esc(o.title || '') + '</h2>' +
              (o.sub ? '<p>' + U.esc(o.sub) + '</p>' : '') +
            '</div>' +
            '<button class="sheet-x" data-close="1" aria-label="关闭">×</button>' +
          '</header>' +
          '<div class="sheet-b">' + (o.body || '') + '</div>' +
          (o.footer ? '<footer class="sheet-f">' + o.footer + '</footer>' : '') +
        '</section>' +
      '</div>'
    );

    document.body.appendChild(root);
    document.documentElement.classList.add('no-scroll');
    document.addEventListener('keydown', onKey);

    root.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('[data-close]')) close();
    });

    function $(sel) { return root.querySelector(sel); }
    function setBody(html) {
      var b = $('.sheet-b');
      if (b) b.innerHTML = html;
    }
    function setFooter(html) {
      var s = $('.sheet');
      var f = $('.sheet-f');
      if (html) {
        if (!f) { f = node('<footer class="sheet-f"></footer>'); s.appendChild(f); }
        f.innerHTML = html;
      } else if (f) {
        f.parentNode.removeChild(f);
      }
    }

    current = { root: root, close: close, onClose: o.onClose, $: $ };
    setTimeout(function () {
      var target = root.querySelector('[autofocus]') || focusables(root)[0];
      if (target) { try { target.focus(); } catch (e) {} }
    }, 40);

    return { root: root, $: $, close: close, setBody: setBody, setFooter: setFooter };
  }

  /** 二次确认，返回 Promise<boolean> */
  function confirm(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      var s = sheet({
        eyebrow: o.eyebrow || '确认',
        title: o.title || '确认操作',
        sub: o.text || '',
        body: o.body || '',
        footer: '<button class="btn ghost" data-no>取消</button>' +
                '<button class="btn ' + (o.danger ? 'danger' : 'pri') + '" data-yes>' + U.esc(o.okText || '确定') + '</button>',
        onClose: function () { if (!settled) { settled = true; resolve(false); } }
      });
      s.$('[data-no]').addEventListener('click', function () { settled = true; s.close(); resolve(false); });
      s.$('[data-yes]').addEventListener('click', function () { settled = true; s.close(); resolve(true); });
    });
  }

  var FOLD_KEY = 'zx.folds';

  /** 读取本机折叠偏好：只保留展开（true）的键 */
  function loadFolds() {
    var out = {};
    try {
      var raw = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {};
      Object.keys(raw).forEach(function (k) { if (raw[k] === true) out[k] = true; });
    } catch (e) { /* 隐私模式禁用存储时按默认收起 */ }
    return out;
  }

  /** 写回折叠偏好；关闭的键直接丢弃，保持存储最小 */
  function saveFolds(map) {
    try {
      var out = {};
      var m = map || {};
      Object.keys(m).forEach(function (k) { if (m[k] === true) out[k] = true; });
      localStorage.setItem(FOLD_KEY, JSON.stringify(out));
    } catch (e) { /* 忽略写入失败 */ }
  }

  /**
   * 可折叠区：默认收起，展开态记在 ZX.state.folds[key]，并持久化到 localStorage
   * @param {string} key 唯一键（视图前缀，如 'plan:items'）
   * @param {{title:string, meta?:string, body:string}} opts
   */
  function fold(key, opts) {
    var o = opts || {};
    if (ZX.state) ZX.state.folds = ZX.state.folds || loadFolds();
    var st = (ZX.state && ZX.state.folds) || loadFolds();
    var open = !!st[key];
    return '<section class="fold' + (open ? ' open' : '') + '">' +
      '<button type="button" class="fold-h" data-act="fold" data-key="' + U.esc(key) + '"' +
        ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="fold-i" aria-hidden="true"></span>' +
        '<span class="fold-t">' + U.esc(o.title || '') + '</span>' +
        (o.meta ? '<span class="fold-m">' + o.meta + '</span>' : '') +
      '</button>' +
      '<div class="fold-b"' + (open ? '' : ' hidden') + '>' + (o.body || '') + '</div>' +
    '</section>';
  }

  /* ---------- 弹层头/焦点助手（goal / rescue 等多步 flow 共用） ---------- */

  /** 重绘弹层头三行文案（eyebrow / 标题 / 副标题） */
  function setHead(api, eyebrow, title, sub) {
    if (!api) return;
    var h = api.root.querySelector('.sheet-h');
    if (!h) return;
    var e = h.querySelector('.sheet-eyebrow');
    if (e) e.textContent = eyebrow;
    var t = h.querySelector('h2');
    if (t) t.textContent = title;
    var p = h.querySelector('p');
    if (p) p.textContent = sub;
  }

  /**
   * 重绘前记忆焦点：attr 为该 flow 的委托属性名（goal 用 'sa'，rescue 用 'sb'）。
   * 返回 { act, key }，key 取 data-v 或 data-id（哪边有值取哪边）。
   */
  function recallFocus(api, attr) {
    var el = document.activeElement;
    if (!el || !api || !api.root.contains(el) || !el.dataset) return null;
    if (!el.dataset[attr]) return null;
    return { act: el.dataset[attr], key: el.dataset.v || el.dataset.id || '' };
  }

  /** 重绘后把焦点放回原控件；找不到或已失效时落到弹层内首个可用控件 */
  function restoreFocus(api, attr, keep) {
    if (!api) return;
    var root = api.root;
    if (keep) {
      var list = root.querySelectorAll('[data-' + attr + '="' + keep.act + '"]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var k = el.dataset.v || el.dataset.id || '';
        if (k === keep.key && !el.disabled) { try { el.focus(); return; } catch (e) { /* 忽略 */ } }
      }
    }
    if (root.contains(document.activeElement)) return;
    var first = root.querySelector('.sheet-b button:not([disabled]),.sheet-b input:not([disabled])') ||
      root.querySelector('.sheet-f .btn.pri:not([disabled])') ||
      root.querySelector('.sheet-f button:not([disabled])');
    if (first) { try { first.focus(); } catch (e2) { /* 忽略 */ } }
  }

  /** 轻提示（role=status 供读屏播报；多条同现时向上错开，避免完全重叠） */
  function toast(text, kind) {
    var prev = document.querySelectorAll('.toast:not(.out)').length;
    var t = node('<div class="toast ' + (kind || '') + '" role="status">' + U.esc(text) + '</div>');
    if (prev) t.style.marginBottom = (prev * 46) + 'px';
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 2200);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }

  /**
   * 数字滚动：把元素上的数值平滑补间到新值
   * 首次调用（无 dataset.num）直接落值，不产生无意义动画；
   * 动效关闭或数值非法时同同步落值。fmt 负责拼单位（如 'R ' + v.toFixed(2)）。
   */
  function countTo(el, to, fmt, dur) {
    if (!el) return;
    var f = typeof fmt === 'function' ? fmt : function (v) { return String(Math.round(v)); };
    var end = Number(to);
    if (!isFinite(end)) return;
    var from = Number(el.dataset.num);
    if (!isFinite(from)) from = end;
    var done = function () { el.textContent = f(end); el.dataset.num = String(end); };
    if (from === end || !U.prefs().motion || typeof requestAnimationFrame !== 'function') { done(); return; }
    var token = (el._ct || 0) + 1;
    el._ct = token;
    var t0 = 0;
    var D = dur || 420;
    function frame(now) {
      if (el._ct !== token) return;
      if (!t0) t0 = now;
      var t = Math.min(1, (now - t0) / D);
      var e = 1 - Math.pow(1 - t, 3);
      el.textContent = f(from + (end - from) * e);
      if (t < 1) requestAnimationFrame(frame);
      else done();
    }
    requestAnimationFrame(frame);
  }

  ZX.ui = {
    sheet: sheet, confirm: confirm, toast: toast, close: close,
    setHead: setHead, recallFocus: recallFocus, restoreFocus: restoreFocus,
    fold: fold, loadFolds: loadFolds, saveFolds: saveFolds, countTo: countTo
  };
})(window.ZX);
