/*
 * MAIN world 钩子(必须在页面脚本之前运行):
 * 拦截播放器自己发出的 /x/player/(wbi/)?v2 响应 → 拿到当前 cid 和字幕轨列表,
 * 通过 CustomEvent 广播给 isolated world 的 content.js(wbi 签名由页面自己完成,这是最稳的字幕来源)。
 * 自包含实现,不依赖 core.js(MAIN world 的注入与隔离世界互不可见,不引入跨世界耦合)。
 * 全程防御式,不改变页面行为。
 */
(function () {
  'use strict';
  if (window.__bsrHookInstalled) return;
  window.__bsrHookInstalled = true;

  var PLAYER_RE = /\/x\/player\/(wbi\/)?v2/;

  function extractSubtitles(json) {
    try {
      var d = json && json.data ? json.data : json;
      var s = d && d.subtitle;
      return s && Array.isArray(s.subtitles) ? s.subtitles : [];
    } catch (e) { return []; }
  }

  function extractCid(url, json) {
    var m = /[?&]cid=(\d+)/.exec(String(url || ''));
    if (m) return Number(m[1]);
    var d = json && json.data ? json.data : json;
    return d && d.cid != null ? Number(d.cid) : null;
  }

  function broadcast(json, url) {
    try {
      var cid = extractCid(url, json);
      if (!cid) return;
      var subtitles = extractSubtitles(json);
      window.__bsrPlayerInfo = { cid: cid, subtitles: subtitles, ts: Date.now() };
      document.dispatchEvent(new CustomEvent('bsr:player-info', {
        detail: JSON.stringify({ cid: cid, subtitles: subtitles })
      }));
    } catch (e) { /* 钩子绝不影响页面 */ }
  }

  /* ---- fetch 拦截 ---- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (PLAYER_RE.test(url)) {
          p.then(function (res) {
            try { res.clone().json().then(function (j) { broadcast(j, url); }).catch(function () {}); } catch (e) {}
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  /* ---- XHR 拦截 ---- */
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__bsrUrl = String(url || ''); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      if (xhr.__bsrUrl && PLAYER_RE.test(xhr.__bsrUrl)) {
        xhr.addEventListener('load', function () {
          try { broadcast(JSON.parse(xhr.responseText), xhr.__bsrUrl); } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();
