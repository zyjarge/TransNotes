/**
 * 翻译 API 封装(OpenAI 兼容 Chat Completions 接口)
 *
 * base_url / api_key / model 均为设置项,默认指向 DeepSeek,用户可替换为任意兼容服务。
 * 翻译策略:整批分块(每块 BATCH_SIZE 句),按行返回一一对应的译文。
 *
 * 行数不符容错(模型偶尔会把相邻碎句合并成一行,导致少行):
 *   1. 重试一次(模型输出有随机性,重试多半能恢复)
 *   2. 仍不符则拆半递归(块越小越不容易合并;拆到单句必然无法再合并)
 *   3. 单句仍对不上时,取模型全部非空行拼接兜底(单句不存在译文错位风险)
 */
(function () {
  'use strict';

  const BATCH_SIZE = 25;

  const SYSTEM_PROMPT =
    '你是一名专业的中英翻译。请将用户提供的英文字幕逐行翻译为简体中文,' +
    '要求:1) 忠实通顺,符合中文口语习惯,不要生硬直译;2) 专业术语保留英文原词并附中文;' +
    '3) 严格按输入顺序逐行返回译文,每行格式为「序号: 译文」,序号与输入一一对应,不得合并或拆分行;' +
    '4) 除了序号和译文,不要输出任何其他内容、解释或标点装饰。';

  // 翻译+口语化润色合并(英文通道:一次调用完成,省一次 LLM 往返)
  const POLISH_SYSTEM_PROMPT =
    '你是一名专业的中英翻译兼中文口语润色。请将用户提供的英文字幕逐行翻译为简体中文,' +
    '并直接写成自然口语,像朋友当面讲述,而不是念稿子:' +
    '1) 去除翻译腔与书面句式(如"众所周知""的是""进行了""一种…的方式"),英文长句可拆成中文短句的节奏;' +
    '2) 精简优先:每行中文尽量不长于原英文含义所需,不得为口语化堆砌语气词和废话;' +
    '3) 专业术语保留英文原词并附中文;' +
    '4) 严格按输入顺序逐行返回,每行格式为「序号: 译文」,序号与输入一一对应,不得合并或拆分行;' +
    '5) 除了序号和译文,不要输出任何其他内容、解释或标点装饰。';

  // 纯润色(中文直通通道:tlang 机翻 / B 站 ai-zh 字幕已经生硬,逐行口语化改写)
  const POLISH_ONLY_SYSTEM_PROMPT =
    '你是一名中文口语润色专家。用户提供的是机器翻译或自动生成的中文字幕,请逐行改写为自然口语:' +
    '1) 像朋友当面讲述,去除翻译腔、书面长句,可调整句式节奏;' +
    '2) 不改变原意,不增加信息;每行长度不得超过原行,尽量更短;' +
    '3) 严格按输入顺序逐行返回,每行格式为「序号: 润色后文本」,不得合并或拆分行;' +
    '4) 除了序号和润色结果,不要输出任何其他内容。';

  /** 默认的批量请求引导语(可按模式覆盖) */
  const defaultUserIntro = (n) => `以下共 ${n} 行英文字幕,请恰好输出 ${n} 行中文译文:`;

  // 行首序号:兼容「0:」「0:」「0.」「0、」「0)」等格式
  const LINE_NO_RE = /^\s*(\d+)\s*[:：.、)]\s*(.+?)\s*$/;

  /** 去掉行首序号前缀 */
  function stripLineNo(line) {
    const m = line.match(LINE_NO_RE);
    return m ? m[2] : line.trim();
  }

  /** 从模型输出中解析出与输入行数一致的译文数组 */
  function parseTranslations(content, expectedCount) {
    if (!content) return [];
    const lines = content.split('\n');

    // 方案一:按「序号: 译文」格式解析
    const numbered = [];
    for (const line of lines) {
      const m = line.match(LINE_NO_RE);
      if (m) numbered[Number(m[1])] = m[2];
    }
    if (numbered.length >= expectedCount && numbered.slice(0, expectedCount).every((x) => x)) {
      return numbered.slice(0, expectedCount);
    }

    // 方案二:按行顺序逐行对应(去掉可能的行号前缀)
    const fallback = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      fallback.push(stripLineNo(line));
    }
    if (fallback.length >= expectedCount) {
      return fallback.slice(0, expectedCount);
    }
    return fallback;
  }

  /**
   * 单次翻译请求
   * @returns {Promise<string[]>} 与输入一一对应的译文
   * @throws 行数不符的错误带 isCountMismatch 标记与 rawContent(原始输出)
   */
  async function requestTranslation(texts, { baseUrl, apiKey, model, disableThinking, systemPrompt, userIntro }) {
    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const numberedLines = texts.map((text, i) => `${i}: ${text}`).join('\n');
    // 明确告知行数,降低模型合并/漏行概率
    const userContent = (userIntro || defaultUserIntro)(texts.length) + '\n' + numberedLines;

    /** 单次请求;返回 { content(已剥离思考链), finishReason } */
    async function post(maxTokens) {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model || 'deepseek-chat',
            messages: [
              { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
              { role: 'user', content: userContent },
            ],
            temperature: 0.3,
            max_tokens: maxTokens,
            // 设置页「关闭思考/推理模式」:MiniMax M2.5+/M3 等支持
            ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
          }),
        });
      } catch (e) {
        throw new Error(`翻译请求失败:${e.message}`);
      }

      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch (_) { /* 忽略 */ }
        throw new Error(`翻译接口返回 ${response.status}:${detail.slice(0, 200)}`);
      }

      const json = await response.json();
      const choice = json.choices && json.choices[0];
      let content = choice && choice.message ? choice.message.content : '';
      // 推理模型(如 MiniMax 部分 model)会先输出 <think>…</think> 思考链,
      // 不剥离会打乱按行对应;无闭合标签说明整段都是思考,剥后为空
      content = String(content || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/^\s*<think>[\s\S]*$/, '')
        .trim();
      return { content, finishReason: (choice && choice.finish_reason) || '' };
    }

    // 推理模型的思考链也占输出额度:剥后为空且 finish_reason=length 时翻倍额度重试
    let content = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const budget = Math.min(4096 * Math.pow(2, attempt), 16384);
      const r = await post(budget);
      if (r.content) { content = r.content; break; }
      if (r.finishReason !== 'length') break;
    }
    if (!content) throw new Error('翻译接口返回内容为空');

    // 单句特判:模型可能把译文折成多行(仅首行带序号),
    // 取全部非空行拼接,避免截断(单句不存在错位风险)
    if (texts.length === 1) {
      const lines = content.split('\n').map(stripLineNo).filter(Boolean);
      if (lines.length === 0) throw new Error('翻译接口返回内容为空');
      return [lines.join('')];
    }

    const result = parseTranslations(content, texts.length);
    if (result.length !== texts.length) {
      const err = new Error(`翻译结果行数与输入不一致(期望 ${texts.length},实际 ${result.length})`);
      err.isCountMismatch = true;
      err.rawContent = content;
      throw err;
    }
    return result;
  }

  /** 分块翻译:重试 → 拆半递归 → 单句拼接兜底 */
  async function translateChunk(texts, options) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestTranslation(texts, options);
      } catch (e) {
        lastError = e;
        if (!e.isCountMismatch) throw e; // 网络/鉴权等错误直接抛出,不重试
      }
    }

    if (texts.length === 1) {
      // 单句:取模型全部非空行拼接(不存在与其他句错位的问题)
      if (lastError && lastError.rawContent) {
        const lines = lastError.rawContent.split('\n').map(stripLineNo).filter(Boolean);
        if (lines.length > 0) return [lines.join('')];
      }
      throw lastError;
    }

    const mid = Math.ceil(texts.length / 2);
    const left = await translateChunk(texts.slice(0, mid), options);
    const right = await translateChunk(texts.slice(mid), options);
    return left.concat(right);
  }

  /**
   * 翻译一批句子
   * @param {string[]} texts 英文句子数组
   * @param {object} options { baseUrl, apiKey, model, disableThinking, polish }
   *   polish=true 时合并做口语化润色(翻译腔 → 自然口语),行数对应关系不变
   * @returns {Promise<string[]>} 中文译文数组(与输入一一对应)
   */
  async function translateBatch(texts, { baseUrl, apiKey, model, disableThinking, polish }) {
    if (!apiKey) throw new Error('翻译 API Key 未配置,请在设置页填写');
    if (!baseUrl) throw new Error('翻译 API 地址未配置,请在设置页填写');
    if (!texts || texts.length === 0) return [];
    return translateChunk(texts, {
      baseUrl, apiKey, model, disableThinking,
      systemPrompt: polish ? POLISH_SYSTEM_PROMPT : undefined,
    });
  }

  /**
   * 中文字幕口语化润色(中文直通通道:tlang 机翻 / B 站 ai-zh)
   * 与翻译共用行对齐容错(重试/拆半/单句兜底),结果与输入一一对应
   * @param {string[]} texts 中文句子数组
   * @returns {Promise<string[]>} 润色后的中文数组
   */
  async function polishBatch(texts, { baseUrl, apiKey, model, disableThinking }) {
    if (!apiKey) throw new Error('翻译 API Key 未配置,请在设置页填写(润色与翻译共用)');
    if (!baseUrl) throw new Error('翻译 API 地址未配置,请在设置页填写');
    if (!texts || texts.length === 0) return [];
    return translateChunk(texts, {
      baseUrl, apiKey, model, disableThinking,
      systemPrompt: POLISH_ONLY_SYSTEM_PROMPT,
      userIntro: (n) => `以下共 ${n} 行中文字幕,请恰好输出 ${n} 行润色后的文本:`,
    });
  }

  globalThis.Translate = { translateBatch, polishBatch, BATCH_SIZE };
})();
