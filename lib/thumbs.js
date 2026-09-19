/**
 * 章节预览图:YouTube storyboard / B 站 videoshot 雪碧图 → 按时间戳取帧
 *
 * 原理:两站都为视频预生成缩略图雪碧图(公开接口,无需 pot/登录),
 * 解析布局参数后按时间戳定位帧在雪碧图中的坐标,canvas 裁剪出小图。
 * 不 seek 视频、不打断播放、零 AI 成本。通过 globalThis.VdcThumbs 暴露。
 */
(function () {
  'use strict';

  const THUMB_PREFIX = 'thumb:';

  /* ---------------- YouTube storyboard spec ----------------
   * 格式:URL模板|spec段1|spec段2|…
   * 每段:thumbW#thumbH#totalFrames#cols#rows#intervalMs或占位#占位#rs$签名
   * 取有帧间隔的最高分辨率级
   */
  function parseStoryboardSpec(spec) {
    if (!spec || typeof spec !== 'string') return null;
    const parts = spec.split('|');
    const urlTemplate = parts[0];
    const levels = [];
    for (let i = 1; i < parts.length; i++) {
      const f = parts[i].split('#');
      if (f.length < 5) continue;
      const w = parseInt(f[0], 10);
      const h = parseInt(f[1], 10);
      const total = parseInt(f[2], 10);
      const cols = parseInt(f[3], 10);
      const rows = parseInt(f[4], 10);
      if (!w || !h || !total || !cols || !rows) continue;
      let intervalMs = 0;
      let sigh = '';
      for (let j = 5; j < f.length; j++) {
        if (/^\d+$/.test(f[j]) && !intervalMs) intervalMs = parseInt(f[j], 10);
        else if (f[j] && f[j] !== 'M$M' && f[j] !== 'default') sigh = f[j];
      }
      levels.push({ index: i - 1, w, h, total, cols, rows, intervalMs, sigh });
    }
    if (!levels.length) return null;
    const timed = levels.filter((l) => l.intervalMs > 0);
    const pool = timed.length ? timed : levels;
    pool.sort((a, b) => b.w * b.h - a.w * a.h);
    return { urlTemplate, level: pool[0] };
  }

  /**
   * 计算时间 t(秒)对应的雪碧图帧:{ url, x, y, w, h }。
   * URL 模板含 L$L(级别占位)与 $N(雪碧图序号占位)。
   */
  function frameAt(sb, t) {
    const { urlTemplate, level } = sb;
    const ms = Math.max(0, Math.round(t * 1000));
    const frameIdx = level.intervalMs
      ? Math.min(Math.floor(ms / level.intervalMs), level.total - 1)
      : Math.min(Math.floor(ms / 1000), level.total - 1);
    const perSprite = level.cols * level.rows;
    const spriteIdx = Math.floor(frameIdx / perSprite);
    const pos = frameIdx % perSprite;
    const x = (pos % level.cols) * level.w;
    const y = Math.floor(pos / level.cols) * level.h;
    // L$L → 级别序号;$N → 雪碧图序号
    let url = urlTemplate.replace('L$L', 'L' + level.index).replace('$N', 'M' + spriteIdx);
    // sigh 必须保留 rs$ 前缀完整追加(实测:剥掉前缀会 403)
    if (level.sigh) url += '&sigh=' + level.sigh;
    return { url, x, y, w: level.w, h: level.h };
  }

  /** canvas 裁剪:dataURL 图像指定区域 → 缩放输出 dataURL */
  async function cropImage(dataUrl, x, y, w, h, outW = 240) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('图片解码失败'));
      i.src = dataUrl;
    });
    const scale = Math.min(1, outW / w);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  }

  /* ---------------- B 站 videoshot(pvdata) ---------------- */

  /**
   * 解析 pvdata:image 为雪碧图数组,img_x_len/y_len 为行列数,
   * img_x_size/y_size 为每帧尺寸;帧按时间均匀分布(f_times 优先,否则均分)
   */
  function parsePvdata(data, durationSec) {
    if (!data || !Array.isArray(data.image) || !data.image.length) return null;
    const xLen = data.img_x_len || 10;
    const yLen = data.img_y_len || 10;
    const w = data.img_x_size;
    const h = data.img_y_size;
    if (!w || !h) return null;
    const perSprite = xLen * yLen;
    const total = perSprite * data.image.length;
    const frameAt = (t) => {
      let idx;
      if (Array.isArray(data.f_times) && data.f_times.length) {
        idx = nearestIndex(data.f_times, t);
      } else {
        const dur = Math.max(1, Math.round(durationSec || total));
        idx = Math.min(Math.max(0, Math.round((t / dur) * total)), total - 1);
      }
      const sprite = Math.floor(idx / perSprite);
      const pos = idx % perSprite;
      return {
        url: data.image[sprite],
        x: (pos % xLen) * w,
        y: Math.floor(pos / xLen) * h,
        w,
        h,
      };
    };
    return { frameAt };
  }

  function nearestIndex(times, t) {
    let best = 0;
    for (let i = 0; i < times.length; i++) {
      if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    }
    return best;
  }

  /* ---------------- 缩略图缓存 ---------------- */

  function keyOf(videoKey, t) {
    return `${THUMB_PREFIX}${videoKey}:${Math.round(t)}`;
  }

  async function getThumb(videoKey, t) {
    const key = keyOf(videoKey, t);
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function saveThumb(videoKey, t, dataUrl) {
    await chrome.storage.local.set({ [keyOf(videoKey, t)]: dataUrl });
  }

  globalThis.VdcThumbs = {
    parseStoryboardSpec,
    frameAt,
    parsePvdata,
    cropImage,
    getThumb,
    saveThumb,
  };
})();
