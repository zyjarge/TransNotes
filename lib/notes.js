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

  /* ---------------- AI 调用公共件 ---------------- */

  /**
   * OpenAI 兼容 chat 调用(概览与自动笔记共用;与翻译同一家 provider)
   * @returns {Promise<string>} 模型输出文本
   */
  async function aiChat(ai, system, userContent, { maxTokens = 4096 } = {}) {
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
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`AI 接口返回 ${resp.status}:${detail.slice(0, 200)}`);
    }
    const json = await resp.json();
    const content = json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    if (!content) throw new Error('AI 返回内容为空');
    return content;
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

  /**
   * 摘要粒度:concise 简洁 / normal 普通(默认)/ detailed 详细。
   * 影响章节数量、摘要长度与关键引述条数。
   */
  const LEVEL_GUIDE = {
    concise: '章节控制在 3-5 个,每章摘要一句话;关键引述选 3 条',
    normal: '章节按内容自然划分,每章摘要 1-2 句;关键引述选 3-5 条',
    detailed: '章节尽量细分(8 个以上也可),每章摘要 2-3 句;关键引述选 5-8 条',
  };

  function overviewSystemPrompt(level) {
    const guide = LEVEL_GUIDE[level] || LEVEL_GUIDE.normal;
    return (
      '你是我的学习助手。我会给你一段带时间戳的视频字幕(可能是中文或英文),' +
      '请输出一份中文结构化概览,要求:\n' +
      `1) 章节:${guide};章节必须覆盖整个视频从头到尾,` +
      '最后一章必须覆盖到视频后段,不要只集中在开头\n' +
      '2) 关键引述:挑选有独特见解、反常识观点、惊人事实或精彩表达的句子;' +
      '若字幕是英文请翻译为中文并稍作润色(修口语重复、补标点),保留说话者的原意\n' +
      '3) 时间戳必须取自字幕行首的 [M:SS],不得编造,不得超过视频时长\n' +
      '只输出 JSON(不要 markdown 代码围栏),格式:\n' +
      '{"chapters":[{"title":"章节标题","timestamp":"0:00","timestampSeconds":0,"summary":"本节内容"}],' +
      '"keyQuotes":[{"quote":"引述","timestamp":"2:30","timestampSeconds":150}]}'
    );
  }

  /**
   * 生成 AI 概览(带缓存;force=true 或粒度设置变化时重新生成)
   * @param {string} videoKey
   * @param {object} ai { baseUrl, apiKey, model } 与翻译同一家 provider
   * @param {boolean} force
   * @param {string} [level] 摘要粒度 concise|normal|detailed
   * @returns {Promise<object>} { chapters, keyQuotes, level }
   */
  async function generateOverview(videoKey, ai, force, level) {
    const lv = LEVEL_GUIDE[level] ? level : 'normal';
    const key = OV_PREFIX + videoKey;
    if (!force) {
      const cached = await chrome.storage.local.get(key);
      // 粒度设置变了:缓存失效,按新粒度重建
      if (cached[key] && (cached[key].level || 'normal') === lv) return cached[key];
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

    let content = await aiChat(ai, overviewSystemPrompt(lv), userContent);
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
    overview.level = lv; // 记录粒度,设置变化时缓存自动失效
    await chrome.storage.local.set({ [key]: overview });
    return overview;
  }

  /* ---------------- 自动笔记(学习笔记模板) ---------------- */

  const ANOTE_PREFIX = 'anote:';

  /**
   * 学习笔记模板库。每个模板一个 system prompt,输出中文 Markdown;
   * 统一要求:要点带 [mm:ss] 时间戳(取自字幕行首,供侧边栏点击跳回视频)。
   * 新增模板 = 在 NOTE_TEMPLATES 加一项 + 设置页/侧边栏下拉加一项。
   */
  const NOTE_TEMPLATES = {
    cornell: {
      name: '康奈尔笔记',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用康奈尔笔记法输出中文学习笔记,Markdown 格式,包含三节:\n' +
        '## 笔记栏 — 按视频顺序组织要点,每个要点带时间戳 [mm:ss],可用多级列表展开细节\n' +
        '## 线索栏 — 5-10 个关键词或自测问题(学习者可盖住笔记栏自我测试)\n' +
        '## 总结栏 — 3-5 句话概括全视频核心内容\n' +
        '要求:时间戳必须取自字幕行首的 [mm:ss],不得编造;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
    outline: {
      name: '大纲笔记',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用大纲笔记法输出中文学习笔记,Markdown 格式:\n' +
        '按「## 主主题 → ### 子主题 → - 要点」的层级组织全视频内容,要点带时间戳 [mm:ss]。\n' +
        '要求:层级反映内容的真实逻辑结构,不要把所有内容平铺;时间戳取自字幕行首;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
    feynman: {
      name: '费曼讲解',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用费曼学习法输出中文学习笔记,Markdown 格式:\n' +
        '假设要把视频内容讲给一个聪明但完全不懂该领域的朋友听,用大白话讲清每个核心概念。\n' +
        '每个概念一节:## 概念名 → 「是什么」→「为什么重要」→「一个例子」,关键处带时间戳 [mm:ss]。\n' +
        '最后一节 ## 还没讲透的地方:列出字幕中语焉不详、需要进一步查证或思考的点(作为自测清单)。\n' +
        '要求:避免术语堆砌,必须落到自己的话;时间戳取自字幕行首;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
    zettelkasten: {
      name: '卡片盒笔记',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用卡片盒(Zettelkasten)方法输出中文学习笔记,Markdown 格式:\n' +
        '把内容拆成若干张原子化概念卡片,每张卡片一个且只有一个概念,独立可懂:\n' +
        '### 卡片标题(概念名)\n- 正文:用自己的话写清这个概念(2-4 句)\n- 关联:[[相关概念名]](没有可省)\n- 来源:[mm:ss]\n' +
        '要求:卡片按逻辑顺序排列;时间戳取自字幕行首;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
  };

  const DEFAULT_TEMPLATE = 'cornell';

  /**
   * 生成自动笔记(带缓存;force=true 强制重新生成;按模板分别缓存)
   * @param {string} videoKey
   * @param {object} ai { baseUrl, apiKey, model } 与翻译同一家 provider
   * @param {object} opts { template, force }
   * @returns {Promise<object>} { md, template, generatedAt }
   */
  async function generateAutoNote(videoKey, ai, opts) {
    const { template, force } = opts || {};
    const tpl = NOTE_TEMPLATES[template] ? template : DEFAULT_TEMPLATE;
    const key = `${ANOTE_PREFIX}${videoKey}:${tpl}`;
    if (!force) {
      const cached = await chrome.storage.local.get(key);
      if (cached[key]) return cached[key];
    }
    if (!ai || !ai.apiKey) throw new Error('AI API Key 未配置,请在设置页填写翻译 API(笔记与翻译共用)');

    const doc = await VdcCache.getSubtitles(videoKey);
    if (!doc || !doc.cues || !doc.cues.length) {
      throw new Error('没有可用的字幕缓存,请先在视频页等待字幕抓取完成');
    }
    const duration = doc.cues[doc.cues.length - 1].end;
    const userContent =
      `视频标题:${doc.title || '未知'}\n` +
      `视频时长:${fmtTime(duration)}(${Math.floor(duration)} 秒),不要使用超过此时长的时间戳\n\n` +
      `字幕:\n${buildTranscript(doc)}`;

    let md = await aiChat(ai, NOTE_TEMPLATES[tpl].prompt, userContent, { maxTokens: 4096 });
    // 容忍模型包了一层 ```markdown 围栏
    md = md.replace(/^\s*```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const result = { md, template: tpl, generatedAt: Date.now() };
    await chrome.storage.local.set({ [key]: result });
    return result;
  }

  /** 读取缓存的自动笔记;未生成返回 null */
  async function getAutoNote(videoKey, template) {
    const tpl = NOTE_TEMPLATES[template] ? template : DEFAULT_TEMPLATE;
    const stored = await chrome.storage.local.get(`${ANOTE_PREFIX}${videoKey}:${tpl}`);
    return stored[`${ANOTE_PREFIX}${videoKey}:${tpl}`] || null;
  }

  /* ---------------- Markdown 草稿 ---------------- */

  /**
   * 组装 Markdown 笔记草稿
   * @param {string} videoKey
   * @param {object} opts { overview, sections, autoNote }
   *   sections: { meta, overview, notes, autoNote, subtitles } 对应设置页「导出笔记包含内容」,
   *   缺省全部为 true(向后兼容旧的 includeBilingual 用法);
   *   autoNote: generateAutoNote 的结果 { md, template },由调用方读缓存传入(不重调 AI)
   * @returns {Promise<string>} markdown 文本
   */
  async function buildMarkdown(videoKey, opts) {
    const { overview, autoNote } = opts || {};
    // 兼容旧参数:includeBilingual 等价于 sections.subtitles
    const sections = Object.assign(
      { meta: true, overview: true, notes: true, autoNote: true, subtitles: true },
      opts && opts.sections ? opts.sections
        : opts && opts.includeBilingual === false ? { subtitles: false } : {}
    );
    const doc = await VdcCache.getSubtitles(videoKey);
    const notes = await VdcCache.getNotes(videoKey);
    const title = (doc && doc.title) || videoKey;
    const cues = (doc && doc.cues) || [];
    const duration = cues.length ? cues[cues.length - 1].end : 0;
    const date = new Date().toISOString().slice(0, 10);

    const out = [];
    if (sections.meta) {
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
    }

    // AI 概览
    if (sections.overview) {
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
    }

    // 时间戳笔记
    if (sections.notes) {
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
    }

    // 自动笔记(学习笔记模板;内容来自缓存,不在此处调 AI)
    if (sections.autoNote) {
      const tplName = autoNote && NOTE_TEMPLATES[autoNote.template]
        ? NOTE_TEMPLATES[autoNote.template].name : '';
      out.push(`## 自动笔记${tplName ? `(${tplName})` : ''}`);
      out.push('');
      if (autoNote && autoNote.md) {
        out.push(autoNote.md);
        out.push('');
      } else {
        out.push('(未生成——请在侧边栏「笔记」页签选择模板后点「生成笔记」)');
        out.push('');
      }
    }

    // 双语字幕
    if (sections.subtitles && cues.length) {
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
   * 一键生成草稿:AI 概览 + 时间戳笔记 + 自动笔记(读缓存)+ 双语字幕,写入 draft:{videoKey}
   * @param {string} videoKey
   * @param {object} ai 翻译 provider 配置
   * @param {object} opts { forceOverview, sections, level, autoNoteTemplate }
   *   sections 同 buildMarkdown;sections.overview === false 时跳过 AI 概览调用;
   *   自动笔记只读缓存(autoNoteTemplate 指定的模板),不为导出额外调 AI
   * @returns {Promise<string>} markdown
   */
  async function generateDraft(videoKey, ai, opts) {
    const { forceOverview, sections, level, autoNoteTemplate } = opts || {};
    // 导出内容不含摘要时跳过概览生成,不白调一次 AI
    const wantOverview = !sections || sections.overview !== false;
    const overview = wantOverview
      ? await generateOverview(videoKey, ai, !!forceOverview, level)
      : null;
    const wantAutoNote = !sections || sections.autoNote !== false;
    const autoNote = wantAutoNote ? await getAutoNote(videoKey, autoNoteTemplate) : null;
    const md = await buildMarkdown(videoKey, { overview, sections, autoNote });
    await saveDraft(videoKey, md);
    return md;
  }

  globalThis.VdcNotes = {
    fmtTime,
    safeFileName,
    generateOverview,
    getOverview,
    generateAutoNote,
    getAutoNote,
    NOTE_TEMPLATES,
    DEFAULT_TEMPLATE,
    buildMarkdown,
    generateDraft,
    saveDraft,
    getDraft,
  };
})();
