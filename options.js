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
    speed: 1.0,
    translateBaseUrl: 'https://api.deepseek.com',
    translateApiKey: '',
    translateModel: 'deepseek-chat',
    disableThinking: false,
    overviewLevel: 'normal',
    noteTemplate: 'cornell',
    exportSections: { meta: true, overview: true, notes: true, autoNote: true, subtitles: true },
  };

  const VOICES = [
    { id: 'male-qn-qingse', name: '青涩青年音色' },
    { id: 'male-qn-jingying', name: '精英青年音色' },
    { id: 'male-qn-badao', name: '霸道青年音色' },
    { id: 'male-qn-daxuesheng', name: '青年大学生音色' },
    { id: 'Chinese (Mandarin)_Reliable_Executive', name: '沉稳高管(男)' },
    { id: 'Chinese (Mandarin)_Gentleman', name: '温润男声' },
    { id: 'Chinese (Mandarin)_Male_Announcer', name: '播报男声' },
    { id: 'Chinese (Mandarin)_Lyrical_Voice', name: '抒情男声' },
    { id: 'Chinese (Mandarin)_Radio_Host', name: '电台男主播' },
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

  async function load() {
    const { options } = await chrome.storage.local.get('options');
    const merged = Object.assign({}, DEFAULT_OPTIONS, options || {});
    $('minimaxApiKey').value = merged.minimaxApiKey || '';
    $('minimaxGroupId').value = merged.minimaxGroupId || '';
    populateVoices(merged.voiceId);
    $('speed').value = merged.speed || 1.0;
    $('translateBaseUrl').value = merged.translateBaseUrl || DEFAULT_OPTIONS.translateBaseUrl;
    $('translateApiKey').value = merged.translateApiKey || '';
    $('translateModel').value = merged.translateModel || DEFAULT_OPTIONS.translateModel;
    $('disableThinking').checked = !!merged.disableThinking;
    $('overviewLevel').value = merged.overviewLevel || DEFAULT_OPTIONS.overviewLevel;
    $('noteTemplate').value = merged.noteTemplate || DEFAULT_OPTIONS.noteTemplate;
    const es = Object.assign({}, DEFAULT_OPTIONS.exportSections, merged.exportSections || {});
    $('expMeta').checked = !!es.meta;
    $('expOverview').checked = !!es.overview;
    $('expNotes').checked = !!es.notes;
    $('expAutoNote').checked = es.autoNote !== false;
    $('expSubs').checked = !!es.subtitles;
  }

  async function save() {
    const options = {
      minimaxApiKey: $('minimaxApiKey').value.trim(),
      minimaxGroupId: $('minimaxGroupId').value.trim(),
      voiceId: $('voiceId').value,
      speed: Math.min(2.0, Math.max(0.5, Number($('speed').value) || 1.0)),
      translateBaseUrl: $('translateBaseUrl').value.trim().replace(/\/+$/, ''),
      translateApiKey: $('translateApiKey').value.trim(),
      translateModel: $('translateModel').value.trim(),
      disableThinking: $('disableThinking').checked,
      overviewLevel: $('overviewLevel').value,
      noteTemplate: $('noteTemplate').value,
      exportSections: {
        meta: $('expMeta').checked,
        overview: $('expOverview').checked,
        notes: $('expNotes').checked,
        autoNote: $('expAutoNote').checked,
        subtitles: $('expSubs').checked,
      },
    };
    await chrome.storage.local.set({ options });
    showStatus('已保存');
  }

  function showStatus(text) {
    const el = $('save-status');
    el.textContent = text;
    el.className = '';
    setTimeout(() => { el.textContent = ''; }, 2000);
  }

  $('save').addEventListener('click', () => {
    save().catch((e) => {
      showStatus(e.message || '保存失败');
    });
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

  load();
  refreshVaultName();
})();
