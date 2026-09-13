/**
 * 侧边栏:视频学习主界面
 *
 * 四个视图:
 * - 字幕:共享缓存的双语字幕(双语/中文/原文切换),点击句子跳回视频对应位置;
 *   配音进行中接收 DUB_PROGRESS,自动高亮当前句并滚动跟随
 * - 概览:AI 章节 + 关键引述(与翻译同 provider,缓存 oview:{videoKey}),点击时间戳跳转
 * - 笔记:观看中捕捉的时间戳笔记,点时间戳跳回视频,可删除
 * - 草稿导出:Markdown 草稿生成/编辑(防抖自动保存)/导出 Obsidian
 *
 * 当前视频识别:轮询活动标签页 URL(YouTube watch/shorts、B 站 video 页,含分 P)。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let currentKey = null;   // 当前视频 videoKey
  let currentTabId = null; // 当前标签页 id(跳转用)
  let currentCues = [];    // 当前视频字幕(字幕视图渲染 + 联动高亮)
  let subsMode = 'both';   // both | zh | en
  let saveTimer = null;    // 草稿自动保存防抖
  let dirty = false;       // 草稿被用户编辑过(重新生成前提示)
  let lastHlIdx = -1;      // 上次高亮的字幕行(避免重复滚动)

  /* ---------------- 当前视频识别 ---------------- */

  function videoKeyFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'www.youtube.com') {
        if (u.pathname.indexOf('/shorts/') === 0) {
          const id = u.pathname.split('/')[2];
          return id ? 'yt:' + id : null;
        }
        const v = u.searchParams.get('v');
        return v ? 'yt:' + v : null;
      }
      if (u.hostname === 'www.bilibili.com') {
        const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
        if (!m) return null;
        const p = parseInt(u.searchParams.get('p') || '1', 10) || 1;
        return `bili:${m[1]}:p${p}`;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  async function detectCurrentVideo() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    currentTabId = (tab && tab.id) || null;
    return tab && tab.url ? videoKeyFromUrl(tab.url) : null;
  }

  /** 通知 content script 跳转到指定时间并继续播放 */
  function seekTo(ts) {
    if (currentTabId == null || typeof ts !== 'number') return;
    chrome.tabs.sendMessage(currentTabId, { type: 'VDC_SEEK', ts }).catch(() => {});
  }

  /* ---------------- 视图切换 ---------------- */

  document.querySelectorAll('nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b === btn));
      document.querySelectorAll('section').forEach((s) => {
        s.classList.toggle('on', s.id === 'tab-' + btn.dataset.tab);
      });
    });
  });

  /* ---------------- 字幕视图 ---------------- */

  document.querySelectorAll('.modes button').forEach((btn) => {
    btn.addEventListener('click', () => {
      subsMode = btn.dataset.mode;
      document.querySelectorAll('.modes button')
        .forEach((b) => b.classList.toggle('on', b === btn));
      renderCues();
    });
  });

  function renderCues() {
    const wrap = $('cues');
    wrap.innerHTML = '';
    lastHlIdx = -1;
    if (!currentCues.length) {
      wrap.innerHTML = '<div class="empty">暂无字幕缓存——开一次配音后,字幕(含中文译文)会出现在这里</div>';
      return;
    }
    currentCues.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = 'cue';
      div.dataset.idx = String(i);
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = VdcNotes.fmtTime(c.start);
      div.appendChild(t);
      const zh = c.zh || '';
      const en = c.text || '';
      const main = document.createElement('span');
      // 双语:中文为主+原文小字;中文:仅中文(无译文回退原文);原文:仅原文
      if (subsMode === 'en' || (subsMode === 'zh' && !zh)) {
        main.textContent = en;
      } else {
        main.textContent = zh || en;
      }
      div.appendChild(main);
      if (subsMode === 'both' && zh && en && zh !== en) {
        const sub = document.createElement('span');
        sub.className = 'en';
        sub.textContent = en;
        div.appendChild(sub);
      }
      div.addEventListener('click', () => seekTo(c.start));
      wrap.appendChild(div);
    });
  }

  /** 配音进度联动:高亮 t 所在句并滚动到可视区域(仅句切换时滚动) */
  function highlightAt(t) {
    const found = VdcCache.findCueAt(currentCues, t);
    const idx = found ? currentCues.indexOf(found) : -1;
    if (idx === lastHlIdx) return;
    lastHlIdx = idx;
    const wrap = $('cues');
    const prev = wrap.querySelector('.cue.now');
    if (prev) prev.classList.remove('now');
    if (idx < 0) return;
    const el = wrap.children[idx];
    if (el) {
      el.classList.add('now');
      if ($('tab-subs').classList.contains('on')) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'DUB_PROGRESS' && msg.videoKey === currentKey) {
      highlightAt(msg.t);
    }
  });

  /* ---------------- 概览视图 ---------------- */

  async function renderOverview() {
    const wrap = $('overview');
    wrap.innerHTML = '';
    const ov = currentKey ? await VdcNotes.getOverview(currentKey) : null;
    if (!ov) {
      wrap.innerHTML = '<div class="empty">尚未生成概览——点上方按钮生成(与翻译共用 AI provider)</div>';
      return;
    }
    if (ov.chapters && ov.chapters.length) {
      const h = document.createElement('h1');
      h.style.fontSize = '13px';
      h.style.color = '#555';
      h.textContent = '章节';
      wrap.appendChild(h);
      for (const ch of ov.chapters) {
        const div = document.createElement('div');
        div.className = 'chapter';
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = (ch.timestamp || '') + ' ';
        const ct = document.createElement('span');
        ct.className = 'ct';
        ct.textContent = ch.title || '';
        const cs = document.createElement('div');
        cs.className = 'cs';
        cs.textContent = ch.summary || '';
        div.appendChild(t);
        div.appendChild(ct);
        div.appendChild(cs);
        div.addEventListener('click', () => seekTo(ch.timestampSeconds));
        wrap.appendChild(div);
      }
    }
    if (ov.keyQuotes && ov.keyQuotes.length) {
      const h = document.createElement('h1');
      h.style.fontSize = '13px';
      h.style.color = '#555';
      h.textContent = '关键引述';
      wrap.appendChild(h);
      for (const q of ov.keyQuotes) {
        const div = document.createElement('div');
        div.className = 'quote-item';
        div.textContent = q.quote || '';
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = ' ' + (q.timestamp || '');
        t.addEventListener('click', () => seekTo(q.timestampSeconds));
        div.appendChild(t);
        wrap.appendChild(div);
      }
    }
  }

  $('gen-overview').addEventListener('click', async () => {
    if (!currentKey) { setStatus('当前标签页不是视频页', true); return; }
    $('gen-overview').disabled = true;
    setStatus('正在生成概览(可能需要十几秒)...');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'GEN_OVERVIEW', videoKey: currentKey, force: true,
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '生成失败');
      await renderOverview();
      setStatus('概览已生成');
    } catch (e) {
      setStatus((e && e.message) || String(e), true);
    } finally {
      $('gen-overview').disabled = false;
    }
  });

  /* ---------------- 笔记视图 ---------------- */

  async function renderNotes() {
    const wrap = $('notes');
    wrap.innerHTML = '';
    const notes = currentKey ? await VdcCache.getNotes(currentKey) : [];
    if (!notes.length) {
      wrap.innerHTML = '<div class="empty">暂无笔记——观看中按 Ctrl+Shift+S 或点播放器上的「记录想法」按钮</div>';
      return;
    }
    for (const n of notes) {
      const div = document.createElement('div');
      div.className = 'note';
      const head = document.createElement('div');
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = VdcNotes.fmtTime(n.ts);
      ts.title = '跳回视频对应位置';
      ts.addEventListener('click', () => seekTo(n.ts));
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '删除这条笔记';
      del.addEventListener('click', async () => {
        await VdcCache.deleteNote(currentKey, n.id);
        renderNotes();
      });
      head.appendChild(ts);
      head.appendChild(del);
      div.appendChild(head);
      const quote = n.zh || n.text;
      if (quote) {
        const q = document.createElement('div');
        q.className = 'quote';
        q.textContent = quote;
        div.appendChild(q);
      }
      if (n.comment) {
        const c = document.createElement('div');
        c.className = 'comment';
        c.textContent = n.comment;
        div.appendChild(c);
      }
      if (n.shot) {
        const img = document.createElement('img');
        img.alt = '截图';
        VdcCache.getShot(n.shot).then((dataUrl) => {
          if (dataUrl) img.src = dataUrl;
        });
        div.appendChild(img);
      }
      wrap.appendChild(div);
    }
  }

  /* ---------------- 草稿视图 ---------------- */

  async function renderDraft() {
    const draft = currentKey ? await VdcNotes.getDraft(currentKey) : null;
    if (!saveTimer) $('draft').value = (draft && draft.md) || ''; // 用户编辑中不覆盖
    dirty = false;
  }

  async function generate() {
    if (!currentKey) { setStatus('当前标签页不是视频页', true); return; }
    if (dirty && $('draft').value.trim()) {
      if (!confirm('重新生成会覆盖当前编辑中的草稿,继续吗?')) return;
    }
    $('gen').disabled = true;
    setStatus('正在生成草稿(AI 概览中,可能需要十几秒)...');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GEN_DRAFT', videoKey: currentKey });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '生成失败');
      $('draft').value = resp.md;
      dirty = false;
      setStatus('草稿已生成,可编辑后导出');
    } catch (e) {
      setStatus((e && e.message) || String(e), true);
    } finally {
      $('gen').disabled = false;
    }
  }

  async function exportDraft() {
    if (!currentKey) { setStatus('当前标签页不是视频页', true); return; }
    const md = $('draft').value.trim();
    if (!md) { setStatus('请先生成草稿', true); return; }
    await VdcNotes.saveDraft(currentKey, $('draft').value); // 导出以编辑器内为准
    $('export').disabled = true;
    try {
      // 未选择过 vault 文件夹时先弹目录选择器(需用户手势,正好在点击里)
      if (VdcExporter.isFsSupported() && !(await VdcExporter.getVault().catch(() => null))) {
        await VdcExporter.pickVault();
      }
      const result = await VdcExporter.exportDraft(currentKey, $('draft').value);
      setStatus(result.method === 'vault'
        ? `已写入 vault:${result.fileName}(含 ${result.shotCount} 张截图)`
        : `已下载到 下载目录/video-notes/(含 ${result.shotCount} 张截图),请手动移入 vault`);
    } catch (e) {
      setStatus('导出失败:' + ((e && e.message) || e), true);
    } finally {
      $('export').disabled = false;
    }
  }

  $('gen').addEventListener('click', () => generate().catch((e) => setStatus(e.message, true)));
  $('export').addEventListener('click', () => exportDraft());
  $('pick-vault').addEventListener('click', async () => {
    try {
      const dir = await VdcExporter.pickVault();
      setStatus('已选择 vault:' + dir.name);
    } catch (e) {
      if (e && e.name !== 'AbortError') setStatus('选择失败:' + e.message, true);
    }
  });

  $('draft').addEventListener('input', () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (currentKey) {
        await VdcNotes.saveDraft(currentKey, $('draft').value);
        setStatus('草稿已自动保存');
      }
    }, 800);
  });

  /* ---------------- 状态栏与整体渲染 ---------------- */

  function setStatus(text, isErr) {
    const el = $('status');
    el.textContent = text || '';
    el.className = isErr ? 'err' : '';
    if (text && !isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  }

  async function render() {
    const doc = currentKey ? await VdcCache.getSubtitles(currentKey) : null;
    currentCues = (doc && doc.cues) || [];
    lastHlIdx = -1;
    if (!currentKey) {
      $('title').textContent = '视频笔记';
      $('meta').textContent = '请在当前标签页打开一个 YouTube 或 B 站视频';
    } else {
      $('title').textContent = (doc && doc.title) || '当前视频(暂无字幕缓存)';
      $('meta').textContent = doc
        ? `${doc.site || ''} · ${doc.cues.length} 句字幕 · ${doc.route || ''}`
        : '未开过配音,没有字幕缓存;开一次配音后字幕/概览/笔记都可用';
    }
    renderCues();
    await Promise.all([renderOverview(), renderNotes(), renderDraft()]);
  }

  // 跟随当前标签页:2 秒轮询(侧边栏打开期间开销极小)
  setInterval(async () => {
    const key = await detectCurrentVideo();
    if (key !== currentKey) {
      currentKey = key;
      clearTimeout(saveTimer);
      saveTimer = null;
      render();
    }
  }, 2000);

  detectCurrentVideo().then((key) => {
    currentKey = key;
    render();
  });
})();
