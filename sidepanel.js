/**
 * 侧边栏:视频学习主界面
 *
 * 四个视图:
 * - 字幕:共享缓存的双语字幕(双语/中文/原文切换),点击句子跳回视频对应位置;
 *   配音进行中接收 DUB_PROGRESS,自动高亮当前句并滚动跟随
 * - 概览:AI 章节 + 关键引述(与翻译同 provider,缓存 oview:{videoKey}),点击时间戳跳转
 * - 笔记:观看中捕捉的时间戳笔记,点时间戳跳回视频,可删除
 * - 笔记导出:Markdown 草稿生成/编辑(防抖自动保存)/导出 Obsidian
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

  /* 笔记页内部子标签(自动笔记 / 我的笔记,垂直排列在左侧) */
  document.querySelectorAll('.notes-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.notes-tabs button')
        .forEach((b) => b.classList.toggle('on', b === btn));
      document.querySelectorAll('.notes-pane').forEach((p) => {
        p.classList.toggle('on', p.id === 'ntab-' + btn.dataset.ntab);
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

  function renderCues(preserveView) {
    const wrap = $('cues');
    // 配音进行中译文分批到达会触发刷新:保持滚动位置与高亮,不打扰正在浏览的用户
    const scrollTop = preserveView ? document.scrollingElement.scrollTop : 0;
    const keepHl = preserveView ? lastHlIdx : -1;
    wrap.innerHTML = '';
    lastHlIdx = -1;
    if (!currentCues.length) {
      wrap.innerHTML = '<div class="empty">暂无字幕缓存——正在自动抓取,稍候即出</div>';
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
    if (preserveView) {
      document.scrollingElement.scrollTop = scrollTop;
      if (keepHl >= 0 && wrap.children[keepHl]) {
        wrap.children[keepHl].classList.add('now');
        lastHlIdx = keepHl;
      }
    }
  }

  // 页面侧写入(捕捉笔记、字幕译文回填、草稿生成)时即时刷新对应视图,
  // 不必等视频切换的轮询
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !currentKey) return;
    if (changes['notes:' + currentKey]) renderNotes();
    if (changes['draft:' + currentKey]) renderDraft();
    if (changes['subs:' + currentKey]) {
      VdcCache.getSubtitles(currentKey).then((doc) => {
        currentCues = (doc && doc.cues) || [];
        renderCues(true);
      });
    }
  });

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
      wrap.innerHTML = '<div class="empty">概览会自动生成;也可点上方按钮按当前粒度设置重新生成</div>';
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

  /* ---------------- 自动笔记(学习笔记模板) ----------------
   * 模板默认取设置页「默认笔记模板」(长期偏好),页签下拉可临时换风格;
   * 点「生成笔记」才调 AI(手动触发控制成本);按 视频×模板 分别缓存。
   */

  /** 行内渲染:**粗体** 与 [mm:ss] 时间戳(可点击跳回视频) */
  function appendInline(container, text) {
    const boldParts = text.split(/\*\*(.+?)\*\*/g);
    boldParts.forEach((part, i) => {
      if (i % 2 === 1) {
        const b = document.createElement('b');
        appendTs(b, part);
        container.appendChild(b);
      } else {
        appendTs(container, part);
      }
    });
  }

  function appendTs(container, text) {
    const re = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'an-ts';
      span.textContent = m[1];
      span.title = '跳回视频对应位置';
      // 注意:循环结束后 m 为 null(exec 无匹配返回 null 退出循环),
      // 闭包必须捕获当次匹配值,不能直接引用 m
      const sec = tsToSec(m[1]);
      span.addEventListener('click', () => seekTo(sec));
      container.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  function tsToSec(s) {
    const p = s.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }

  /** 极简 Markdown 渲染:##/### 标题、- 列表(带缩进)、段落;其余按段落处理 */
  function renderMd(md, container) {
    container.innerHTML = '';
    for (const raw of md.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const h3 = line.match(/^###\s+(.*)/);
      const h2 = !h3 && line.match(/^##\s+(.*)/);
      const li = !h3 && !h2 && line.match(/^(\s*)[-*]\s+(.*)/);
      const el = document.createElement('div');
      if (h3) {
        el.className = 'an-h3';
        appendInline(el, h3[1]);
      } else if (h2) {
        el.className = 'an-h2';
        appendInline(el, h2[1]);
      } else if (li) {
        el.className = 'an-li';
        el.dataset.indent = String(Math.min(2, Math.floor(li[1].length / 2)));
        appendInline(el, li[2]);
      } else {
        el.className = 'an-p';
        appendInline(el, line);
      }
      container.appendChild(el);
    }
  }

  /* ---------------- 草稿 Markdown 预览 ----------------
   * 轻量渲染(非完整 CommonMark):frontmatter、#/##/### 标题、- 列表、
   * **粗体**、[text](url) 链接、[mm:ss] 时间戳(可点击跳回视频)、
   * 截图 ![](attachments/{shotId}.jpg) 按 id 从缓存取 dataURL 显示。
   */

  /** 行内渲染:**粗体**、[text](url) 链接、[mm:ss] 时间戳 */
  function appendInlineRich(container, text) {
    const boldParts = text.split(/\*\*(.+?)\*\*/g);
    boldParts.forEach((part, i) => {
      if (i % 2 === 1) {
        const b = document.createElement('b');
        appendLinkTs(b, part);
        container.appendChild(b);
      } else {
        appendLinkTs(container, part);
      }
    });
  }

  function appendLinkTs(container, text) {
    const re = /\[([^\]]+)\]\((https?:[^)]+)\)|\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2]) {
        const a = document.createElement('a');
        a.href = m[2];
        a.textContent = m[1];
        a.target = '_blank';
        a.rel = 'noopener';
        container.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.className = 'an-ts';
        span.textContent = m[3];
        span.title = '跳回视频对应位置';
        const sec = tsToSec(m[3]); // 循环结束后 m 为 null,闭包须捕获当次值
        span.addEventListener('click', () => seekTo(sec));
        container.appendChild(span);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  async function renderDraftPreview(md) {
    const wrap = $('draft-preview');
    wrap.innerHTML = '';
    let body = md || '';
    const fm = body.match(/^\s*---\n([\s\S]*?)\n---\n?/);
    if (fm) {
      const pre = document.createElement('div');
      pre.className = 'md-frontmatter';
      pre.textContent = fm[1];
      wrap.appendChild(pre);
      body = body.slice(fm[0].length);
    }
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const imgM = line.match(/^!\[[^\]]*\]\(attachments\/(.+?)\.jpg\)\s*$/);
      if (imgM) {
        const img = document.createElement('img');
        img.className = 'md-img';
        img.alt = '截图';
        VdcCache.getShot(imgM[1]).then((u) => { if (u) img.src = u; });
        wrap.appendChild(img);
        continue;
      }
      const h1 = line.match(/^#\s+(.*)/);
      const h3 = !h1 && line.match(/^###\s+(.*)/);
      const h2 = !h1 && !h3 && line.match(/^##\s+(.*)/);
      const li = !h1 && !h3 && !h2 && line.match(/^(\s*)[-*]\s+(.*)/);
      const el = document.createElement('div');
      if (h1) {
        el.className = 'md-h1';
        appendInlineRich(el, h1[1]);
      } else if (h3) {
        el.className = 'an-h3';
        appendInlineRich(el, h3[1]);
      } else if (h2) {
        el.className = 'an-h2';
        appendInlineRich(el, h2[1]);
      } else if (li) {
        el.className = 'an-li';
        el.dataset.indent = String(Math.min(2, Math.floor(li[1].length / 2)));
        appendInlineRich(el, li[2]);
      } else {
        el.className = 'an-p';
        appendInlineRich(el, line);
      }
      wrap.appendChild(el);
    }
  }

  /* 编辑 / 预览 切换;切到预览时按编辑器当前内容渲染(含未保存的修改) */
  document.querySelectorAll('[data-dmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-dmode]').forEach((b) => b.classList.toggle('on', b === btn));
      const preview = btn.dataset.dmode === 'preview';
      $('draft').style.display = preview ? 'none' : '';
      $('draft-preview').style.display = preview ? 'block' : 'none';
      if (preview) renderDraftPreview($('draft').value);
    });
  });

  async function initAnoteTemplates() {
    const sel = $('anote-tpl');
    sel.innerHTML = '';
    for (const [id, t] of Object.entries(VdcNotes.NOTE_TEMPLATES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t.desc ? `${t.name} — ${t.desc}` : t.name;
      sel.appendChild(opt);
    }
    // 默认选中设置页的长期偏好
    const { options } = await chrome.storage.local.get('options');
    sel.value = (options && options.noteTemplate) || VdcNotes.DEFAULT_TEMPLATE;
  }

  async function renderAutoNote() {
    const wrap = $('anote');
    const sel = $('anote-tpl');
    wrap.innerHTML = '';
    if (!currentKey) {
      $('gen-anote').textContent = '生成笔记';
      return;
    }
    const note = await VdcNotes.getAutoNote(currentKey, sel.value);
    $('gen-anote').textContent = note ? '重新生成' : '生成笔记';
    if (!note) {
      wrap.innerHTML = '<div class="empty">选择模板后点「生成笔记」——按模板风格自动生成整片学习笔记</div>';
      return;
    }
    renderMd(note.md, wrap);
  }

  $('anote-tpl').addEventListener('change', renderAutoNote); // 临时换风格:有缓存秒出
  $('gen-anote').addEventListener('click', async () => {
    if (!currentKey) { setStatus('当前标签页不是视频页', true); return; }
    $('gen-anote').disabled = true;
    setStatus('正在生成笔记(可能需要十几秒)...');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'GEN_AUTONOTE',
        videoKey: currentKey,
        template: $('anote-tpl').value,
        force: true, // 用户显式点击 = 按当前选中模板重建
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '生成失败');
      renderMd(resp.note.md, $('anote'));
      $('gen-anote').textContent = '重新生成';
      setStatus('笔记已生成');
    } catch (e) {
      setStatus((e && e.message) || String(e), true);
    } finally {
      $('gen-anote').disabled = false;
    }
  });

  /* ---------------- 笔记视图 ---------------- */

  /**
   * 渲染一条笔记。两种状态:
   * - 只读(默认):时间戳 + 「编辑」按钮 + 删除笔记 ×;截图仅可点击预览
   * - 编辑态:想法变为输入框(保存/取消),截图下方提供 标记/删除截图
   */
  function renderNote(div, n, editing) {
    div.innerHTML = '';
    div.className = 'note';

    const head = document.createElement('div');
    head.className = 'note-head';
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
    if (!editing) {
      const edit = document.createElement('button');
      edit.className = 'edit-btn';
      edit.textContent = '编辑';
      edit.title = '编辑这条笔记(文本 / 截图)';
      edit.addEventListener('click', () => renderNote(div, n, true));
      head.appendChild(edit);
    }
    div.appendChild(head);

    const quote = n.zh || n.text;
    if (quote) {
      const q = document.createElement('div');
      q.className = 'quote';
      q.textContent = quote;
      div.appendChild(q);
    }

    if (editing) {
      const ta = document.createElement('textarea');
      ta.className = 'edit-area';
      ta.value = n.comment || '';
      ta.placeholder = '此刻的想法…';
      div.appendChild(ta);
      const bar = document.createElement('div');
      bar.className = 'edit-bar';
      const ok = document.createElement('button');
      ok.textContent = '保存';
      ok.addEventListener('click', async () => {
        await VdcCache.updateNote(currentKey, n.id, { comment: ta.value.trim() });
        renderNotes();
      });
      const no = document.createElement('button');
      no.textContent = '取消';
      no.addEventListener('click', () => renderNote(div, n, false));
      bar.appendChild(ok);
      bar.appendChild(no);
      div.appendChild(bar);
      ta.focus();
    } else if (n.comment) {
      const c = document.createElement('div');
      c.className = 'comment';
      c.textContent = n.comment;
      div.appendChild(c);
    }

    if (n.shot) {
      const img = document.createElement('img');
      img.alt = '截图(点击放大预览)';
      img.title = '点击放大预览';
      VdcCache.getShot(n.shot).then((dataUrl) => {
        if (dataUrl) img.src = dataUrl;
      });
      img.addEventListener('click', () => {
        if (img.src && globalThis.DubShotEdit) DubShotEdit.view({ dataUrl: img.src });
      });
      div.appendChild(img);
      if (editing) {
        const bar = document.createElement('div');
        bar.className = 'shot-actions';
        // 标记:编辑器完成后覆盖写回同一 shot id,草稿/导出按 id 取图自动生效
        const annot = document.createElement('button');
        annot.textContent = '标记';
        annot.title = '在截图上添加画笔/矩形/箭头/文字标记';
        annot.addEventListener('click', async () => {
          if (!globalThis.DubShotEdit) return;
          const dataUrl = await VdcCache.getShot(n.shot);
          if (!dataUrl) { setStatus('截图数据缺失,无法标记', true); return; }
          DubShotEdit.edit({
            dataUrl,
            onSave: async (newDataUrl) => {
              await VdcCache.saveShot(n.shot, newDataUrl);
              img.src = newDataUrl;
              setStatus('截图标记已保存');
            },
          });
        });
        bar.appendChild(annot);
        // 删除截图:笔记保留,清掉 shot 引用与截图数据
        const delShot = document.createElement('button');
        delShot.textContent = '删除截图';
        delShot.title = '从这条笔记中移除截图';
        delShot.addEventListener('click', async () => {
          if (!confirm('删除这张截图?(笔记本身保留)')) return;
          const sid = n.shot;
          await VdcCache.updateNote(currentKey, n.id, { shot: null });
          try { await VdcCache.removeShot(sid); } catch (e) { /* 无碍 */ }
          renderNotes();
        });
        bar.appendChild(delShot);
        div.appendChild(bar);
      }
    }
  }

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
      renderNote(div, n, false);
      wrap.appendChild(div);
    }
  }

  /* ---------------- 草稿视图 ---------------- */

  async function renderDraft() {
    const draft = currentKey ? await VdcNotes.getDraft(currentKey) : null;
    // 用户编辑过(含自动保存触发的回填事件)时不覆盖编辑器内容,避免光标跳动
    if (!saveTimer && !dirty) $('draft').value = (draft && draft.md) || '';
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
      // 没有任何可用位置(默认 vault 与临时位置都未设置)时先弹目录选择器(需用户手势,正好在点击里)
      if (VdcExporter.isFsSupported() && !VdcExporter.getTempVault() &&
          !(await VdcExporter.getVault().catch(() => null))) {
        await VdcExporter.pickVault(); // 首次选择即存为默认 vault
      }
      const result = await VdcExporter.exportDraft(currentKey, $('draft').value);
      setStatus(result.method === 'vault'
        ? `已写入 vault:${result.fileName}(含 ${result.shotCount} 张截图)`
        : `已下载到 下载目录/video-notes/(含 ${result.shotCount} 张截图),请手动移入 vault`);
      refreshVaultLabel();
    } catch (e) {
      setStatus('导出失败:' + ((e && e.message) || e), true);
    } finally {
      $('export').disabled = false;
    }
  }

  /** 导出位置标签:临时位置(本次会话)> 设置页默认 vault > 下载目录兜底 */
  async function refreshVaultLabel() {
    const label = $('vault-label');
    const resetBtn = $('reset-vault');
    const temp = VdcExporter.getTempVault();
    if (temp) {
      label.textContent = `导出位置:${temp.name}(临时,仅本次会话)`;
      resetBtn.style.display = '';
      return;
    }
    resetBtn.style.display = 'none';
    if (!VdcExporter.isFsSupported()) {
      label.textContent = '导出位置:下载目录/video-notes/(浏览器不支持文件夹直写)';
      return;
    }
    const dir = await VdcExporter.peekVault().catch(() => null);
    label.textContent = dir
      ? `导出位置:${dir.name}(默认)`
      : '导出位置:下载目录/video-notes/(未设置默认 vault,可在设置页配置)';
  }

  $('gen').addEventListener('click', () => generate().catch((e) => setStatus(e.message, true)));
  $('export').addEventListener('click', () => exportDraft());
  $('switch-vault').addEventListener('click', async () => {
    try {
      const dir = await VdcExporter.pickTempVault();
      setStatus('本次会话临时导出到:' + dir.name);
    } catch (e) {
      if (e && e.name !== 'AbortError') setStatus('选择失败:' + e.message, true);
    }
    refreshVaultLabel();
  });
  $('reset-vault').addEventListener('click', () => {
    VdcExporter.clearTempVault();
    refreshVaultLabel();
    setStatus('已恢复默认导出位置');
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
        : '暂无字幕缓存,正在自动抓取字幕并生成概览…';
    }
    renderCues();
    refreshVaultLabel();
    await Promise.all([renderOverview(), renderNotes(), renderDraft(), renderAutoNote()]);
  }

  /* ---------------- 自动准备:抓字幕 → 补翻译 → 生成概览 ----------------
   * 侧边栏打开或切换视频时,若当前视频还没有字幕缓存,自动走一遍准备流程,
   * 无需用户先开配音或手动点生成。每个视频每次会话只自动跑一次。
   */

  const autoEnsured = new Set();

  async function autoEnsure(key) {
    if (!key || autoEnsured.has(key) || currentTabId == null) return;
    autoEnsured.add(key);
    try {
      let doc = await VdcCache.getSubtitles(key);
      if (!doc || !doc.cues || !doc.cues.length) {
        setStatus('正在自动抓取字幕...');
        const resp = await chrome.tabs.sendMessage(currentTabId, { type: 'FETCH_SUBS' })
          .catch(() => null);
        if (!resp || !resp.ok) {
          setStatus('字幕自动抓取失败:' + ((resp && resp.error) || '请在视频页刷新后重试'), true);
          return;
        }
        render(); // 字幕文档已写入,刷新各视图
      }
      // 英文轨还需补中文(与配音管线共用缓存,不重复调 AI)
      doc = await VdcCache.getSubtitles(key);
      if (doc && doc.cues.some((c) => !c.zh)) {
        setStatus('正在翻译字幕...');
        const tr = await chrome.runtime.sendMessage({ type: 'TRANSLATE_SUBS', videoKey: key });
        if (!tr || !tr.ok) {
          setStatus('字幕翻译失败:' + ((tr && tr.error) || ''), true);
          return;
        }
      }
      // 自动生成概览(已有缓存则直接命中,零成本)
      if (!(await VdcNotes.getOverview(key))) {
        setStatus('正在自动生成概览...');
        const r = await chrome.runtime.sendMessage({ type: 'GEN_OVERVIEW', videoKey: key });
        if (!r || !r.ok) {
          setStatus('概览生成失败:' + ((r && r.error) || ''), true);
          return;
        }
        renderOverview();
      }
      setStatus('');
    } catch (e) {
      setStatus('自动准备失败:' + ((e && e.message) || e), true);
    }
  }

  // 跟随当前标签页:2 秒轮询(侧边栏打开期间开销极小)
  setInterval(async () => {
    const key = await detectCurrentVideo();
    if (key !== currentKey) {
      currentKey = key;
      clearTimeout(saveTimer);
      saveTimer = null;
      dirty = false;
      render();
      autoEnsure(key);
    }
  }, 2000);

  detectCurrentVideo().then((key) => {
    currentKey = key;
    initAnoteTemplates().then(() => render());
    autoEnsure(key);
  });
})();
