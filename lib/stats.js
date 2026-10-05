/**
 * 存储与用量统计(设置页「数据统计」)
 *
 * 直接扫描 chrome.storage.local 全量 key,按前缀归类统计。
 * 所有数字都是「当前本地缓存快照」:清理缓存后统计随之减少,不做历史累计。
 *
 * key 前缀约定(详见 lib/cache.js / background.js / lib/notes.js):
 *   subs:  字幕文档      notes: 手动笔记      ask:   助教问答
 *   shot:  笔记截图      thumb: 章节缩略图
 *   oview: AI 概览       anote: 自动笔记      draft: 笔记草稿
 *   trans: 翻译/润色缓存  audio:/chunk: 配音音频缓存
 *
 * 通过 globalThis.VdcStats 暴露,options 页使用。
 */
(function () {
  'use strict';

  /** 分类定义;clearable 的类别提供一键清理 */
  const CATEGORIES = [
    { id: 'audio', name: '音频缓存', prefixes: ['audio:', 'chunk:'], clearable: true },
    { id: 'trans', name: '翻译缓存', prefixes: ['trans:'], clearable: true },
    { id: 'thumb', name: '缩略图缓存', prefixes: ['thumb:'], clearable: true },
    { id: 'subs', name: '字幕数据', prefixes: ['subs:'], clearable: false },
    { id: 'notes', name: '我的笔记', prefixes: ['notes:'], clearable: false },
    { id: 'ai', name: 'AI 生成内容', prefixes: ['oview:', 'anote:', 'draft:'], clearable: false },
    { id: 'qa', name: '助教问答', prefixes: ['ask:'], clearable: false },
    { id: 'shot', name: '笔记截图', prefixes: ['shot:'], clearable: false },
    { id: 'other', name: '其他(配置等)', prefixes: [], clearable: false },
  ];

  function categoryOf(key) {
    for (const c of CATEGORIES) {
      if (c.prefixes.some((p) => key.indexOf(p) === 0)) return c.id;
    }
    return 'other';
  }

  /** 条目近似大小:key 长度 + 值序列化长度(字节级近似,展示用) */
  function entrySize(key, value) {
    let len = key.length;
    try { len += JSON.stringify(value).length; } catch (e) { /* 忽略 */ }
    return len;
  }

  /** 递归拼接对象中的所有字符串值(统计 AI 生成内容字数用) */
  function collectStrings(v, out) {
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) collectStrings(v[k], out); }
  }

  /** 字数口径:去除所有空白后的字符数(中英文混排通用) */
  function countChars(str) {
    return (str || '').replace(/\s+/g, '').length;
  }

  /** 秒 → "X 小时 Y 分钟" / "Y 分钟" */
  function formatDuration(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟';
  }

  /** 字节 → 可读单位 */
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /**
   * 扫描全量存储,产出统计快照
   * @returns {Promise<object>} 见返回结构,UI 直接消费
   */
  async function collect() {
    const all = await chrome.storage.local.get(null);
    // 权威总字节数(浏览器口径);分类占比为近似值,两者可能略有出入
    const bytesInUse = await chrome.storage.local.getBytesInUse(null);

    const catBytes = {};
    const catKeys = {};
    for (const c of CATEGORIES) { catBytes[c.id] = 0; catKeys[c.id] = 0; }

    const s = {
      bytesInUse,
      categories: [],
      videoCount: 0,        // 已抓字幕的视频数
      cueCount: 0,          // 字幕总句数
      subSeconds: 0,        // 字幕覆盖总时长(秒)
      translatedVideos: 0,  // 已翻译视频数(按翻译缓存出现过的视频)
      translatedCues: 0,    // 翻译句数(不含润色)
      polishedCues: 0,      // 润色句数
      dubbedVideos: 0,      // 合成过配音的视频数
      dubbedSeconds: 0,     // 配音总时长(估算)
      audioEntries: 0,      // 音频缓存条目数(逐句 + 合并块)
      notesCount: 0,        // 手动笔记条数
      notesChars: 0,        // 手动笔记字数(含引用的字幕原文)
      qaCount: 0,           // 助教问答条数
      aiChars: 0,           // AI 生成内容总字数(概览 + 自动笔记 + 草稿)
      overviewCount: 0,     // AI 概览份数
      autoNoteCount: 0,     // 自动笔记份数(按模板计数)
      draftCount: 0,        // 笔记草稿份数
      shotCount: 0,         // 笔记截图张数
    };

    const transVideoIds = new Set();
    const dubbedVideoIds = new Set();
    const audioCueCovered = new Map(); // videoId → 已合成音频覆盖的句数(估算用)

    for (const key of Object.keys(all)) {
      const value = all[key];
      const cat = categoryOf(key);
      catBytes[cat] += entrySize(key, value);
      catKeys[cat]++;

      if (key.indexOf('subs:') === 0) {
        const doc = value;
        if (doc && Array.isArray(doc.cues) && doc.cues.length) {
          s.videoCount++;
          s.cueCount += doc.cues.length;
          const last = doc.cues[doc.cues.length - 1];
          if (last && typeof last.end === 'number') s.subSeconds += last.end;
        }
      } else if (key.indexOf('trans:v2:pl:') === 0) {
        s.polishedCues++;
      } else if (key.indexOf('trans:v2:') === 0) {
        // trans:v2:{videoId}:{index}:zh
        s.translatedCues++;
        const vid = key.split(':')[2];
        if (vid) transVideoIds.add(vid);
      } else if (key.indexOf('audio:v2:') === 0) {
        // audio:v2:{videoId}:{voice}:{speed}:{index}
        s.audioEntries++;
        const vid = key.split(':')[2];
        if (vid) {
          dubbedVideoIds.add(vid);
          audioCueCovered.set(vid, (audioCueCovered.get(vid) || 0) + 1);
        }
      } else if (key.indexOf('chunk:v3:') === 0) {
        // chunk:v3:{videoId}:{voice}:{speed}:{first}-{last}
        s.audioEntries++;
        const parts = key.split(':');
        const vid = parts[2];
        const range = parts[parts.length - 1].split('-');
        if (vid) {
          dubbedVideoIds.add(vid);
          const span = range.length === 2 ? (parseInt(range[1], 10) - parseInt(range[0], 10) + 1) : 1;
          audioCueCovered.set(vid, (audioCueCovered.get(vid) || 0) + (span > 0 ? span : 1));
        }
      } else if (key.indexOf('notes:') === 0 && Array.isArray(value)) {
        s.notesCount += value.length;
        for (const n of value) {
          s.notesChars += countChars((n && n.comment) || '') + countChars((n && n.text) || '');
        }
      } else if (key.indexOf('ask:') === 0 && Array.isArray(value)) {
        s.qaCount += value.length;
      } else if (key.indexOf('oview:') === 0) {
        s.overviewCount++;
        const strs = []; collectStrings(value, strs);
        s.aiChars += countChars(strs.join(''));
      } else if (key.indexOf('anote:') === 0) {
        // anote:last:{videoKey} 只是模板名指针,不计入
        if (key.indexOf('anote:last:') !== 0) {
          s.autoNoteCount++;
          s.aiChars += countChars(value && value.md);
        }
      } else if (key.indexOf('draft:') === 0) {
        s.draftCount++;
        s.aiChars += countChars(value && value.md);
      } else if (key.indexOf('shot:') === 0) {
        s.shotCount++;
      }
    }

    // 配音总时长估算:已合成视频的字幕时长 × 音频覆盖率(覆盖句数 / 总句数)
    let dubbedSeconds = 0;
    for (const vid of dubbedVideoIds) {
      let doc = all['subs:yt:' + vid];
      if (!doc) {
        const k = Object.keys(all).find((x) => x.indexOf('subs:') === 0 && x.indexOf(vid) !== -1);
        doc = k ? all[k] : null;
      }
      if (!doc || !Array.isArray(doc.cues) || !doc.cues.length) continue;
      const total = doc.cues[doc.cues.length - 1].end || 0;
      const ratio = Math.min(1, (audioCueCovered.get(vid) || 0) / doc.cues.length);
      dubbedSeconds += total * ratio;
    }
    s.dubbedSeconds = Math.round(dubbedSeconds);
    s.translatedVideos = transVideoIds.size;
    s.dubbedVideos = dubbedVideoIds.size;

    s.categories = CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      clearable: c.clearable,
      bytes: catBytes[c.id],
      keys: catKeys[c.id],
    })).filter((c) => c.keys > 0 || c.clearable);
    return s;
  }

  /**
   * 清理某个可清理分类的全部缓存
   * @param {string} id CATEGORIES 中的 id(仅 clearable=true 的生效)
   * @returns {Promise<number>} 删除的 key 数量
   */
  async function clearCategory(id) {
    const def = CATEGORIES.find((c) => c.id === id);
    if (!def || !def.clearable) return 0;
    const all = await chrome.storage.local.get(null);
    const doomed = Object.keys(all).filter((k) => def.prefixes.some((p) => k.indexOf(p) === 0));
    if (doomed.length) await chrome.storage.local.remove(doomed);
    return doomed.length;
  }

  globalThis.VdcStats = { collect, clearCategory, formatBytes, formatDuration };
})();
