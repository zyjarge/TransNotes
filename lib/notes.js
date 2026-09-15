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

  /** 单次 chat 请求,返回 { content(已剥离思考链), finishReason } */
  async function chatOnce(ai, system, userContent, maxTokens) {
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
        // 设置页「关闭思考/推理模式」:MiniMax M2.5+/M3 等支持,关闭后思考链不再占用输出额度
        ...(ai.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`AI 接口返回 ${resp.status}:${detail.slice(0, 200)}`);
    }
    const json = await resp.json();
    const choice = json.choices && json.choices[0];
    let content = choice && choice.message ? choice.message.content : '';
    // 推理模型(如 MiniMax 部分 model)会在正文前输出 <think>…</think> 思考链,剥离;
    // 思考链被 max_tokens 截断(无闭合标签)时整段都是思考,剥后为空
    content = String(content || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^\s*<think>[\s\S]*$/, '')
      .trim();
    return { content, finishReason: (choice && choice.finish_reason) || '' };
  }

  /**
   * OpenAI 兼容 chat 调用(概览与自动笔记共用;与翻译同一家 provider)。
   * 推理模型的思考链同样占输出额度:剥后正文为空且 finish_reason=length
   * 说明额度被思考链吃光(长视频尤甚),自动翻倍额度重试(最多 3 次,上限 32768)
   * @returns {Promise<string>} 模型输出文本
   */
  async function aiChat(ai, system, userContent, { maxTokens = 8192 } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const budget = Math.min(maxTokens * Math.pow(2, attempt), 32768);
      const r = await chatOnce(ai, system, userContent, budget);
      if (r.content) return r.content;
      if (r.finishReason !== 'length') break; // 非额度截断,重试无意义
    }
    throw new Error('AI 返回内容为空(推理模型的思考链可能耗尽了输出额度,请重试或换非推理模型)');
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

  /* ---------------- 自定义模板 ----------------
   * 内置模板只读;用户可「基于此新建」改造或完全新建。
   * 自定义模板存 chrome.storage.local 的 customTemplates 数组,
   * id 以 custom: 开头;getAllTemplates() 是唯一读取入口(内置+自定义合并)。
   */

  const CUSTOM_TPL_KEY = 'customTemplates';

  /** 全部模板:{ id: { id, name, desc, prompt, builtin } } */
  async function getAllTemplates() {
    const stored = await chrome.storage.local.get(CUSTOM_TPL_KEY);
    const custom = Array.isArray(stored[CUSTOM_TPL_KEY]) ? stored[CUSTOM_TPL_KEY] : [];
    const all = {};
    for (const [id, t] of Object.entries(NOTE_TEMPLATES)) {
      all[id] = { id, name: t.name, desc: t.desc || '', prompt: t.prompt, builtin: true };
    }
    for (const t of custom) {
      if (t && t.id) {
        all[t.id] = {
          id: t.id,
          name: t.name || t.id,
          desc: t.desc || '',
          prompt: t.prompt || '',
          builtin: false,
        };
      }
    }
    return all;
  }

  /** 新建/更新自定义模板(有 id 为更新) */
  async function saveCustomTemplate(t) {
    const stored = await chrome.storage.local.get(CUSTOM_TPL_KEY);
    const list = Array.isArray(stored[CUSTOM_TPL_KEY]) ? stored[CUSTOM_TPL_KEY] : [];
    const name = String(t.name || '').trim();
    const prompt = String(t.prompt || '').trim();
    if (!name) throw new Error('模板名称不能为空');
    if (!prompt) throw new Error('提示词不能为空');
    if (t.id) {
      const idx = list.findIndex((x) => x.id === t.id);
      if (idx < 0) throw new Error('模板不存在');
      list[idx] = Object.assign({}, list[idx], {
        name, desc: String(t.desc || '').trim(), prompt, updatedAt: Date.now(),
      });
    } else {
      list.push({
        id: 'custom:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name, desc: String(t.desc || '').trim(), prompt, createdAt: Date.now(),
      });
    }
    await chrome.storage.local.set({ [CUSTOM_TPL_KEY]: list });
  }

  /** 删除自定义模板;当前默认模板不可删(需先把默认切换到其他模板) */
  async function deleteCustomTemplate(id) {
    const { options } = await chrome.storage.local.get('options');
    if (options && options.noteTemplate === id) {
      throw new Error('该模板是当前默认笔记模板,请先把默认模板切换为其他模板再删除');
    }
    const stored = await chrome.storage.local.get(CUSTOM_TPL_KEY);
    const list = Array.isArray(stored[CUSTOM_TPL_KEY]) ? stored[CUSTOM_TPL_KEY] : [];
    await chrome.storage.local.set({ [CUSTOM_TPL_KEY]: list.filter((x) => x.id !== id) });
  }

  /* ---------------- 自动笔记(学习笔记模板) ---------------- */

  const ANOTE_PREFIX = 'anote:';

  /**
   * 内置学习笔记模板库(只读;用户自定义模板存 customTemplates,见 getAllTemplates)。
   * 每个模板一个 system prompt,输出中文 Markdown;
   * 统一要求:要点带 [mm:ss] 时间戳(取自字幕行首,供侧边栏点击跳回视频)。
   * 新增内置模板 = 在 NOTE_TEMPLATES 加一项;用户模板走设置页,无需改代码。
   */
  const NOTE_TEMPLATES = {
    cornell: {
      name: '康奈尔笔记',
      desc: '要点 + 自测问题 + 总结,适合系统学习与复习',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用康奈尔笔记法输出中文学习笔记,Markdown 格式,包含三节:\n' +
        '## 笔记栏 — 按视频顺序组织要点,每个要点带时间戳 [mm:ss],可用多级列表展开细节\n' +
        '## 线索栏 — 5-10 个关键词或自测问题(学习者可盖住笔记栏自我测试)\n' +
        '## 总结栏 — 3-5 句话概括全视频核心内容\n' +
        '要求:时间戳必须取自字幕行首的 [mm:ss],不得编造;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
    outline: {
      name: '大纲笔记',
      desc: '层级大纲梳理内容结构,适合快速把握全貌',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用大纲笔记法输出中文学习笔记,Markdown 格式:\n' +
        '按「## 主主题 → ### 子主题 → - 要点」的层级组织全视频内容,要点带时间戳 [mm:ss]。\n' +
        '要求:层级反映内容的真实逻辑结构,不要把所有内容平铺;时间戳取自字幕行首;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
    feynman: {
      name: '费曼讲解',
      desc: '大白话讲透每个概念,适合入门陌生领域',
      prompt:
        '你是专业的学习助手。根据带时间戳的视频字幕,用费曼学习法输出中文学习笔记,Markdown 格式:\n' +
        '假设要把视频内容讲给一个聪明但完全不懂该领域的朋友听,用大白话讲清每个核心概念。\n' +
        '每个概念一节:## 概念名 → 「是什么」→「为什么重要」→「一个例子」,关键处带时间戳 [mm:ss]。\n' +
        '最后一节 ## 还没讲透的地方:列出字幕中语焉不详、需要进一步查证或思考的点(作为自测清单)。\n' +
        '要求:避免术语堆砌,必须落到自己的话;时间戳取自字幕行首;直接输出 Markdown,不要 JSON,不要代码围栏。',
    },
    zettelkasten: {
      name: '卡片盒笔记',
      desc: '原子概念卡片 + 关联,适合长期知识积累',
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
    const all = await getAllTemplates();
    const tpl = all[template] ? template : DEFAULT_TEMPLATE;
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

    // 自定义模板在 prompt 后附加硬性规则(时间戳/输出格式),降低翻车率;内置模板已自带
    const tplDef = all[tpl];
    const prompt = tplDef.builtin ? tplDef.prompt
      : tplDef.prompt +
        '\n硬性要求:要点时间戳必须取自字幕行首的 [mm:ss],不得编造;' +
        '直接输出 Markdown,不要代码围栏,不要输出额外解释。';
    let md = await aiChat(ai, prompt, userContent, { maxTokens: 8192 });
    // 容忍模型包了一层 ```markdown 围栏
    md = md.replace(/^\s*```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const result = { md, template: tpl, generatedAt: Date.now() };
    await chrome.storage.local.set({
      [key]: result,
      // 记录该视频最近生成的模板:草稿导出的默认模板可能与之不同(侧边栏可临时换模板),
      // 生成草稿时据此回退查找,避免"明明生成过却提示未生成"
      [`${ANOTE_PREFIX}last:${videoKey}`]: tpl,
    });
    return result;
  }

  /** 读取缓存的自动笔记;未生成返回 null。template 为任意合法模板 id(含自定义) */
  async function getAutoNote(videoKey, template) {
    const tpl = template || DEFAULT_TEMPLATE;
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
    const { overview, autoNote, autoNoteTemplate } = opts || {};
    // 兼容旧参数:includeBilingual 等价于 sections.subtitles
    const sections = Object.assign(
      { meta: true, overview: true, notes: true, autoNote: true, qa: true, subtitles: true },
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
      // 标题始终标注模板:已生成显示实际所用模板;未生成显示将会使用的(默认)模板
      const allTpl = await getAllTemplates();
      const tplName = autoNote && allTpl[autoNote.template]
        ? allTpl[autoNote.template].name
        : (allTpl[autoNoteTemplate] || allTpl[DEFAULT_TEMPLATE]).name;
      out.push(`## 自动笔记(模板:${tplName})`);
      out.push('');
      if (autoNote && autoNote.md) {
        out.push(autoNote.md);
        out.push('');
      } else {
        out.push('(未生成——请在侧边栏「笔记」页签选择模板后点「生成笔记」)');
        out.push('');
      }
    }

    // 助教问答(观看中向 AI 助教提的问,按视频时间戳排序)
    if (sections.qa) {
      const qaList = await VdcCache.getQA(videoKey);
      if (qaList.length) {
        out.push('## 助教问答');
        out.push('');
        for (const qa of qaList) {
          out.push(`- **[${fmtTime(qa.ts)}] ${qa.question}**`);
          out.push(`  ${String(qa.answer || '').replace(/\n/g, '\n  ')}`);
          out.push('');
        }
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
   *   自动笔记只读缓存,不为导出额外调 AI;autoNoteTemplate(默认模板)未命中时
   *   回退到该视频最近生成的模板(侧边栏可临时换模板生成)
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
    let autoNote = wantAutoNote ? await getAutoNote(videoKey, autoNoteTemplate) : null;
    if (wantAutoNote) {
      // 默认模板没命中或不是最新时,回退查找其他模板的缓存(缓存按 视频×模板 分键,
      // 侧边栏可临时换模板生成):优先该视频最近生成的模板(last 指针);
      // last 指针是后加的,存量数据没有,故再兜底遍历全部模板(含自定义)
      const lastKey = `${ANOTE_PREFIX}last:${videoKey}`;
      const lastTpl = (await chrome.storage.local.get(lastKey))[lastKey];
      const allTplIds = Object.keys(await getAllTemplates());
      const candidates = [...new Set(
        [lastTpl, ...allTplIds].filter((t) => t && t !== autoNoteTemplate)
      )];
      for (const tpl of candidates) {
        const other = await getAutoNote(videoKey, tpl);
        if (other && (!autoNote || (other.generatedAt || 0) > (autoNote.generatedAt || 0))) {
          autoNote = other;
        }
      }
    }
    const md = await buildMarkdown(videoKey, { overview, sections, autoNote, autoNoteTemplate });
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
    getAllTemplates,
    saveCustomTemplate,
    deleteCustomTemplate,
    buildMarkdown,
    generateDraft,
    saveDraft,
    getDraft,
    aiChat,
  };
})();
