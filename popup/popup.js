/*
 * popup:历史记录列表(复制/删除/清空)+ 设置(快捷键录制、时间戳开关)
 */
(function () {
  'use strict';
  var Core = window.BiliSubCore;
  var KEY_RECORDS = 'bsr_records';
  var KEY_SETTINGS = 'bsr_settings';
  var DEFAULT_HOTKEY = { ctrl: false, alt: true, shift: false, meta: false, key: 'x' };

  var storage = Core.pickStorage();
  var settings = { hotkey: DEFAULT_HOTKEY, withTimestamp: false };
  var records = [];
  var recordingHotkey = false;

  var listEl = document.querySelector('.list');
  var countEl = document.querySelector('.count');
  var hotkeyBtn = document.querySelector('.hotkey-btn');
  var tsToggle = document.getElementById('ts-toggle');
  var clearBtn = document.querySelector('.clear-btn');
  var exportBtn = document.querySelector('.export-btn');
  var importBtn = document.querySelector('.import-btn');
  var importFile = document.getElementById('import-file');
  var statusEl = document.querySelector('.foot-status');

  var statusTimer = null;
  function flashStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { statusEl.textContent = ''; statusTimer = null; }, 5000);
  }

  // 导出:下载 JSON 文件(换电脑迁移)
  exportBtn.addEventListener('click', function () {
    if (!records.length) { flashStatus('还没有记录可导出'); return; }
    var json = Core.buildExport(records);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'bili-sub-recorder-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    flashStatus('已导出 ' + records.length + ' 条');
  });

  // 导入:选 JSON 文件 → 校验 → 按 id 去重合并
  importBtn.addEventListener('click', function () { importFile.click(); });
  importFile.addEventListener('change', function () {
    var file = importFile.files && importFile.files[0];
    importFile.value = ''; // 允许重复选择同一文件
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res = Core.parseImport(String(reader.result));
      if (!res.ok) { flashStatus('导入失败:' + res.reason); return; }
      storage.get(KEY_RECORDS).then(function (map) {
        var before = (map && map[KEY_RECORDS]) || [];
        var merged = Core.mergeRecords(before, res.records);
        var added = merged.length - before.length;
        var o = {}; o[KEY_RECORDS] = merged;
        return storage.set(o).then(function () {
          records = merged;
          render();
          flashStatus('解析 ' + res.records.length + ' 条,新增 ' + added + ' 条,现共 ' + merged.length + ' 条');
        });
      }).catch(function () { flashStatus('导入失败:存储读写异常'); });
    };
    reader.onerror = function () { flashStatus('导入失败:文件读取失败'); };
    reader.readAsText(file);
  });

  function render() {
    countEl.textContent = records.length ? records.length + ' 条记录' : '';
    hotkeyBtn.textContent = recordingHotkey ? '按下组合键…' : Core.hotkeyLabel(settings.hotkey);
    hotkeyBtn.classList.toggle('recording', recordingHotkey);
    tsToggle.checked = !!settings.withTimestamp;

    listEl.textContent = '';
    if (!records.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有记录。打开B站视频页,按快捷键摘一段吧。';
      listEl.appendChild(empty);
      return;
    }
    Core.sortForDisplay(records).forEach(function (rec) { listEl.appendChild(itemNode(rec)); });
  }

  // 记录的展示/复制文本:编辑过以用户文字为准,否则按当前时间戳设置生成
  function displayText(rec) {
    return Core.recordDisplayText(rec, settings.withTimestamp);
  }

  function itemNode(rec) {
    var item = document.createElement('div');
    item.className = 'item';
    item.setAttribute('data-id', rec.id);

    var top = document.createElement('div');
    top.className = 'item-top';
    var title = document.createElement('div');
    title.className = 'title';
    title.textContent = rec.title || rec.bvid || '未知视频';
    title.title = rec.title || '';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.setAttribute('data-act', 'del');
    del.setAttribute('data-id', rec.id);
    del.textContent = '删除';
    top.appendChild(title);
    top.appendChild(del);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [
      rec.owner || '',
      rec.startedAt ? fmtDate(rec.startedAt) : '',
      (rec.lines ? rec.lines.length : 0) + ' 句' + (rec.textEdited ? ' · 已编辑' : '')
    ].filter(Boolean).join(' · ');

    var text = document.createElement('textarea');
    text.className = 'text';
    text.spellcheck = false;
    text.setAttribute('data-id', rec.id);
    text.title = '可直接编辑,自动保存';
    text.value = displayText(rec);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-btn';
    copy.setAttribute('data-act', 'copy');
    copy.setAttribute('data-id', rec.id);
    copy.textContent = '复制';
    actions.appendChild(copy);

    item.appendChild(top);
    item.appendChild(meta);
    item.appendChild(text);
    item.appendChild(actions);
    return item;
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function findRecord(id) {
    for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
    return null;
  }

  listEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var rec = findRecord(btn.getAttribute('data-id'));
    if (!rec) return;
    if (btn.getAttribute('data-act') === 'copy') {
      Core.copyToClipboard(displayText(rec)).then(function (ok) {
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(function () { btn.textContent = '复制'; }, 1200);
      });
    } else if (btn.getAttribute('data-act') === 'del') {
      records = records.filter(function (r) { return r.id !== rec.id; });
      persistRecords();
      render();
    }
  });

  // 语录可直接编辑:输入后防抖落库(存储与内存记录同步)
  var editTimer = null;
  listEl.addEventListener('input', function (e) {
    var ta = e.target;
    if (!ta || ta.tagName !== 'TEXTAREA' || !ta.classList.contains('text')) return;
    var id = ta.getAttribute('data-id');
    if (!id) return;
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(function () {
      editTimer = null;
      var text = ta.value;
      var rec = findRecord(id);
      if (rec && rec.text === text && rec.textEdited) return;
      if (rec) { rec.text = text; rec.textEdited = true; }
      storage.get(KEY_RECORDS).then(function (map) {
        var list = (map && map[KEY_RECORDS]) || [];
        var updated = Core.applyEditedText(list, id, text);
        if (!updated) return;
        var o = {}; o[KEY_RECORDS] = updated;
        return storage.set(o);
      }).catch(function () {});
    }, 600);
  });

  clearBtn.addEventListener('click', function () {
    if (!records.length) return;
    if (!window.confirm('确定清空全部 ' + records.length + ' 条记录?')) return;
    records = [];
    persistRecords();
    render();
  });

  tsToggle.addEventListener('change', function () {
    settings.withTimestamp = tsToggle.checked;
    persistSettings();
    render();
  });

  hotkeyBtn.addEventListener('click', function () {
    recordingHotkey = !recordingHotkey;
    render();
  });

  document.addEventListener('keydown', function (e) {
    if (!recordingHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    var hk = Core.hotkeyFromEvent(e);
    if (hk) {
      settings.hotkey = hk;
      recordingHotkey = false;
      persistSettings();
    }
    render();
  }, true);

  function persistRecords() {
    var o = {}; o[KEY_RECORDS] = records;
    storage.set(o).catch(function () {});
  }
  function persistSettings() {
    var o = {}; o[KEY_SETTINGS] = settings;
    storage.set(o).catch(function () {});
  }

  storage.get([KEY_RECORDS, KEY_SETTINGS]).then(function (map) {
    var recs = map && map[KEY_RECORDS];
    records = Array.isArray(recs) ? recs : [];
    var s = map && map[KEY_SETTINGS];
    if (s && typeof s === 'object') {
      settings.withTimestamp = !!s.withTimestamp;
      if (s.hotkey && s.hotkey.key) settings.hotkey = s.hotkey;
    }
    render();
  }).catch(function () { render(); });
})();
