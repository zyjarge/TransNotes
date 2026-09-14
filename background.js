/**
 * Service Worker:翻译 + TTS 调度 + 缓存
 *
 * 职责:
 * 1. 接收 Content Script 的 DUB_START / DUB_STOP 消息
 * 2. 流式管线:从当前播放位置开始,按批「翻译 → 合成 → 即时推送」,
 *    页面侧首批缓冲就绪即开播,无需整片合成完;
 *    合成为多句合并模式:连续 5 句一次 TTS 请求(带句级字幕时间戳),
 *    整段音频推 DUB_CHUNK_READY 由页面切分;失败回退逐句(DUB_CUE_READY);
 *    全部完成后发送 DUB_ALL_READY 仅作状态通知
 * 3. 两级缓存:内存 Map + chrome.storage.local(翻译文本持久化,音频带容量上限的 LRU),
 *    同一视频中断后重开可命中缓存,成本很低
 *
 * 注意:MV3 下 Service Worker 可能随时休眠;合成结果全部通过
 * chrome.tabs.sendMessage 即时推送,不依赖 SW 长期存活。
 */
importScripts('lib/cache.js', 'lib/notes.js', 'lib/translate.js', 'lib/minimax_tts.js', 'lib/wbi.js');

'use strict';

// 点击扩展图标即打开侧边栏(笔记面板)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[transnotes] sidePanel 设置失败:', e));

// 首次安装(加载已解压的扩展程序)后自动打开设置页,引导填写 API Key;
// 更新/重载(reason: update 等)不打扰
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

const TRANSLATE_BATCH = 25;             // 每批翻译句数
const FIRST_BATCH = 5;                  // 首批小批量翻译:缩短"开口"延迟
const TTS_CHUNK_SIZE = 5;               // 每次 TTS 请求合并的句数(限流按请求次数,合并即提速)
const TTS_CHUNK_MAX_CHARS = 800;        // 单次合成字符上限(远低于 10000 硬限制)
const AUDIO_CACHE_LIMIT = 4 * 1024 * 1024; // 音频持久化缓存上限 4MB(配额为 10MB,留余量)

// 任务表:videoId → 任务对象
const tasks = new Map();

/** 全局唯一的 TTS 队列(所有视频共享,天然全局限流) */
const ttsQueue = new MiniMaxTTS.TtsQueue();

/** 内存缓存:音频 base64(Map key → base64 字符串) */
const memAudioCache = new Map();

/** 读取设置(chrome.storage.local 的 options 键) */
async function getOptions() {
  const { options } = await chrome.storage.local.get('options');
  return options || {};
}

/** 翻译缓存 key:v2 = 语义重组后的句子序号(旧按碎片的缓存作废) */
function transKey(videoId, index) {
  return `trans:v2:${videoId}:${index}:zh`;
}

/** 音频缓存 key:含音色/语速,避免换设置后命中旧音频;v2 = 语义重组后序号 */
function audioKey(videoId, index, options) {
  return `audio:v2:${videoId}:${options.voiceId || 'default'}:${options.speed || 1}:${index}`;
}

/** 合并块缓存 key:以首尾句 index 标识一个块;v3 = 语义重组后序号(旧 key 作废) */
function chunkKey(videoId, chunk, options) {
  return `chunk:v3:${videoId}:${options.voiceId || 'default'}:${options.speed || 1}:` +
    `${chunk[0].index}-${chunk[chunk.length - 1].index}`;
}

