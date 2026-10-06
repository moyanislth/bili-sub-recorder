/*
 * B站字幕摘录 - 纯逻辑核心(无 DOM 依赖,Node 可 require,浏览器挂 window.BiliSubCore)
 * 注意:无论在哪种环境(Node module / 页面 / 隔离世界)都同时挂到全局,
 *       因为扩展注入链路对跨条目同文件不可靠,消费方可能需要动态 import 补载。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.BiliSubCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 字幕行匹配 ---------- */

  // 返回 from<=t<to 的字幕行(二分找最后一个 from<=t 的行再校验 to);没有则 null
  function findLineAt(lines, t) {
    if (!lines || !lines.length) return null;
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].from <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans === -1) return null;
    var line = lines[ans];
    return (t < line.to) ? line : null;
  }

  // 收集器:按 from 去重,保持追加顺序
  function createCollector() {
    var seen = Object.create(null);
    var collected = [];
    return {
      add: function (line) {
        if (!line || typeof line.from !== 'number' || seen[line.from]) return false;
        seen[line.from] = true;
        collected.push({ from: line.from, to: line.to, content: line.content == null ? '' : String(line.content) });
        return true;
      },
      lines: function () { return collected.slice(); },
      count: function () { return collected.length; },
      charCount: function () {
        var n = 0;
        for (var i = 0; i < collected.length; i++) n += collected[i].content.length;
        return n;
      }
    };
  }

  /* ---------- 快捷键 ---------- */

  // e:KeyboardEvent;hotkey:{alt,ctrl,shift,meta,key}。修饰键与按键都需精确一致
  function matchHotkey(e, hotkey) {
    if (!e || !hotkey || !hotkey.key) return false;
    var k = String(e.key || '').toLowerCase();
    var want = String(hotkey.key).toLowerCase();
    if (k !== want) return false;
    if (!!e.altKey !== !!hotkey.alt) return false;
    if (!!e.ctrlKey !== !!hotkey.ctrl) return false;
    if (!!e.metaKey !== !!hotkey.meta) return false;
    if (!!e.shiftKey !== !!hotkey.shift) return false;
    return true;
  }

  // 焦点在可输入控件上时不触发快捷键
  function isEditableTarget(e) {
    var t = e && e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  // 焦点在可输入控件上时:纯按键(含 Shift)属于打字,必须忽略;
  // 带 Ctrl/Alt/Meta 的组合键输入场景用不到,允许触发(否则编辑完语录后快捷键会"失灵")
  function hotkeyBlockedByEditable(e, hotkey) {
    if (!isEditableTarget(e)) return false;
    return !(hotkey && (hotkey.ctrl || hotkey.alt || hotkey.meta));
  }

  /* ---------- 字幕轨选择 ---------- */

  function isAiSubtitle(item) {
    if (!item) return false;
    if (item.ai_type != null && Number(item.ai_type) !== 0) return true;
    var lan = String(item.lan || '');
    return lan.indexOf('ai-') === 0;
  }

  // 优先人工 CC,其次 AI;跳过没有 subtitle_url 的项。返回 {item, source} 或 null
  function pickSubtitle(subtitles) {
    if (!subtitles || !subtitles.length) return null;
    var cc = null, ai = null;
    for (var i = 0; i < subtitles.length; i++) {
      var s = subtitles[i];
      if (!s || !s.subtitle_url) continue;
      if (isAiSubtitle(s)) { if (!ai) ai = s; }
      else if (!cc) cc = s;
    }
    if (cc) return { item: cc, source: 'cc' };
    if (ai) return { item: ai, source: 'ai' };
    return null;
  }

  // 播放器接口返回的 subtitle 列表在不同写法下位置不同,做防御式提取
  function extractSubtitleList(playerInfo) {
    var d = playerInfo && playerInfo.data ? playerInfo.data : playerInfo;
    var sub = d && d.subtitle;
    if (!sub) return [];
    if (Array.isArray(sub.subtitles)) return sub.subtitles;
    return [];
  }

  /* ---------- 文本格式化 ---------- */

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(s);
  }

  // lines:[{from,to,content}] → 展示/复制文本
  function formatRecordText(lines, withTimestamp) {
    if (!lines || !lines.length) return '';
    if (!withTimestamp) {
      var arr = [];
      for (var i = 0; i < lines.length; i++) arr.push(lines[i].content);
      return arr.join('\n');
    }
    var out = [];
    for (var j = 0; j < lines.length; j++) out.push('[' + fmtTime(lines[j].from) + '] ' + lines[j].content);
    return out.join('\n');
  }

  /* ---------- 记录存储 ---------- */

  var MAX_RECORDS = 500;

  // 新记录追加到尾部;超出上限删最旧。records 就地修改并返回
  function appendAndPrune(records, record, max) {
    if (!Array.isArray(records)) records = [];
    max = max || MAX_RECORDS;
    records.push(record);
    if (records.length > max) records = records.slice(records.length - max);
    return records;
  }

  // 按 startedAt 倒序展示用
  function sortForDisplay(records) {
    return (records || []).slice().sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
  }

  // 将编辑后的文本落回记录:找到 id 就地修改(text + textEdited 标记)并返回数组;找不到返回 null
  function applyEditedText(records, id, text) {
    if (!Array.isArray(records)) return null;
    for (var i = 0; i < records.length; i++) {
      if (records[i] && records[i].id === id) {
        records[i].text = String(text == null ? '' : text);
        records[i].textEdited = true;
        return records;
      }
    }
    return null;
  }

  // 记录的展示/复制文本:编辑过的用编辑后文本(用户文字为准),否则按当前时间戳设置生成
  function recordDisplayText(rec, withTimestamp) {
    if (!rec) return '';
    if (rec.textEdited && rec.text != null) return rec.text;
    return formatRecordText(rec.lines, withTimestamp);
  }

  /* ---------- 导入 / 导出(换电脑迁移) ---------- */

  var EXPORT_APP = 'bili-sub-recorder';

  // 构造导出文件内容(带 app 标识与版本号,便于日后格式迁移)
  function buildExport(records) {
    var list = Array.isArray(records) ? records : [];
    return JSON.stringify({
      app: EXPORT_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      count: list.length,
      records: list
    });
  }

  // 白名单式清洗单条导入记录:结构不合法返回 null
  function sanitizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (!Array.isArray(raw.lines)) return null;
    var lines = [];
    for (var i = 0; i < raw.lines.length; i++) {
      var l = raw.lines[i];
      if (!l || typeof l.from !== 'number' || typeof l.to !== 'number' || typeof l.content !== 'string') return null;
      lines.push({ from: l.from, to: l.to, content: l.content });
    }
    if (!lines.length) return null;
    return {
      id: raw.id,
      bvid: typeof raw.bvid === 'string' ? raw.bvid : '',
      cid: typeof raw.cid === 'number' ? raw.cid : null,
      title: typeof raw.title === 'string' ? raw.title : '',
      owner: typeof raw.owner === 'string' ? raw.owner : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : 0,
      lines: lines,
      text: typeof raw.text === 'string' ? raw.text : formatRecordText(lines, false),
      textEdited: !!raw.textEdited
    };
  }

  // 解析导入文件:接受本扩展导出的对象或纯记录数组;ok=false 时给 reason
  function parseImport(jsonText) {
    var data;
    try {
      data = JSON.parse(String(jsonText));
    } catch (e) {
      return { ok: false, reason: '不是有效的 JSON 文件' };
    }
    var rawList = null;
    if (Array.isArray(data)) {
      rawList = data;
    } else if (data && typeof data === 'object' && Array.isArray(data.records)) {
      if (data.app && data.app !== EXPORT_APP) return { ok: false, reason: '不是本扩展导出的文件' };
      rawList = data.records;
    }
    if (!rawList) return { ok: false, reason: '文件里没有记录' };
    var records = [];
    for (var i = 0; i < rawList.length; i++) {
      var r = sanitizeRecord(rawList[i]);
      if (r) records.push(r);
    }
    if (!records.length) return { ok: false, reason: '文件里没有有效记录' };
    return { ok: true, records: records };
  }

  // 合并:按 id 去重(重复导入同一文件是幂等的),按摘录时间排序,超出上限删最旧
  function mergeRecords(current, imported, max) {
    max = max || MAX_RECORDS;
    var seen = Object.create(null);
    var all = [];
    function push(r) {
      if (!r || seen[r.id]) return;
      seen[r.id] = true;
      all.push(r);
    }
    (Array.isArray(current) ? current : []).forEach(push);
    (Array.isArray(imported) ? imported : []).forEach(push);
    all.sort(function (a, b) { return (a.startedAt || 0) - (b.startedAt || 0); });
    if (all.length > max) all = all.slice(all.length - max);
    return all;
  }

  /* ---------- URL / cid 兜底 ---------- */

  // 从视频页 URL 解析 bvid(如 /video/BV1xx411c7mD?p=3)
  function bvidFromUrl(url) {
    var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url || '');
    return m ? m[1] : null;
  }

  // 从 URL 解析分P号(1-based,缺省 1)
  function pageIndexOfUrl(url) {
    var m = /[?&]p=(\d+)/.exec(url || '');
    return m ? parseInt(m[1], 10) : 1;
  }

  // pagelist 结果 + 页面 URL → 当前分P的 cid
  function cidFromPageList(pages, url) {
    if (!Array.isArray(pages) || !pages.length) return null;
    var p = pageIndexOfUrl(url);
    var item = pages[p - 1];
    return item && item.cid != null ? item.cid : null;
  }

  // 字幕地址协议补全(接口返回 //aisubtitle.hdslb.com/... 这种)
  function normalizeSubtitleUrl(u) {
    if (!u) return null;
    if (u.indexOf('//') === 0) return 'https:' + u;
    return u;
  }

  // 文档标题剥离站名后缀 → 视频标题(循环剥,处理 "..._哔哩哔哩_bilibili_xxx" 链式后缀)
  var SITE_SUFFIX_RE = /(?:_哔哩哔哩|[-–]\s*哔哩哔哩|_\s*bilibili|[-–]\s*bilibili|。bilibili)\S*$/i;
  function titleFromDocumentTitle(title) {
    if (!title) return '';
    var original = String(title).trim();
    var s = original, prev;
    for (;;) {
      prev = s;
      s = s.replace(SITE_SUFFIX_RE, '').trim();
      if (s === prev || !s) break;
    }
    return s || original;
  }

  /* ---------- 存储 ---------- */

  // localStorage 实现的 chrome.storage.local 兼容层(Promise 风格,非扩展环境/测试用)
  function localStorageShim() {
    return {
      get: function (keys) {
        return new Promise(function (resolve) {
          var out = {};
          var list = keys == null ? [] : (Array.isArray(keys) ? keys : [keys]);
          if (keys == null) {
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              out[k] = safeParse(localStorage.getItem(k));
            }
          } else {
            for (var j = 0; j < list.length; j++) {
              var key = list[j];
              var v = localStorage.getItem(key);
              out[key] = v == null ? null : safeParse(v);
            }
          }
          resolve(out);
        });
      },
      set: function (obj) {
        return new Promise(function (resolve) {
          for (var k in obj) localStorage.setItem(k, JSON.stringify(obj[k]));
          resolve();
        });
      },
      remove: function (key) {
        return new Promise(function (resolve) {
          var list = Array.isArray(key) ? key : [key];
          for (var i = 0; i < list.length; i++) localStorage.removeItem(list[i]);
          resolve();
        });
      },
      clear: function () {
        return new Promise(function (resolve) { localStorage.clear(); resolve(); });
      }
    };
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) { return s; }
  }

  // 选择存储后端:扩展环境用 chrome.storage.local,否则退回 localStorage
  function pickStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
    if (typeof localStorage !== 'undefined') return localStorageShim();
    return null;
  }

  // 复制文本:优先 Clipboard API,失败退回隐藏 textarea + execCommand
  // 用 window 级查找以便测试时替换;lastText 记录最近一次请求复制的文本
  function copyToClipboard(text) {
    copyToClipboard.lastText = text;
    var doc = typeof document !== 'undefined' ? document : null;
    function fallback() {
      if (!doc) return Promise.resolve(false);
      return new Promise(function (resolve) {
        try {
          var ta = doc.createElement('textarea');
          ta.value = text;
          ta.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0');
          doc.body.appendChild(ta);
          ta.focus(); ta.select();
          var ok = doc.execCommand && doc.execCommand('copy');
          doc.body.removeChild(ta);
          resolve(!!ok);
        } catch (e) { resolve(false); }
      });
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(fallback);
    }
    return fallback();
  }

  /* ---------- 快捷键文本显示 ---------- */

  function modifierOrder() { return [['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'], ['meta', 'Meta']]; }

  function hotkeyLabel(hotkey) {
    if (!hotkey || !hotkey.key) return '未设置';
    var parts = [];
    var order = modifierOrder();
    for (var i = 0; i < order.length; i++) {
      if (hotkey[order[i][0]]) parts.push(order[i][1]);
    }
    var key = String(hotkey.key);
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    return parts.join(' + ');
  }

  // 从 KeyboardEvent 构造 hotkey 配置(录制快捷键用)
  function hotkeyFromEvent(e) {
    var k = String(e.key || '');
    // 纯修饰键按下不算完整组合
    if (['Alt', 'Control', 'Shift', 'Meta', 'AltGraph'].indexOf(k) !== -1) return null;
    if (!k) return null;
    return {
      ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey,
      key: k.length === 1 ? k.toLowerCase() : k
    };
  }

  return {
    findLineAt: findLineAt,
    createCollector: createCollector,
    matchHotkey: matchHotkey,
    isEditableTarget: isEditableTarget,
    hotkeyBlockedByEditable: hotkeyBlockedByEditable,
    isAiSubtitle: isAiSubtitle,
    pickSubtitle: pickSubtitle,
    extractSubtitleList: extractSubtitleList,
    fmtTime: fmtTime,
    formatRecordText: formatRecordText,
    MAX_RECORDS: MAX_RECORDS,
    appendAndPrune: appendAndPrune,
    sortForDisplay: sortForDisplay,
    bvidFromUrl: bvidFromUrl,
    pageIndexOfUrl: pageIndexOfUrl,
    cidFromPageList: cidFromPageList,
    normalizeSubtitleUrl: normalizeSubtitleUrl,
    titleFromDocumentTitle: titleFromDocumentTitle,
    applyEditedText: applyEditedText,
    recordDisplayText: recordDisplayText,
    EXPORT_APP: EXPORT_APP,
    buildExport: buildExport,
    parseImport: parseImport,
    mergeRecords: mergeRecords,
    localStorageShim: localStorageShim,
    pickStorage: pickStorage,
    copyToClipboard: copyToClipboard,
    hotkeyLabel: hotkeyLabel,
    hotkeyFromEvent: hotkeyFromEvent
  };
});
