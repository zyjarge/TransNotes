/**
 * 助教:观看中就知识点向文本大模型提问(Background 使用)
 *
 * 上下文构造:视频标题 + AI 概览(全片结构)+ 提问时间点前后的双语字幕
 * + 最近几条问答历史(支持追问)+ 用户问题。提示词允许补充视频外的背景
 * 知识(如数学概念),但要求明确标注,防止把补充内容误认为视频内容。
 *
 * 问答经 VdcCache(addQA/getQA)持久化,导出草稿时并入「助教问答」章节。
 * 通过 globalThis.VdcTutor 暴露。依赖 VdcCache / VdcNotes(aiChat/getOverview)。
 */
(function () {
  'use strict';

  const CONTEXT_WINDOW_SEC = 60;  // 提问时间点前后各取多少秒字幕
  const HISTORY_COUNT = 3;        // 带入上下文的最近问答条数(支持追问)
  const MAX_CONTEXT_CHARS = 6000; // 字幕上下文长度上限

  const SYSTEM_PROMPT =
    '你是用户正在观看的视频的助教。用户会在观看中就对视频内容或相关背景知识提问。\n' +
    '要求:\n' +
    '1) 优先基于提供的视频字幕上下文回答;引用视频内容时带上行首的 [mm:ss] 时间戳\n' +
    '2) 如果问题涉及视频没讲透的背景知识(如数学/编程概念),直接用你的知识补充讲解,' +
    '并用一句话明确标注「(补充知识,非视频内容)」\n' +
    '3) 用简体中文,表达清晰口语化,像助教当面讲解;可适当用 Markdown 列表/公式,但不要过长\n' +
    '4) 不确定的内容明说,不要编造视频中没有的信息';

  /** 组装提问上下文文本 */
  async function buildContext(videoKey, t, question) {
    const doc = await VdcCache.getSubtitles(videoKey);
    const overview = await VdcNotes.getOverview(videoKey).catch(() => null);
    const parts = [];

    parts.push(`视频标题:${(doc && doc.title) || '未知'}`);

    if (overview && overview.chapters && overview.chapters.length) {
      const chs = overview.chapters
        .map((c) => `[${c.timestamp || ''}] ${c.title || ''}:${c.summary || ''}`)
        .join('\n');
      parts.push(`\n全片章节概览:\n${chs}`);
    }

    // 提问时间点前后的字幕(中文优先)
    const cues = (doc && doc.cues) || [];
    const win = cues.filter((c) => c.end > t - CONTEXT_WINDOW_SEC && c.start < t + CONTEXT_WINDOW_SEC);
    if (win.length) {
      let lines = win.map((c) => `[${VdcNotes.fmtTime(c.start)}] ${c.zh || c.text}`).join('\n');
      if (lines.length > MAX_CONTEXT_CHARS) {
        lines = lines.slice(0, MAX_CONTEXT_CHARS) + '\n[...] 上下文过长,已截断';
      }
      parts.push(`\n用户当前播放到 [${VdcNotes.fmtTime(t)}],前后字幕:\n${lines}`);
    } else {
      parts.push(`\n用户当前播放到 [${VdcNotes.fmtTime(t)}],该时段无字幕。`);
    }

    // 最近问答历史(追问不断片)
    const history = await VdcCache.getQA(videoKey);
    const recent = history.slice(-HISTORY_COUNT);
    if (recent.length) {
      const h = recent.map((q) => `问:${q.question}\n答:${q.answer}`).join('\n\n');
      parts.push(`\n最近的问答历史:\n${h}`);
    }

    parts.push(`\n用户的问题:${question}`);
    return parts.join('\n');
  }

  /**
   * 提问并持久化问答
   * @param {string} videoKey
   * @param {string} question 用户问题
   * @param {number} t 提问时视频播放位置(秒)
   * @param {object} ai { baseUrl, apiKey, model, disableThinking }
   * @param {object} [opts] { image } 提问时刻的视频画面截图 dataURL(视觉模型可用时携带)
   * @returns {Promise<object>} 问答记录 { id, ts, question, answer, shot?, createdAt }
   */
  async function ask(videoKey, question, t, ai, opts) {
    const q = String(question || '').trim();
    if (!q) throw new Error('问题不能为空');
    if (!ai || !ai.apiKey) throw new Error('AI API Key 未配置,请在设置页填写文本模型(助教与翻译共用)');
    const image = opts && opts.image;
    let userContent = await buildContext(videoKey, typeof t === 'number' ? t : 0, q);
    if (image) {
      userContent += '\n\n(用户附上了提问时刻的视频画面截图,请结合画面内容回答)';
    }
    const answer = await VdcNotes.aiChat(ai, SYSTEM_PROMPT, userContent, { maxTokens: 4096, image });
    const qa = {
      id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: typeof t === 'number' ? t : 0,
      question: q,
      answer,
      createdAt: Date.now(),
    };
    // 截图随问答存档(导出时进 attachments;侧栏可回看当时画面)
    if (image) {
      const shotId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        await VdcCache.saveShot(shotId, image);
        qa.shot = shotId;
      } catch (e) { /* 存储失败不影响问答本身 */ }
    }
    await VdcCache.addQA(videoKey, qa);
    return qa;
  }

  globalThis.VdcTutor = { ask, buildContext };
})();