/** 从缓存取翻译文本(内存 → storage) */
async function getTranslation(videoId, index) {
  const key = transKey(videoId, index);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

/** 写翻译缓存(storage 持久化 + 内存) */
async function setTranslation(videoId, index, text) {
  const key = transKey(videoId, index);
  await chrome.storage.local.set({ [key]: text });
}

/** 润色缓存 key:与纯翻译缓存隔离(润色开关切换时各自命中,互不污染) */
function polishKey(videoId, index) {
  return `trans:v2:pl:${videoId}:${index}:zh`;
}

/** 从缓存取润色文本 */
async function getPolish(videoId, index) {
  const key = polishKey(videoId, index);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

/** 写润色缓存 */
async function setPolish(videoId, index, text) {
  const key = polishKey(videoId, index);
  await chrome.storage.local.set({ [key]: text });
}

/** 从缓存取音频 base64(内存 → storage,带容量管理) */
async function getAudioBase64(key) {
  if (memAudioCache.has(key)) return memAudioCache.get(key);
  const stored = await chrome.storage.local.get(key);
  if (stored[key]) memAudioCache.set(key, stored[key]);
  return stored[key] || null;
}

/** 写音频缓存:内存 + storage(超出容量上限时淘汰最旧) */
async function setAudioBase64(key, base64) {
  memAudioCache.set(key, base64);
  const stored = await chrome.storage.local.get(null);
  const sizeOf = (s) => s.length * 0.75;
  // 只统计音频条目:subs:/notes:/shot: 等共享缓存数据不计入音频配额
  const audioEntries = Object.keys(stored)
    .filter((k) => k.startsWith('audio:') || k.startsWith('chunk:'))
    .sort((a, b) => (a > b ? 1 : -1));
  let total = audioEntries.reduce((sum, k) => sum + sizeOf(stored[k] || ''), 0);
  if (total + sizeOf(base64) > AUDIO_CACHE_LIMIT) {
    // 淘汰 audio:/chunk: 前缀中最旧的条目(按 key 字典序即按 index 序)
    const drop = audioEntries.slice(0, Math.max(1, Math.floor(audioEntries.length * 0.3)));
    await chrome.storage.local.remove(drop);
    for (const k of drop) memAudioCache.delete(k);
  }
  await chrome.storage.local.set({ [key]: base64 });
}

/**
 * Blob → base64 字符串
 * 注意:Service Worker 环境没有 FileReader(window API),必须用 Blob.arrayBuffer + btoa
 */
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * 建任务并启动流水线
 * @param {object} msg { videoId, cues:[{index,start,end,text}], tabId }
 */
async function handleStart(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return { ok: false, error: '无法定位标签页' };

  const options = await getOptions();
  if (!options.minimaxApiKey) {
    return { ok: false, error: '请先在设置页填写 MiniMax API Key' };
  }

  // 停止该标签页上的所有旧任务(含上一个视频的:SPA 切换后旧任务若不停止,
  // 会继续空烧 TTS 配额并推送旧视频音频)
  for (const [vid, t] of tasks) {
    if (t.tabId === tabId) {
      t.stopped = true;
      tasks.delete(vid);
    }
  }

  const task = {
    videoId: msg.videoId,
    videoKey: msg.videoKey || msg.videoId, // 共享缓存 key(yt:{id} / bili:{bvid}:p{n})
    tabId,
    cues: msg.cues,
    options,
    startIndex: typeof msg.startIndex === 'number' ? msg.startIndex : 0,
    // B 站等场景:字幕已是中文(ai-zh),跳过翻译直接 TTS
    skipTranslate: !!msg.skipTranslate,
    stopped: false,
  };
  tasks.set(msg.videoId, task);
  console.log('[transnotes] 任务启动:', msg.videoId, '共', msg.cues.length, '句');

  // 字幕写入共享缓存(笔记/双语视图复用,不重复调 AI);
  // skipTranslate 通道字幕本身即中文(B 站/中文轨),或 zh 已带机翻中文(YouTube 自动翻译)
  VdcCache.saveSubtitles(task.videoKey, {
    site: msg.site || '',
    videoId: msg.videoId,
    title: msg.title || '',
    url: msg.url || '',
    route: msg.route || '',
  }, msg.cues.map((c) => {
    const item = { index: c.index, start: c.start, end: c.end, text: c.text };
    if (task.skipTranslate) item.zh = c.zh || c.text;
    return item;
  })).catch((e) => console.warn('[transnotes] 字幕缓存写入失败:', e));

  // 流水线在后台推进,不阻塞响应
  runPipeline(task).catch((e) => {
    console.error('[transnotes] 流水线异常:', e);
    pushError(task, e);
  });

  return { ok: true };
}

function handleStop(msg) {
  const task = tasks.get(msg.videoId);
  if (task) {
    task.stopped = true;
    tasks.delete(msg.videoId);
  }
  return { ok: true };
}

/**
 * 主流水线(流式):
 * 处理顺序:从当前播放位置对应的句子(startIndex)开始向后,最后回填前面的
 * 句子(seek 回开头也能播)。每批先翻译再逐句合成并即时推送,页面侧边收边播。
 * 阶段 3:全部推送完后发 DUB_ALL_READY,仅作状态通知(不影响开播时机)
 */
async function runPipeline(task) {
  const { cues, videoId, options } = task;
  const startPos = Math.max(0, Math.min(task.startIndex, cues.length));
  const ordered = cues.slice(startPos).concat(cues.slice(0, startPos));

  let from = 0;
  while (from < ordered.length && !task.stopped) {
    const batchSize = from === 0 ? FIRST_BATCH : TRANSLATE_BATCH;
    const slice = ordered.slice(from, from + batchSize);
    from += batchSize;

    // 润色开关(实验):英文通道把润色合并进翻译调用,读写独立的润色缓存
    const polish = !!options.polishSubtitles;

    // 翻译本批(先查缓存);skipTranslate 模式(B 站中文字幕)直接使用原文
    if (task.skipTranslate) {
      for (const cue of slice) {
        if (!cue.zh) cue.zh = cue.text;
      }
    } else {
      const getCached = polish ? getPolish : getTranslation;
      const setCached = polish ? setPolish : setTranslation;
      const needTranslate = [];
      for (const cue of slice) {
        const cached = await getCached(videoId, cue.index);
        if (cached) {
          cue.zh = cached;
        } else {
          needTranslate.push(cue);
        }
      }

      if (needTranslate.length > 0) {
        const batch = needTranslate.map((c) => c.text);
        const results = await Translate.translateBatch(batch, {
          baseUrl: options.translateBaseUrl,
          apiKey: options.translateApiKey,
          model: options.translateModel,
          disableThinking: options.disableThinking,
          polish,
        });
        needTranslate.forEach((cue, i) => {
          cue.zh = results[i];
          setCached(videoId, cue.index, results[i]).catch(() => {});
        });
      }
    }

    // 中文直通通道(中文轨/tlang 机翻)的单独润色:字幕已是中文,再过一遍口语化改写。
    // 需要文本模型配置;未配置或润色失败时静默回退为未润色文本,不阻塞配音
    if (task.skipTranslate && polish && options.translateApiKey) {
      try {
        const needPolish = [];
        for (const cue of slice) {
          const cached = await getPolish(videoId, cue.index);
          if (cached) cue.zh = cached;
          else needPolish.push(cue);
        }
        if (needPolish.length > 0) {
          const results = await Translate.polishBatch(needPolish.map((c) => c.zh), {
            baseUrl: options.translateBaseUrl,
            apiKey: options.translateApiKey,
            model: options.translateModel,
            disableThinking: options.disableThinking,
          });
          needPolish.forEach((cue, i) => {
            cue.zh = results[i];
            setPolish(videoId, cue.index, results[i]).catch(() => {});
          });
        }
      } catch (e) {
        console.warn('[transnotes] 字幕润色失败,本批使用未润色文本:', (e && e.message) || e);
      }
    }

    // 本批译文回填共享缓存(笔记/双语视图直接读取;skipTranslate 通道已在启动时写入,
    // 但润色改变了 zh,需要重新回填)
    const polished = task.skipTranslate && polish && options.translateApiKey;
    if (!task.skipTranslate || polished) {
      const zhUpdates = {};
      for (const cue of slice) {
        if (cue.zh) zhUpdates[cue.index] = cue.zh;
      }
      VdcCache.setCueZh(task.videoKey, zhUpdates)
        .catch((e) => console.warn('[transnotes] 译文回填缓存失败:', e));
    }

    // 合成并即时推送本批
    await advanceSynthesis(task, slice);
  }

  // 阶段 3:通知全部就绪
  if (!task.stopped) {
    console.log('[transnotes] 全部句子已推送:', videoId, '共', cues.length, '句');
    chrome.tabs
      .sendMessage(task.tabId, { type: 'DUB_ALL_READY', videoId, total: cues.length })
      .catch(() => {});
  }
}

/**
 * 合成 list 中已翻译且未发送的句子并推送(幂等)。
 * 主路径:把连续待合成句子按块(默认 5 句)合并成一次 TTS 请求
 * (限流按请求次数、计费按字符,合并后吞吐成倍提升而成本不变),
 * 整段音频 + 句级时间戳一次推送给页面,由 Content Script 切分回逐句;
 * 合并合成失败时回退逐句合成(兼容旧行为)
 */
async function advanceSynthesis(task, list) {
  const { videoId, options } = task;

  let i = 0;
  while (i < list.length && !task.stopped) {
    const cue = list[i];
    if (cue.audioSent || !cue.zh) {
      i++;
      continue;
    }
    // 逐句缓存命中(旧版本缓存):直接推送
    const cached = await getAudioBase64(audioKey(videoId, cue.index, options));
    if (cached) {
      sendCueAudio(task, cue, cached);
      i++;
      continue;
    }
    // 收集连续待合成段(遇逐句缓存即断开)
    const group = [];
    let j = i;
    while (j < list.length) {
      const c = list[j];
      if (c.audioSent || !c.zh) break;
      if (await getAudioBase64(audioKey(videoId, c.index, options))) break;
      group.push(c);
      j++;
    }
    // 按块大小/字符数切成若干块依次合成
    let from = 0;
    while (from < group.length && !task.stopped) {
      const chunk = [];
      let chars = 0;
      while (from < group.length && chunk.length < TTS_CHUNK_SIZE) {
        const c = group[from];
        if (chunk.length > 0 && chars + c.zh.length > TTS_CHUNK_MAX_CHARS) break;
        chunk.push(c);
        chars += c.zh.length;
        from++;
      }
      if (chunk.length === 1) {
        await synthesizeSingle(task, chunk[0]);
      } else {
        const ok = await synthesizeChunkAndPush(task, chunk);
        if (!ok) {
          // 回退逐句合成(合并路径失败,如字幕服务异常/字幕域名无权限)
          for (const c of chunk) {
            if (task.stopped) break;
            await synthesizeSingle(task, c);
          }
        }
      }
    }
    i = j;
  }
}

/** 推送单句音频(逐句路径) */
function sendCueAudio(task, cue, base64) {
  cue.audioSent = true;
  console.log('[transnotes] 推送音频:', task.videoId, 'index =', cue.index);
  chrome.tabs
    .sendMessage(task.tabId, {
      type: 'DUB_CUE_READY',
      videoId: task.videoId,
      index: cue.index,
      start: cue.start,
      end: cue.end,
      base64,
    })
    .catch(() => {});
}

/** 逐句合成并推送(兼容路径/回退路径) */
async function synthesizeSingle(task, cue) {
  const { videoId, options } = task;
  const aKey = audioKey(videoId, cue.index, options);
  let base64 = await getAudioBase64(aKey);
  if (!base64) {
    const blob = await ttsQueue.enqueue(cue.zh, {
      apiKey: options.minimaxApiKey,
      groupId: options.minimaxGroupId,
      voiceId: options.voiceId,
      speed: options.speed,
      model: options.ttsModel,
    });
    base64 = await blobToBase64(blob);
    setAudioBase64(aKey, base64).catch(() => {});
  }
  sendCueAudio(task, cue, base64);
}

/**
 * 合并合成一组句子并整块推送。成功返回 true。
 * 块音频与切分结果按块缓存,重开页面/重播时直接命中
 */
async function synthesizeChunkAndPush(task, chunk) {
  const { videoId, options } = task;
  const cKey = chunkKey(videoId, chunk, options);

  // 块缓存命中:直接重放推送
  const cachedRaw = await getAudioBase64(cKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      pushChunk(task, chunk, cached.base64, cached.segments);
      return true;
    } catch (e) { /* 缓存损坏,继续重新合成 */ }
  }

  try {
    const text = chunk.map((c) => c.zh).join('\n'); // 官方约定:段落用换行符分隔
    const { blob, subtitles, granularity } = await ttsQueue.enqueueChunk(text, {
      apiKey: options.minimaxApiKey,
      groupId: options.minimaxGroupId,
      voiceId: options.voiceId,
      speed: options.speed,
      model: options.ttsModel,
    });
    const segments = alignSegments(chunk, subtitles, granularity);
    if (!segments) throw new Error('字幕与句子对齐失败');
    const base64 = await blobToBase64(blob);
    setAudioBase64(cKey, JSON.stringify({ base64, segments })).catch(() => {});
    pushChunk(task, chunk, base64, segments);
    return true;
  } catch (e) {
    console.warn('[transnotes] 合并合成失败,回退逐句:', (e && e.message) || e);
    return false;
  }
}

/** 推送合并块:整段音频 + 每句在音频内的时间区间(秒) */
function pushChunk(task, chunk, base64, segments) {
  chunk.forEach((c) => { c.audioSent = true; });
  console.log('[transnotes] 推送合并音频:', task.videoId,
    `index ${chunk[0].index}-${chunk[chunk.length - 1].index}`, `共 ${chunk.length} 句`);
  chrome.tabs
    .sendMessage(task.tabId, {
      type: 'DUB_CHUNK_READY',
      videoId: task.videoId,
      base64,
      segments,
    })
    .catch(() => {});
}

/**
 * 把 MiniMax 字幕时间戳对齐到我们的句子块。
 * 字幕分句与我们句子的边界可能不同(字幕句 ≤50 字,且 MiniMax 会做文本规范化),
 * 因此按字符位置比例映射:整段文本第 N 个字符 → 落在字幕第几条 → 条内按比例插值时间。
 * 词级(word)字幕不做条内插值:边界位置直接对齐到所在词的结束时刻
 * (内部边界为相邻两句共享,句尾词完整归入左句),避免把句尾半个词切掉(吞字)
 * @param {string} [granularity] 字幕粒度:'word' | 'sentence'(默认)
 * @returns {Array<{index, begin, end}>} 每句在整段音频内的时间区间(秒);无法对齐返回 null
 */
function alignSegments(chunk, subtitles, granularity) {
  if (!subtitles || !subtitles.length) return null;
  const norm = (s) => (s || '').replace(/\s+/g, '');

  const entries = [];
  let totalSub = 0;
  for (const s of subtitles) {
    const len = norm(s.text).length;
    if (typeof s.begin !== 'number' || typeof s.end !== 'number') return null;
    entries.push({ acc: totalSub, len: Math.max(1, len), begin: s.begin, end: s.end });
    totalSub += len;
  }
  if (!totalSub) return null;

  const wordLevel = granularity === 'word';
  const timeAt = (pos) => {
    // 起点特判:整段音频的开始
    if (pos <= 0) return entries[0].begin;
    // 向左缩一个 epsilon:边界位置恰在某条起点时应归属上一条
    // (否则词级对齐会把下一句的首词错误并进上一句)
    const p = Math.min(pos - 1e-6, totalSub - 1e-6);
    for (const e of entries) {
      if (p < e.acc + e.len) {
        // 词级:边界对齐到词结束(句尾词完整保留,不切词内)
        if (wordLevel) return e.end;
        // 句级:句内按字符比例插值
        return e.begin + (e.end - e.begin) * ((p - e.acc) / e.len);
      }
    }
    return entries[entries.length - 1].end;
  };

  const cueLens = chunk.map((c) => norm(c.zh).length);
  const totalCue = cueLens.reduce((a, b) => a + b, 0);
  if (!totalCue) return null;
  const scale = totalSub / totalCue; // 文本规范化导致的长度差按比例吸收

  const segments = [];
  let acc = 0;
  for (let i = 0; i < chunk.length; i++) {
    const begin = timeAt(acc * scale);
    acc += cueLens[i];
    const end = timeAt(acc * scale);
    if (end - begin < 0.05) return null; // 区间异常,判定对齐失败
    segments.push({ index: chunk[i].index, begin, end });
  }
  return segments;
}

function pushError(task, err) {
  chrome.tabs
    .sendMessage(task.tabId, {
      type: 'DUB_ERROR',
      videoId: task.videoId,
      message: (err && err.message) || String(err),
    })
    .catch(() => {});
}

/**
 * 取 B 站播放器信息(x/player/wbi/v2,wbi 签名)。
 * 官方播放器走 wbi 签名接口;免签名的 x/player/v2 会被风控返回"脏数据"
 * (字幕轨道张冠李戴,实测返回过 LOL / 股市等毫不相干视频的字幕)
 */
async function handleBiliPlayerV2(msg) {
  try {
    // 官方播放器传 aid+cid;只传 bvid 的响应形态不同,尽量贴齐官方
    const params = { cid: msg.cid };
    if (msg.aid) params.aid = msg.aid;
    else params.bvid = msg.bvid;
    const query = await BiliWbi.sign(
      params,
      (url) => fetch(url, { credentials: 'include' })
    );
    const resp = await fetch('https://api.bilibili.com/x/player/wbi/v2?' + query, {
      credentials: 'include',
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 代取 B 站资源(供 bilibili.js 使用)。
 * Content Script 跨域 fetch api.bilibili.com / aisubtitle.hdslb.com 受 CORS 限制
 * (实测报 Failed to fetch);Service Worker 携带 host_permissions 不受 CORS 约束,
 * credentials:'include' 会带上用户登录 cookie(字幕接口要求登录态)。
 * 仅允许 bilibili.com / hdslb.com 域名,防止被滥用为任意代理。
 */
async function handleBiliFetch(msg) {
  const url = msg.url || '';
  let host = '';
  try {
    host = new URL(url).host;
  } catch (e) {
    return { ok: false, error: '非法 URL' };
  }
  const allowed = host.endsWith('.bilibili.com') || host === 'bilibili.com' ||
    host.endsWith('.hdslb.com') || host === 'hdslb.com';
  if (!allowed || !url.startsWith('https://')) {
    return { ok: false, error: '不允许的域名' };
  }
  try {
    const resp = await fetch(url, { credentials: 'include' });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 截取当前标签页画面(捕捉浮层「插入截图」用)。
 * captureVisibleTab 从浏览器层面截图,绕开跨域视频 canvas 污染问题;
 * 需要 <all_urls> host 权限(见 manifest)。返回 jpeg dataURL。
 */
async function handleCaptureShot(sender) {
  try {
    const windowId = sender.tab && sender.tab.windowId;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 70,
    });
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 生成笔记草稿:AI 概览(复用翻译 provider)+ 时间戳笔记 + 双语字幕。
 * 字幕译文来自共享缓存,不重复调 AI;草稿写入 draft:{videoKey}。
 */
async function handleGenDraft(msg) {
  try {
    const options = await getOptions();
    const ai = {
      baseUrl: options.translateBaseUrl,
      apiKey: options.translateApiKey,
      model: options.translateModel,
      disableThinking: options.disableThinking,
    };
    const md = await VdcNotes.generateDraft(msg.videoKey, ai, {
      forceOverview: !!msg.forceOverview,
      sections: options.exportSections,
      level: options.overviewLevel,
      autoNoteTemplate: options.noteTemplate,
    });
    return { ok: true, md };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 尝试打开侧边栏(页面内「生成草稿」按钮点击后调用)。
 * 需要用户手势;content script 的点击手势经消息传递在部分版本不生效,
 * 失败时静默,由页面提示用户点扩展图标。
 */
async function handleOpenPanel(sender) {
  try {
    const windowId = sender.tab && sender.tab.windowId;
    await chrome.sidePanel.open({ windowId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 仅生成 AI 概览(侧边栏「概览」页签用;结果缓存 oview:{videoKey})
 */
async function handleGenOverview(msg) {
  try {
    const options = await getOptions();
    const overview = await VdcNotes.generateOverview(msg.videoKey, {
      baseUrl: options.translateBaseUrl,
      apiKey: options.translateApiKey,
      model: options.translateModel,
      disableThinking: options.disableThinking,
    }, !!msg.force, options.overviewLevel);
    return { ok: true, overview };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 批量翻译共享缓存里缺中文的字幕(侧边栏自动流程用:抓完英文轨后补中文)。
 * 与配音管线共用 trans:v2 缓存——先查后翻、翻完写回,两边互不重复调 AI;
 * 每批写完立即回填共享缓存,侧边栏字幕视图随批次渐进变双语。
 */
async function handleTranslateSubs(msg) {
  try {
    const doc = await VdcCache.getSubtitles(msg.videoKey);
    if (!doc || !doc.cues || !doc.cues.length) return { ok: false, error: '无字幕缓存' };
    const options = await getOptions();
    const vid = doc.videoId || msg.videoKey; // trans:v2 缓存键用的原始 videoId
    // 润色开关(实验):读写独立的润色缓存,翻译+润色合并为一次调用
    const polish = !!options.polishSubtitles;
    const getCached = polish ? getPolish : getTranslation;
    const setCached = polish ? setPolish : setTranslation;
    const pending = doc.cues.filter((c) => !c.zh);
    for (let from = 0; from < pending.length; from += TRANSLATE_BATCH) {
      const slice = pending.slice(from, from + TRANSLATE_BATCH);
      const need = [];
      for (const c of slice) {
        const cached = await getCached(vid, c.index);
        if (cached) c.zh = cached;
        else need.push(c);
      }
      if (need.length) {
        const results = await Translate.translateBatch(need.map((c) => c.text), {
          baseUrl: options.translateBaseUrl,
          apiKey: options.translateApiKey,
          model: options.translateModel,
          disableThinking: options.disableThinking,
          polish,
        });
        need.forEach((c, i) => {
          c.zh = results[i];
          setCached(vid, c.index, results[i]).catch(() => {});
        });
      }
      const updates = {};
      for (const c of slice) if (c.zh) updates[c.index] = c.zh;
      await VdcCache.setCueZh(msg.videoKey, updates);
    }
    return { ok: true, translated: pending.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 生成自动笔记(学习笔记模板;按模板分别缓存,force 强制重建)
 */
async function handleGenAutoNote(msg) {
  try {
    const options = await getOptions();
    const note = await VdcNotes.generateAutoNote(msg.videoKey, {
      baseUrl: options.translateBaseUrl,
      apiKey: options.translateApiKey,
      model: options.translateModel,
      disableThinking: options.disableThinking,
    }, { template: msg.template, force: !!msg.force });
    return { ok: true, note };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ---------------- 消息路由 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'DUB_START':
        return await handleStart(msg, sender);
      case 'DUB_STOP':
        return handleStop(msg);
      case 'BILI_FETCH':
        return await handleBiliFetch(msg);
      case 'BILI_PLAYER_V2':
        return await handleBiliPlayerV2(msg);
      case 'CAPTURE_SHOT':
        return await handleCaptureShot(sender);
      case 'GEN_DRAFT':
        return await handleGenDraft(msg);
      case 'GEN_OVERVIEW':
        return await handleGenOverview(msg);
      case 'TRANSLATE_SUBS':
        return await handleTranslateSubs(msg);
      case 'GEN_AUTONOTE':
        return await handleGenAutoNote(msg);
      case 'OPEN_PANEL':
        return await handleOpenPanel(sender);
      default:
        return { ok: false, error: '未知消息类型' };
    }
  })().then(sendResponse);
  return true; // 异步响应
});
