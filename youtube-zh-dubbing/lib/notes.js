/**
 * 笔记整合:AI 概览生成 + Markdown 草稿组装
 *
 * - AI 概览复用翻译的同一家 OpenAI 兼容 provider(默认 DeepSeek),不重复引入供应商;
 *   prompt 改造自 youtube-digest 的 analysis prompt(章节覆盖全片 + 关键引述,输出 JSON)
 * - 字幕/笔记数据全部来自共享缓存 VdcCache(配音译文直接复用,不重调 AI)
 * - 生成的概览缓存于 oview:{videoKey},草稿存于 draft:{videoKey}
 * - 截图在 Markdown 中以相对路径 attachments/{shotId}.jpg 引用,由导出器写入 vault
 *
 * 在 Background(importScripts)与侧边栏(script 标签)中均可使用,需先加载 lib/cache.js。
 */
(function () {
  'use strict';

  const OV_PREFIX = 'oview:';
  const DRAFT_PREFIX = 'draft:';
  const TRANSCRIPT_CHAR_LIMIT = 24000; // 喂给模型的字幕文本上限(超长截断)

  /* ---------------- 工具 ---------------- */

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
  }

  /** YAML 字符串安全转义(双引号包裹) */
  function yamlStr(s) {
    return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /** 文件名清洗:去掉 Windows/macOS 非法字符 */
  function safeFileName(title) {
    const t = String(title || '未命名视频')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return t || '未命名视频';
  }

  /* ---------------- AI 概览 ---------------- */

  /** 字幕文档 → 带时间戳的转录文本(中文优先,超长截断) */
  function buildTranscript(doc) {
    const lines = [];
    let total = 0;
    for (const c of doc.cues || []) {
      const line = `[${fmtTime(c.start)}] ${c.zh || c.text}`;
      if (total + line.length > TRANSCRIPT_CHAR_LIMIT) {
        lines.push(`[...] 后续 ${doc.cues.length - lines.length} 句因长度限制省略`);
        break;
      }
      lines.push(line);
      total += line.length;
    }
    return lines.join('\n');
  }

  const OVERVIEW_SYSTEM =
    '你是我的学习助手。我会给你一段带时间戳的视频字幕(可能是中文或英文),' +
    '请输出一份中文结构化概览,要求:\n' +
    '1) 章节:覆盖整个视频从头到尾,在话题自然切换处划分,数量由内容决定;' +
    '最后一章必须覆盖到视频后段,不要只集中在开头\n' +
    '2) 关键引述:3-5 条,挑选有独特见解、反常识观点、惊人事实或精彩表达的句子;' +
    '若字幕是英文请翻译为中文并稍作润色(修口语重复、补标点),保留说话者的原意\n' +
    '3) 时间戳必须取自字幕行首的 [M:SS],不得编造,不得超过视频时长\n' +
    '只输出 JSON(不要 markdown 代码围栏),格式:\n' +
    '{"chapters":[{"title":"章节标题","timestamp":"0:00","timestampSeconds":0,"summary":"本节内容"}],' +
    '"keyQuotes":[{"quote":"引述","timestamp":"2:30","timestampSeconds":150}]}';

  /**
   * 生成 AI 概览(带缓存;force=true 强制重新生成)
   * @param {string} videoKey
   * @param {object} ai { baseUrl, apiKey, model } 与翻译同一家 provider
   * @returns {Promise<object>} { chapters, keyQuotes }
   */
  async function generateOverview(videoKey, ai, force) {
    const key = OV_PREFIX + videoKey;
    if (!force) {
      const cached = await chrome.storage.local.get(key);
      if (cached[key]) return cached[key];
    }
    if (!ai || !ai.apiKey) throw new Error('AI API Key 未配置,请在设置页填写翻译 API(概览与翻译共用)');

    const doc = await VdcCache.getSubtitles(videoKey);
    if (!doc || !doc.cues || !doc.cues.length) {
      throw new Error('没有可用的字幕缓存,请先开一次配音(或抓取字幕)');
    }
    const duration = doc.cues[doc.cues.length - 1].end;
    const userContent =
      `视频标题:${doc.title || '未知'}\n` +
      `视频时长:${fmtTime(duration)}(${Math.floor(duration)} 秒),不要使用超过此时长的时间戳\n\n` +
      `字幕:\n${buildTranscript(doc)}`;

    const endpoint = String(ai.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: OVERVIEW_SYSTEM },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`AI 概览接口返回 ${resp.status}:${detail.slice(0, 200)}`);
    }
    const json = await resp.json();
    let content = json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    if (!content) throw new Error('AI 概览返回内容为空');
    // 容忍模型包了一层 ```json 围栏
    content = content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    let overview;
    try {
      overview = JSON.parse(content);
    } catch (e) {
      throw new Error('AI 概览返回的 JSON 解析失败,请重试');
    }
    if (!Array.isArray(overview.chapters)) overview.chapters = [];
    if (!Array.isArray(overview.keyQuotes)) overview.keyQuotes = [];
    await chrome.storage.local.set({ [key]: overview });
    return overview;
  }

  /* ---------------- Markdown 草稿 ---------------- */

  /**
   * 组装 Markdown 笔记草稿
   * @param {string} videoKey
   * @param {object} opts { overview, includeBilingual }
   * @returns {Promise<string>} markdown 文本
   */
  async function buildMarkdown(videoKey, opts) {
    const { overview, includeBilingual } = opts || {};
    const doc = await VdcCache.getSubtitles(videoKey);
    const notes = await VdcCache.getNotes(videoKey);
    const title = (doc && doc.title) || videoKey;
    const cues = (doc && doc.cues) || [];
    const duration = cues.length ? cues[cues.length - 1].end : 0;
    const date = new Date().toISOString().slice(0, 10);

    const out = [];
    out.push('---');
    out.push(`title: ${yamlStr(title)}`);
    out.push(`url: ${yamlStr((doc && doc.url) || '')}`);
    out.push(`site: ${yamlStr((doc && doc.site) || '')}`);
    out.push(`duration: ${yamlStr(fmtTime(duration))}`);
    out.push(`date: ${date}`);
    out.push('tags: [视频笔记, 待整理]');
    out.push('---');
    out.push('');
    out.push(`# ${title}`);
    out.push('');

    // AI 概览
    out.push('## AI 概览');
    out.push('');
    if (overview && overview.chapters && overview.chapters.length) {
      out.push('### 章节');
      out.push('');
      for (const ch of overview.chapters) {
        out.push(`- **${ch.timestamp || ''} ${ch.title || ''}** — ${ch.summary || ''}`);
      }
      out.push('');
    }
    if (overview && overview.keyQuotes && overview.keyQuotes.length) {
      out.push('### 关键引述');
      out.push('');
      for (const q of overview.keyQuotes) {
        out.push(`> ${q.quote || ''}(${q.timestamp || ''})`);
        out.push('');
      }
    }
    if (!overview) {
      out.push('(未生成概览)');
      out.push('');
    }

    // 时间戳笔记
    out.push('## 我的时间戳笔记');
    out.push('');
    if (notes.length === 0) {
      out.push('(观看中没有记录笔记)');
      out.push('');
    }
    for (const n of notes) {
      out.push(`### ${fmtTime(n.ts)}`);
      out.push('');
      const quote = n.zh || n.text;
      if (quote) {
        out.push(`> ${quote}`);
        out.push('');
      }
      if (n.comment) {
        out.push(n.comment);
        out.push('');
      }
      if (n.shot) {
        out.push(`![](attachments/${n.shot}.jpg)`);
        out.push('');
      }
    }

    // 双语字幕(可选)
    if (includeBilingual && cues.length) {
      out.push('## 双语字幕');
      out.push('');
      for (const c of cues) {
        out.push(`**[${fmtTime(c.start)}]** ${c.zh || ''}`);
        if (c.zh && c.text && c.zh !== c.text) out.push(`> ${c.text}`);
        out.push('');
      }
    }

    return out.join('\n');
  }

  /* ---------------- 草稿存取 ---------------- */

  /** 读取缓存的 AI 概览;未生成返回 null */
  async function getOverview(videoKey) {
    const stored = await chrome.storage.local.get(OV_PREFIX + videoKey);
    return stored[OV_PREFIX + videoKey] || null;
  }

  async function saveDraft(videoKey, md) {
    await chrome.storage.local.set({
      [DRAFT_PREFIX + videoKey]: { md, updatedAt: Date.now() },
    });
  }

  async function getDraft(videoKey) {
    const stored = await chrome.storage.local.get(DRAFT_PREFIX + videoKey);
    return stored[DRAFT_PREFIX + videoKey] || null;
  }

  /**
   * 一键生成草稿:AI 概览 + 时间戳笔记 + 双语字幕,写入 draft:{videoKey}
   * @param {string} videoKey
   * @param {object} ai 翻译 provider 配置
   * @param {object} opts { forceOverview, includeBilingual }
   * @returns {Promise<string>} markdown
   */
  async function generateDraft(videoKey, ai, opts) {
    const { forceOverview, includeBilingual } = opts || {};
    const overview = await generateOverview(videoKey, ai, !!forceOverview);
    const md = await buildMarkdown(videoKey, { overview, includeBilingual: includeBilingual !== false });
    await saveDraft(videoKey, md);
    return md;
  }

  globalThis.VdcNotes = {
    fmtTime,
    safeFileName,
    generateOverview,
    getOverview,
    buildMarkdown,
    generateDraft,
    saveDraft,
    getDraft,
  };
})();
