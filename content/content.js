/*
 * B站字幕摘录 - content script(isolated world)
 * 快捷键开始/停止 → 实时收集当前播放到的字幕行 → 浮窗预览/复制 → chrome.storage 入库
 */
(function () {
  'use strict';
  if (window.__bsrContentInjected) return;
  window.__bsrContentInjected = true;

  var Core = window.BiliSubCore || null; // 可能在启动时补载(见文件底部 boot 流程)
  var storage = null;
  var STORAGE_KEYS = { records: 'bsr_records', settings: 'bsr_settings' };
  var DEFAULT_HOTKEY = { ctrl: false, alt: true, shift: false, meta: false, key: 'x' };
  var POLL_MS = 300;
  var WATCH_MS = 800;

  var settings = { hotkey: DEFAULT_HOTKEY, withTimestamp: false };

  var state = {
    recording: false,
    collector: null,
    startedAt: 0,
    pollTimer: null,
    lines: null,          // 当前视频的字幕行 [{from,to,content}]
    sourceLabel: '',      // 'CC字幕' | 'AI字幕'
    recordMeta: null,     // 开始记录那一刻的 {bvid,cid,title,owner,url}
    lastRecord: null,
    lastUrl: location.href,
    lastPlayerInfo: null, // MAIN 钩子最近广播的 {cid, subtitles}(作 cid 兜底)
    playerInfoMap: {},    // cid → 字幕轨列表(多次广播取更全的一份)
    previewRecordId: null // 浮窗预览框当前展示的记录 id(避免覆盖用户编辑)
  };

  /* ================= UI ================= */

  var ui = null;

  function buildUI() {
    if (document.getElementById('bsr-float')) return;
    var root = document.createElement('div');
    root.id = 'bsr-float';
    root.setAttribute('data-state', 'idle');
    root.innerHTML =
      '<div class="bsr-pill" title="点击开始/停止摘录;快捷键可在扩展弹窗设置">' +
      '  <span class="bsr-dot"></span><span class="bsr-label">摘录</span>' +
      '</div>' +
      '<div class="bsr-panel" hidden>' +
      '  <div class="bsr-panel-head"></div>' +
      '  <textarea class="bsr-preview" spellcheck="false" title="可直接编辑,复制的是编辑后的内容"></textarea>' +
      '  <div class="bsr-actions">' +
      '    <button type="button" class="bsr-copy">复制全部</button>' +
      '    <button type="button" class="bsr-collapse">收起</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(root);
    ui = {
      root: root,
      pill: root.querySelector('.bsr-pill'),
      label: root.querySelector('.bsr-label'),
      panel: root.querySelector('.bsr-panel'),
      head: root.querySelector('.bsr-panel-head'),
      preview: root.querySelector('.bsr-preview'),
      copyBtn: root.querySelector('.bsr-copy'),
      collapseBtn: root.querySelector('.bsr-collapse')
    };
    ui.pill.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle();
    });
    ui.copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      copyLast();
    });
    ui.collapseBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      persistEditNow();
      hidePanel();
    });
    // 预览框可直接编辑;输入后防抖自动落库
    ui.preview.addEventListener('input', schedulePersistEdit);
    render();
  }

  var msgTimer = null;
  // 浮窗临时消息(不影响状态),kind: ''|'error'
  function flash(text, kind, ms) {
    if (!ui) return;
    // 消息期间也保持真实状态(比如开始失败后不能残留"记录中"的红圈)
    ui.root.setAttribute('data-state', state.recording ? 'rec' : 'idle');
    ui.label.textContent = text;
    ui.pill.classList.toggle('bsr-error', kind === 'error');
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(function () {
      msgTimer = null;
      ui.pill.classList.remove('bsr-error');
      render();
    }, ms || 3200);
  }

  function render() {
    if (!ui) return;
    if (msgTimer) return; // flash 显示中,别覆盖
    ui.root.setAttribute('data-state', state.recording ? 'rec' : 'idle');
    ui.panel.hidden = !state.lastRecord || state.recording;
    if (state.recording) {
      ui.label.textContent = '记录中 · ' + state.collector.count() + ' 句 · ' + state.collector.charCount() + ' 字';
    } else if (state.lastRecord) {
      ui.label.textContent = '已摘 ' + state.lastRecord.lines.length + ' 句';
    } else {
      ui.label.textContent = '摘录';
    }
    if (!ui.panel.hidden && state.lastRecord) {
      var rec = state.lastRecord;
      ui.head.textContent = (rec.title || '未知视频') + ' · ' + rec.lines.length + ' 句';
      // 仅在换成新记录时刷新预览,用户的手动编辑不被覆盖
      if (state.previewRecordId !== rec.id) {
        ui.preview.value = Core.formatRecordText(rec.lines, settings.withTimestamp);
        state.previewRecordId = rec.id;
      }
    }
  }

  function hidePanel() {
    if (!ui) return;
    state.lastRecord = null;
    ui.panel.hidden = true; // 直接隐藏,不等 render(flash 期间 render 会被跳过)
    render();
  }

  /* ================= 存储 ================= */

  function loadSettings() {
    return storage.get(STORAGE_KEYS.settings).then(function (map) {
      var s = map && map[STORAGE_KEYS.settings];
      if (s && typeof s === 'object') {
        settings.withTimestamp = !!s.withTimestamp;
        if (s.hotkey && s.hotkey.key) settings.hotkey = s.hotkey;
      }
    }).catch(function () {});
  }

  function saveSettings() {
    var o = {};
    o[STORAGE_KEYS.settings] = settings;
    return storage.set(o).catch(function () {});
  }

  function saveRecord(rec) {
    return storage.get(STORAGE_KEYS.records).then(function (map) {
      var list = (map && map[STORAGE_KEYS.records]) || [];
      list = Core.appendAndPrune(list, rec);
      var o = {}; o[STORAGE_KEYS.records] = list;
      return storage.set(o);
    }).catch(function () {});
  }

  /* ================= 视频元信息与字幕 ================= */

  function findVideo() {
    return document.querySelector('video');
  }

  function currentBvid() {
    return Core.bvidFromUrl(location.href);
  }

  // 拉当前视频的分P cid;失败时退回 MAIN 钩子捕获的 cid
  function ensureCid(bvid) {
    return fetch('https://api.bilibili.com/x/player/pagelist?bvid=' + encodeURIComponent(bvid), { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var cid = j && j.code === 0 ? Core.cidFromPageList(j.data, location.href) : null;
        if (cid) return cid;
        throw new Error('pagelist 无 cid');
      })
      .catch(function () {
        return state.lastPlayerInfo ? state.lastPlayerInfo.cid : null;
      });
  }

  // 尽力补全 UP 主/标题(view 接口,失败不影响主流程)
  function loadOwnerInfo(bvid, meta) {
    return fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code === 0 && j.data) {
          if (!meta.owner) meta.owner = (j.data.owner && j.data.owner.name) || '';
          if (!meta.title && j.data.title) meta.title = j.data.title;
        }
      })
      .catch(function () {});
  }

  function snapshotMeta(cid) {
    return {
      bvid: currentBvid() || '',
      cid: cid,
      title: Core.titleFromDocumentTitle(document.title),
      owner: '',
      url: location.href.split('#')[0]
    };
  }

  function loadSubtitleLines(cid, bvid) {
    var cached = state.playerInfoMap[cid];
    var useSubs = cached && cached.length ? cached : null; // 通道1:MAIN 钩子拦截
    var pickReady = useSubs
      ? Promise.resolve(useSubs)
      : fetch('https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid, { credentials: 'include' }) // 通道2:直接请求兜底
        .then(function (r) { return r.json(); })
        .then(function (j) { return Core.extractSubtitleList(j); })
        .catch(function () { return []; });

    return pickReady.then(function (subs) {
      var pick = Core.pickSubtitle(subs);
      if (!pick) return { lines: null, source: '', noSubtitle: true };
      var url = Core.normalizeSubtitleUrl(pick.item.subtitle_url);
      if (!url) return { lines: null, source: '', noSubtitle: true };
      return fetch(url).then(function (r) { return r.json(); }).then(function (body) {
        var lines = (body && Array.isArray(body.body) ? body.body : [])
          .map(function (l) { return { from: Number(l.from), to: Number(l.to), content: l.content == null ? '' : String(l.content) }; })
          .filter(function (l) { return isFinite(l.from) && isFinite(l.to); });
        return { lines: lines, source: pick.source === 'ai' ? 'AI字幕' : 'CC字幕', noSubtitle: false };
      });
    });
  }

  /* ================= 记录 ================= */

  function toggle() {
    if (state.recording) stopRecording('manual');
    else startRecording();
  }

  function startRecording() {
    if (state.recording) return;
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
    persistEditNow(); // 上一条若在浮窗里被编辑过,先落库
    var bvid = currentBvid();
    if (!bvid) { flash('这里不是视频页', 'error'); return; }
    var video = findVideo();
    if (!video) { flash('未找到播放器,稍后再试', 'error'); return; }
    if (ui) { ui.root.setAttribute('data-state', 'rec'); ui.label.textContent = '加载字幕…'; }
    ensureCid(bvid)
      .then(function (cid) {
        if (!cid) throw new Error('拿不到视频 cid');
        var meta = snapshotMeta(cid);
        state.recordMeta = meta;
        loadOwnerInfo(bvid, meta); // 异步补全,不阻塞
        return loadSubtitleLines(cid, bvid);
      })
      .then(function (r) {
        if (!state.recordMeta) return; // 期间已切换视频
        if (r.noSubtitle || !r.lines.length) {
          flash('该视频没有可用字幕(CC 无;AI 字幕需登录B站)', 'error', 6000);
          return;
        }
        state.lines = r.lines;
        state.sourceLabel = r.source;
        state.collector = Core.createCollector();
        state.startedAt = Date.now();
        state.recording = true;
        state.lastRecord = null;
        state.pollTimer = setInterval(pollTick, POLL_MS);
        pollTick();
        render();
      })
      .catch(function (err) {
        flash('字幕加载失败:' + (err && err.message ? err.message : err), 'error', 5000);
      });
  }

  function pollTick() {
    if (!state.recording) return;
    var video = findVideo();
    if (!video) { stopRecording('auto'); return; }
    var t = video.currentTime;
    var line = Core.findLineAt(state.lines, t);
    var changed = line ? state.collector.add(line) : false;
    if (changed) render();
  }

  function stopRecording(reason) {
    if (!state.recording) return;
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    state.recording = false;
    var lines = state.collector ? state.collector.lines() : [];
    var meta = state.recordMeta || snapshotMeta(null);
    if (!lines.length) {
      flash(reason === 'auto' ? '已切换视频,自动停止(未捕获到字幕)' : '这段时间没有捕获到字幕', 'error', 5000);
      render();
      return;
    }
    var rec = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      bvid: meta.bvid, cid: meta.cid,
      title: meta.title, owner: meta.owner,
      url: meta.url,
      startedAt: state.startedAt, endedAt: Date.now(),
      lines: lines,
      text: Core.formatRecordText(lines, settings.withTimestamp)
    };
    saveRecord(rec).then(function () {
      state.lastRecord = rec;
      if (reason === 'auto') flash('已切换视频,自动停止并保存 ' + lines.length + ' 句', '', 5000);
      render();
    });
  }

  /* ================= 编辑落库 ================= */

  var editTimer = null;

  function schedulePersistEdit() {
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(function () { editTimer = null; persistEditNow(); }, 600);
  }

  // 把浮窗预览的当前内容写回记录(历史记录与复制内容保持一致)
  function persistEditNow() {
    if (editTimer) { clearTimeout(editTimer); editTimer = null; }
    if (!ui || !state.lastRecord) return;
    var text = ui.preview.value;
    if (text === state.lastRecord.text) return; // 内容没变(含未编辑的初始值),不写库不标记
    state.lastRecord.text = text;
    state.lastRecord.textEdited = true;
    updateRecordText(state.lastRecord.id, text);
  }

  function updateRecordText(id, text) {
    storage.get(STORAGE_KEYS.records).then(function (map) {
      var list = (map && map[STORAGE_KEYS.records]) || [];
      var updated = Core.applyEditedText(list, id, text);
      if (!updated) return;
      var o = {};
      o[STORAGE_KEYS.records] = updated;
      return storage.set(o);
    }).catch(function () {});
  }

  function copyLast() {
    if (!state.lastRecord) return;
    var text = ui.preview.value;
    persistEditNow(); // 复制的内容与历史记录保持一致
    Core.copyToClipboard(text).then(function (ok) {
      flash(ok ? '已复制到剪贴板' : '复制失败,请在预览区手动选择', ok ? '' : 'error');
    });
  }

  /* ================= 快捷键 / SPA 监听(boot 中注册) ================= */

  function onNavigate() {
    persistEditNow();
    if (state.recording) stopRecording('auto');
    state.lines = null;
    state.sourceLabel = '';
    state.recordMeta = null;
    state.lastRecord = null;
    if (ui) render();
  }

  /* ================= 启动 ================= */

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function boot() {
    storage = Core.pickStorage();

    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      if (Core.hotkeyBlockedByEditable(e, settings.hotkey)) return;
      if (!Core.matchHotkey(e, settings.hotkey)) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }, true);

    setInterval(function () {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        onNavigate();
      }
    }, WATCH_MS);

    document.addEventListener('bsr:player-info', function (e) {
      try {
        var d = JSON.parse(e.detail);
        if (d && d.cid) {
          d.cid = Number(d.cid);
          state.lastPlayerInfo = d;
          var prev = state.playerInfoMap[d.cid];
          if (!prev || d.subtitles.length > prev.length) state.playerInfoMap[d.cid] = d.subtitles;
        }
      } catch (err) {}
    });

    whenReady(function () {
      buildUI();
      loadSettings().then(render);
    });
  }

  if (Core) {
    boot();
  } else {
    // manifest 已保证 core.js 与本文件同条目按序注入;若仍缺失(注入链路异常),给出可定位的错误。
    console.error('[B站字幕摘录] core.js 未注入(BiliSubCore 缺失),扩展未启动。请在 chrome://extensions 重新加载扩展。');
  }
})();
