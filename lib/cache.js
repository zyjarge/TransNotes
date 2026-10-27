/**
 * 共享缓存层(Background / Content Script / 未来的侧边栏 共用)
 *
 * 配音翻译产生的中文字幕,笔记、双语视图直接复用,不重复调用 AI。
 * 全部数据存 chrome.storage.local(本地优先,无服务器):
 *
 *   subs:{videoKey}   字幕文档:{ site, videoId, title, url, route,
 *                      cues:[{index,start,end,text,zh?}], createdAt, updatedAt }
 *   notes:{videoKey}  笔记数组:[{ id, ts, text, zh, comment, shot, createdAt }]
 *   shot:{id}         截图 dataURL(jpeg)
 *
 * videoKey 约定:YouTube 为 yt:{videoId};B 站为 bili:{bvid}:p{n}(分 P 区分);
 * X(Twitter)为 x:{statusId}(帖子详情页)。
 *
 * 使用方式:Content Script 经 manifest 脚本列表加载;Background 经 importScripts 加载。
 * 通过 globalThis.VdcCache 暴露。
 */
(function () {
  'use strict';

  const SUBS_PREFIX = 'subs:';
  const NOTES_PREFIX = 'notes:';
  const SHOT_PREFIX = 'shot:';

  /* ---------------- 字幕文档 ---------------- */

  /**
   * 保存(或合并更新)一个视频的字幕文档。
   * 重复保存时:同 index 且原文一致的句子继承已有中文翻译,避免配音重开覆盖已有译文。
   * @param {string} videoKey
   * @param {object} meta { site, videoId, title, url, route }
   * @param {Array} cues [{index,start,end,text,zh?}] skipTranslate 通道可带 zh
   */
  async function saveSubtitles(videoKey, meta, cues) {
    const key = SUBS_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const old = stored[key];
    const oldByIndex = new Map();
    if (old && Array.isArray(old.cues)) {
      for (const c of old.cues) oldByIndex.set(c.index, c);
    }
    const merged = (cues || []).map((c) => {
      const o = oldByIndex.get(c.index);
      const zh = c.zh || (o && o.text === c.text ? o.zh : undefined);
      const item = { index: c.index, start: c.start, end: c.end, text: c.text };
      if (zh) item.zh = zh;
      return item;
    });
    const doc = Object.assign({}, meta || {}, {
      cues: merged,
      createdAt: (old && old.createdAt) || Date.now(),
      updatedAt: Date.now(),
    });
    await chrome.storage.local.set({ [key]: doc });
  }

  /** 读取字幕文档;不存在返回 null */
  async function getSubtitles(videoKey) {
    const key = SUBS_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  /**
   * 批量回填中文翻译(配音流水线每批翻译完调用一次)
   * @param {string} videoKey
   * @param {Object<number,string>} updates { cueIndex: 中文译文 }
   */
  async function setCueZh(videoKey, updates) {
    const key = SUBS_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const doc = stored[key];
    if (!doc || !Array.isArray(doc.cues)) return;
    let changed = false;
    for (const c of doc.cues) {
      const zh = updates[c.index];
      if (zh && c.zh !== zh) {
        c.zh = zh;
        changed = true;
      }
    }
    if (changed) {
      doc.updatedAt = Date.now();
      await chrome.storage.local.set({ [key]: doc });
    }
  }

  /**
   * 查找时刻 t 对应的句子:优先 t 所在区间;否则取刚结束不久(<2s)的上一句;
   * 都没有返回 null
   * @param {Array} cues [{start,end,...}] 按时间升序
   * @param {number} t 秒
   */
  function findCueAt(cues, t) {
    if (!Array.isArray(cues) || !cues.length) return null;
    let prev = null;
    for (const c of cues) {
      if (t >= c.start && t < c.end) return c;
      if (c.end <= t) prev = c;
      if (c.start > t) break;
    }
    return prev && t - prev.end < 2 ? prev : null;
  }

  /* ---------------- 笔记 ---------------- */

  /**
   * 追加一条笔记
   * @param {string} videoKey
   * @param {object} note { id, ts, text, zh, comment, shot, createdAt }
   */
  async function addNote(videoKey, note) {
    const key = NOTES_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const notes = Array.isArray(stored[key]) ? stored[key] : [];
    notes.push(note);
    notes.sort((a, b) => a.ts - b.ts); // 按时间戳排序,侧边栏/导出按此顺序
    await chrome.storage.local.set({ [key]: notes });
    return note;
  }

  /** 读取某视频的全部笔记(按时间戳升序) */
  async function getNotes(videoKey) {
    const key = NOTES_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    return Array.isArray(stored[key]) ? stored[key] : [];
  }

  /** 删除一条笔记(顺带清理其截图) */
  async function deleteNote(videoKey, noteId) {
    const key = NOTES_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const notes = Array.isArray(stored[key]) ? stored[key] : [];
    const victim = notes.find((n) => n.id === noteId);
    const kept = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ [key]: kept });
    if (victim && victim.shot) {
      await chrome.storage.local.remove(SHOT_PREFIX + victim.shot);
    }
  }

  /**
   * 更新一条笔记(浅合并 patch,如 { comment: '...' } 或 { shot: null })。
   * 返回更新后的笔记;不存在返回 null。
   */
  async function updateNote(videoKey, noteId, patch) {
    const key = NOTES_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const notes = Array.isArray(stored[key]) ? stored[key] : [];
    const n = notes.find((x) => x.id === noteId);
    if (!n) return null;
    Object.assign(n, patch || {});
    await chrome.storage.local.set({ [key]: notes });
    return n;
  }

  /* ---------------- 助教问答 ---------------- */

  const QA_PREFIX = 'ask:';

  /**
   * 助教问答排序比较器:按提问时刻(createdAt)升序,而非视频播放位置(ts)。
   *
   * 为何不用 ts:ts 是提问时视频的 currentTime,不是对话发生顺序。
   * 用户往回拖进度条再提问时,ts 顺序 ≠ 对话顺序,按 ts 排会让多轮对话
   * 在侧边栏和导出笔记里错乱(实测:提问 A(1:40) → B(3:20) → C(回到1:40)
   * 按 ts 排得到 A → C → B)。
   *
   * ts 仍然保留,用途是「点击时间戳跳回视频对应位置」。
   *
   * createdAt 缺失时(极老版本记录)用 id 前缀兜底:id 形如
   * 'q' + Date.now().toString(36) + 随机后缀,前缀可还原创建时刻,
   * 与 createdAt 同源。两者都取不到才回退按 ts 排(不丢数据)。
   */
  function qaTime(qa) {
    if (typeof qa.createdAt === 'number') return qa.createdAt;
    // id 形如 'q' + Date.now().toString(36) + 随机后缀;
    // Date.now() 的 base36 在当前纪元固定 8 位,取前 8 位还原创建时刻。
    // (不能贪婪匹配 —— 随机后缀也是合法 base36 字符,会把值算爆)
    const m = /^q([0-9a-z]{8})/.exec(String(qa.id || ''));
    if (m) {
      const ms = parseInt(m[1], 36);
      // 合理区间校验:2020-01-01 ~ 2100-01-01,避免解析出无意义数值
      if (Number.isFinite(ms) && ms > 1.577e12 && ms < 4.102e12) return ms;
    }
    return null;
  }

  function compareQA(a, b) {
    const ca = qaTime(a);
    const cb = qaTime(b);
    // 两者都能确定提问时刻:按提问时刻升序(相同时按 id 兜底,保证稳定)
    if (ca !== null && cb !== null) {
      return ca !== cb ? ca - cb : String(a.id || '').localeCompare(String(b.id || ''));
    }
    // 一方无法确定:把能确定的排前面,不确定的靠后(不丢数据)
    if (ca !== null) return -1;
    if (cb !== null) return 1;
    // 都无法确定:回退按视频位置排
    return (a.ts || 0) - (b.ts || 0);
  }

  /**
   * 追加一条助教问答
   * @param {string} videoKey
   * @param {object} qa { id, ts, question, answer, createdAt }
   */
  async function addQA(videoKey, qa) {
    const key = QA_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const list = Array.isArray(stored[key]) ? stored[key] : [];
    list.push(qa);
    list.sort(compareQA); // 按提问时刻排序(对话顺序),导出与展示同序
    await chrome.storage.local.set({ [key]: list });
    return qa;
  }

  /**
   * 读取某视频的全部助教问答(按提问时刻升序 = 对话顺序)。
   *
   * 读取时也排序:存量数据是在旧版本里按 ts 写入的,顺序已错乱;
   * 这里读时重排,用户不新增问答也能立刻看到正确顺序。
   */
  async function getQA(videoKey) {
    const stored = await chrome.storage.local.get(QA_PREFIX + videoKey);
    const list = Array.isArray(stored[QA_PREFIX + videoKey]) ? stored[QA_PREFIX + videoKey] : [];
    return list.slice().sort(compareQA);
  }

  /** 删除一条问答 */
  async function deleteQA(videoKey, qaId) {
    const key = QA_PREFIX + videoKey;
    const stored = await chrome.storage.local.get(key);
    const list = Array.isArray(stored[key]) ? stored[key] : [];
    await chrome.storage.local.set({ [key]: list.filter((q) => q.id !== qaId) });
  }

  /* ---------------- 截图 ---------------- */

  /** 保存截图 dataURL,返回 id */
  async function saveShot(id, dataUrl) {
    await chrome.storage.local.set({ [SHOT_PREFIX + id]: dataUrl });
    return id;
  }

  /** 读取截图 dataURL;不存在返回 null */
  async function getShot(id) {
    const stored = await chrome.storage.local.get(SHOT_PREFIX + id);
    return stored[SHOT_PREFIX + id] || null;
  }

  /** 删除截图数据 */
  async function removeShot(id) {
    await chrome.storage.local.remove(SHOT_PREFIX + id);
  }

  globalThis.VdcCache = {
    saveSubtitles,
    getSubtitles,
    setCueZh,
    findCueAt,
    addNote,
    getNotes,
    deleteNote,
    updateNote,
    addQA,
    getQA,
    deleteQA,
    saveShot,
    getShot,
    removeShot,
  };
})();
