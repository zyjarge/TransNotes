/**
 * 设置页逻辑:读写 chrome.storage.local 的 options
 * 音色列表来自 MiniMax 官方系统音色(2026-08 核对),精选中文男声
 */
(function () {
  'use strict';

  const DEFAULT_OPTIONS = {
    minimaxApiKey: '',
    minimaxGroupId: '',
    voiceId: 'male-qn-qingse',
    customVoiceId: '',
    speed: 1.0,
    translateBaseUrl: 'https://api.deepseek.com',
    translateApiKey: '',
    translateModel: 'deepseek-chat',
    disableThinking: false,
    polishSubtitles: false,
    overviewLevel: 'normal',
    noteTemplate: 'cornell',
    exportSections: { meta: true, overview: true, notes: true, autoNote: true, qa: true, subtitles: true },
  };

  // MiniMax 官方系统音色(2026-09 核对官方中文文档系统音色列表);
  // female-* 为上一代音色 id,Chinese (Mandarin)_* 为新系列;名称以官方中文名为准
  const VOICES = [
    // 男声
    { id: 'male-qn-qingse', name: '青涩青年音色' },
    { id: 'male-qn-jingying', name: '精英青年音色' },
    { id: 'male-qn-badao', name: '霸道青年音色' },
    { id: 'male-qn-daxuesheng', name: '青年大学生音色' },
    { id: 'Chinese (Mandarin)_Reliable_Executive', name: '沉稳高管(男)' },
    { id: 'Chinese (Mandarin)_Gentleman', name: '温润男声' },
    { id: 'Chinese (Mandarin)_Male_Announcer', name: '播报男声' },
    { id: 'Chinese (Mandarin)_Lyrical_Voice', name: '抒情男声' },
    { id: 'Chinese (Mandarin)_Radio_Host', name: '电台男主播' },
    // 女声
    { id: 'female-shaonv', name: '少女音色' },
    { id: 'female-yujie', name: '御姐音色' },
    { id: 'female-chengshu', name: '成熟女性音色' },
    { id: 'female-tianmei', name: '甜美女性音色' },
    { id: 'Chinese (Mandarin)_News_Anchor', name: '新闻女声' },
    { id: 'Chinese (Mandarin)_Mature_Woman', name: '傲娇御姐' },
    { id: 'Chinese (Mandarin)_Sweet_Lady', name: '甜美女声' },
    { id: 'Chinese (Mandarin)_IntellectualGirl', name: '知性女声' },
    { id: 'Chinese (Mandarin)_Warm_Girl', name: '温暖少女' },
    { id: 'Chinese (Mandarin)_Warm_Bestie', name: '温暖闺蜜' },
    { id: 'Chinese (Mandarin)_Crisp_Girl', name: '清脆少女' },
    // 特色/方言
    { id: 'Chinese (Mandarin)_HK_Flight_Attendant', name: '港普空姐(特色)' },
    { id: 'Chinese (Mandarin)_Humorous_Elder', name: '搞笑大爷(特色)' },
    { id: 'Cantonese_GentleLady', name: '粤语·温柔女声' },
    { id: 'Cantonese_PlayfulMan', name: '粤语·活泼男声' },
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function populateVoices(selectedId) {
    const select = $('voiceId');
    for (const v of VOICES) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.id})`;
      select.appendChild(opt);
    }
    select.value = VOICES.some((v) => v.id === selectedId) ? selectedId : VOICES[0].id;
  }

  /** 自定义音色生效时,在下拉里追加并选中「自定义音色 (id)」,让实际生效音色可见 */
  function markCustomVoice(id) {
    const select = $('voiceId');
    let opt = select.querySelector('option[data-custom="1"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.dataset.custom = '1';
      select.appendChild(opt);
    }
    opt.value = id;
    opt.textContent = `自定义音色 (${id})`;
    select.value = id;
  }

  async function load() {
    const { options } = await chrome.storage.local.get('options');
    const merged = Object.assign({}, DEFAULT_OPTIONS, options || {});
    $('minimaxApiKey').value = merged.minimaxApiKey || '';
    $('minimaxGroupId').value = merged.minimaxGroupId || '';
    populateVoices(merged.voiceId);
    // 兼容:已保存的音色不在内置列表里(如历史版本保存的克隆音色)→ 自动归入自定义 ID 字段
    if (!merged.customVoiceId && merged.voiceId && !VOICES.some((v) => v.id === merged.voiceId)) {
      merged.customVoiceId = merged.voiceId;
    }
    $('customVoiceId').value = merged.customVoiceId || '';
    if (merged.customVoiceId) markCustomVoice(merged.customVoiceId);
    $('speed').value = merged.speed || 1.0;
    $('translateBaseUrl').value = merged.translateBaseUrl || DEFAULT_OPTIONS.translateBaseUrl;
    $('translateApiKey').value = merged.translateApiKey || '';
    $('translateModel').value = merged.translateModel || DEFAULT_OPTIONS.translateModel;
    $('disableThinking').checked = !!merged.disableThinking;
    $('polishSubtitles').checked = !!merged.polishSubtitles;
    $('overviewLevel').value = merged.overviewLevel || DEFAULT_OPTIONS.overviewLevel;
    populateTplSelect(merged.noteTemplate || DEFAULT_OPTIONS.noteTemplate);
    const es = Object.assign({}, DEFAULT_OPTIONS.exportSections, merged.exportSections || {});
    $('expMeta').checked = !!es.meta;
    $('expOverview').checked = !!es.overview;
    $('expNotes').checked = !!es.notes;
    $('expAutoNote').checked = es.autoNote !== false;
    $('expQA').checked = es.qa !== false;
    $('expSubs').checked = !!es.subtitles;
  }

  async function save() {
    const customId = $('customVoiceId').value.trim();    let voiceId = $('voiceId').value;
    // 清空了自定义 ID 但下拉还停在自定义项上:回落到内置音色,避免"看似清了其实还在用"
    const customOpt = $('voiceId').querySelector('option[data-custom="1"]');
    if (!customId && customOpt && voiceId === customOpt.value) voiceId = VOICES[0].id;
    const options = {
      minimaxApiKey: $('minimaxApiKey').value.trim(),
      minimaxGroupId: $('minimaxGroupId').value.trim(),
      voiceId,
      customVoiceId: customId,
      speed: Math.min(2.0, Math.max(0.5, Number($('speed').value) || 1.0)),
      translateBaseUrl: $('translateBaseUrl').value.trim().replace(/\/+$/, ''),
      translateApiKey: $('translateApiKey').value.trim(),
      translateModel: $('translateModel').value.trim(),
      disableThinking: $('disableThinking').checked,
      polishSubtitles: $('polishSubtitles').checked,
      overviewLevel: $('overviewLevel').value,
      noteTemplate: $('noteTemplate').value,
      exportSections: {
        meta: $('expMeta').checked,
        overview: $('expOverview').checked,
        notes: $('expNotes').checked,
        autoNote: $('expAutoNote').checked,
        qa: $('expQA').checked,
        subtitles: $('expSubs').checked,
      },
    };
    await chrome.storage.local.set({ options });
    optionsDirty = false;
    showStatus('已保存');
  }

  function showStatus(text) {
    const el = $('save-status');
    el.textContent = text;
    el.className = '';
    setTimeout(() => { el.textContent = ''; }, 2000);
  }

  /* 左侧菜单切换 */
  document.querySelectorAll('.menu button[data-sec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.menu button[data-sec]')
        .forEach((b) => b.classList.toggle('on', b === btn));
      document.querySelectorAll('.content section').forEach((s) => {
        s.classList.toggle('on', s.id === 'sec-' + btn.dataset.sec);
      });
    });
  });

  $('save').addEventListener('click', () => {
    save().catch((e) => {
      showStatus(e.message || '保存失败');
    });
  });

  // 输入自定义音色 ID 时下拉即时反映生效音色;改选内置音色则清掉自定义 ID,所见即生效
  $('customVoiceId').addEventListener('input', () => {
    const v = $('customVoiceId').value.trim();
    if (v) markCustomVoice(v);
  });
  $('voiceId').addEventListener('change', () => {
    const select = $('voiceId');
    const customOpt = select.querySelector('option[data-custom="1"]');
    if (customOpt && select.value !== customOpt.value) {
      $('customVoiceId').value = '';
    }
  });

  /* ---------------- 默认 Obsidian vault 文件夹 ----------------
   * 句柄持久化在 IndexedDB(与侧边栏同源共享)。展示用 peekVault(只读句柄,
   * 不请求授权),避免页面加载时因无用户手势触发 requestPermission 报错。
   */

  async function refreshVaultName() {
    const el = $('vault-name');
    if (!VdcExporter.isFsSupported()) {
      el.textContent = '当前浏览器不支持文件夹直写,导出时将下载到「下载目录/video-notes/」';
      $('pick-vault').disabled = true;
      return;
    }
    const dir = await VdcExporter.peekVault().catch(() => null);
    el.textContent = dir ? `已选择:${dir.name}` : '未选择';
  }

  $('pick-vault').addEventListener('click', async () => {
    try {
      const dir = await VdcExporter.pickVault();
      $('vault-name').textContent = `已选择:${dir.name}`;
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        showStatus('选择失败:' + (e.message || e));
      }
    }
  });

  /* ---------------- 笔记模板管理 ----------------
   * 内置模板只读(查看提示词/基于此新建);自定义模板可编辑/删除;
   * 当前默认模板不可删除(数据层 deleteCustomTemplate 同样拦截)。
   */

  /** 默认模板下拉:内置 + 自定义动态生成 */
  async function populateTplSelect(selectedId) {
    const all = await VdcNotes.getAllTemplates();
    const sel = $('noteTemplate');
    sel.innerHTML = '';
    for (const t of Object.values(all)) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = (t.builtin ? '' : '⭐ ') + (t.desc ? `${t.name} — ${t.desc}` : t.name);
      sel.appendChild(opt);
    }
    sel.value = selectedId;
    if (!sel.value) sel.value = VdcNotes.DEFAULT_TEMPLATE; // 默认被删等异常回落
  }

  let tplEditingId = null; // 编辑器状态:null=新建;id=编辑已有自定义模板

  function openTplEditor(t) {
    tplEditingId = (t && t.id) || null;
    $('tpl-name').value = (t && t.name) || '';
    $('tpl-desc').value = (t && t.desc) || '';
    $('tpl-prompt').value = (t && t.prompt) || '';
    $('tpl-editor').style.display = 'block';
    $('tpl-name').focus();
  }

  function closeTplEditor() {
    tplEditingId = null;
    $('tpl-editor').style.display = 'none';
  }

  async function renderTplList() {
    const wrap = $('tpl-list');
    wrap.innerHTML = '';
    const all = await VdcNotes.getAllTemplates();
    const { options } = await chrome.storage.local.get('options');
    const defId = (options && options.noteTemplate) || VdcNotes.DEFAULT_TEMPLATE;
    for (const t of Object.values(all)) {
      const row = document.createElement('div');
      row.className = 'tpl-row';
      const head = document.createElement('div');
      head.className = 'tpl-head';
      const name = document.createElement('span');
      name.className = 'tpl-name';
      name.textContent = t.name;
      const badge = document.createElement('span');
      badge.className = 'tpl-badge' + (t.builtin ? '' : ' custom');
      badge.textContent = t.builtin ? '内置' : '自定义';
      head.appendChild(name);
      head.appendChild(badge);
      if (t.id === defId) {
        const mark = document.createElement('span');
        mark.className = 'tpl-default-mark';
        mark.textContent = '默认';
        head.appendChild(mark);
      }
      const actions = document.createElement('span');
      actions.className = 'tpl-actions';
      const viewBtn = document.createElement('button');
      viewBtn.textContent = '查看提示词';
      actions.appendChild(viewBtn);
      if (t.builtin) {
        const dup = document.createElement('button');
        dup.textContent = '基于此新建';
        dup.addEventListener('click', () => openTplEditor({
          name: t.name + '(自定义)', desc: t.desc, prompt: t.prompt,
        }));
        actions.appendChild(dup);
      } else {
        const edit = document.createElement('button');
        edit.textContent = '编辑';
        edit.addEventListener('click', () => openTplEditor(t));
        actions.appendChild(edit);
        const del = document.createElement('button');
        del.textContent = '删除';
        if (t.id === defId) {
          del.disabled = true;
          del.title = '默认模板不可删除,请先把默认模板切换为其他模板';
        } else {
          del.addEventListener('click', async () => {
            if (!confirm(`删除模板「${t.name}」?已用它生成的笔记缓存保留。`)) return;
            try {
              await VdcNotes.deleteCustomTemplate(t.id);
              renderTplList();
              populateTplSelect($('noteTemplate').value);
            } catch (e) {
              alert((e && e.message) || String(e));
            }
          });
        }
        actions.appendChild(del);
      }
      head.appendChild(actions);
      row.appendChild(head);
      if (t.desc) {
        const desc = document.createElement('div');
        desc.className = 'tpl-desc';
        desc.textContent = t.desc;
        row.appendChild(desc);
      }
      const pre = document.createElement('div');
      pre.className = 'tpl-prompt-view';
      pre.style.display = 'none';
      pre.textContent = t.prompt;
      viewBtn.addEventListener('click', () => {
        pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
        viewBtn.textContent = pre.style.display === 'none' ? '查看提示词' : '收起提示词';
      });
      row.appendChild(pre);
      wrap.appendChild(row);
    }
  }

  $('tpl-new').addEventListener('click', () => openTplEditor(null));
  $('tpl-cancel').addEventListener('click', closeTplEditor);
  $('tpl-save').addEventListener('click', async () => {
    try {
      await VdcNotes.saveCustomTemplate({
        id: tplEditingId,
        name: $('tpl-name').value,
        desc: $('tpl-desc').value,
        prompt: $('tpl-prompt').value,
      });
      closeTplEditor();
      renderTplList();
      populateTplSelect($('noteTemplate').value);
      showStatus('模板已保存');
    } catch (e) {
      alert((e && e.message) || String(e));
    }
  });

  /* 未保存保护:修改过配置未保存就离开页面时提示(模板编辑器独立保存,不参与) */
  let optionsDirty = false;
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.closest('#tpl-editor')) return;
    el.addEventListener('input', () => { optionsDirty = true; });
  });
  window.addEventListener('beforeunload', (e) => {
    if (optionsDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  load();
  renderTplList();
  refreshVaultName();
})();
