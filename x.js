/**
 * X(Twitter)帖子页 Content Script:中文配音 + 时间戳笔记
 *
 * 与 YouTube(content.js)/ B 站(bilibili.js)的差异:
 * - 仅支持帖子详情页(/status/{id}),不做时间线瀑布流:
 *   页面 URL 自带 status id,侧栏沿用纯 URL 轮询即可识别当前视频
 * - 帖子页主帖只有一个 video 元素(实测),沿用"单视频"假设;
 *   主帖无视频而回复/引用帖带视频时兜底取页面第一个 video
 * - 字幕零网络请求:X 为多数视频提供自动字幕,挂在 video.textTracks 上。
 *   把轨道置为 hidden 让浏览器加载 cue 文件,读出 VTTCue 后剥掉
 *   X 私有的 <X-word-ms ...> 逐词时间轴标签即得纯文本(实测可用)。
 *   全程不抓 m3u8、不经 Background 代取、不需要 injected.js
 * - 字幕是英文:需翻译,DUB_START 不带 skipTranslate(与 YouTube 英文轨同路径)
 * - X 是 History API 无刷新导航,沿用 B 站的 2 秒 URL 巡检重置状态
 * - X 播放器无稳定可嵌入的控制栏,配音/笔记按钮一律用浮动按钮挂在播放器容器右上角
 *
 * 流程:点击按钮 → 暂停视频 + 加载浮层 → 读 textTrack 字幕 → DUB_START →
 * 首批缓冲(3 句)就绪自动续播;播放中某句未就绪同样暂停缓冲等待
 */
(function () {
  'use strict';

  console.log('[transnotes] x content script loaded');

  const BTN_CLASS = 'transnotes-player-btn'; // 与 YouTube/B 站同名(各站脚本不会同时加载)
  const CAP_BTN_CLASS = 'transnotes-capture-btn'; // 「记录想法」按钮
  const STATUS_ID = 'transnotes-status';
  const STYLE_ID = 'transnotes-style';
  const LOADING_ID = 'transnotes-loading';
  const INITIAL_BUFFER_CUES = 3;          // 开播前至少就绪的句数(首批缓冲)
  const LOADING_WATCHDOG_MS = 60000;      // 首批缓冲看门狗:超时兜底开播
  const TRACK_WAIT_MS = 8000;             // 等待 textTracks 出现的上限
  const CUES_WAIT_MS = 12000;             // 置 hidden 后等待 cue 文件加载的上限

  let state = 'idle';          // idle | loading | active | error
  let activeVideoId = null;    // 即 videoKey:x:{statusId}
  let cues = [];
  let syncPlayer = null;
  let cueAudioCache = new Map(); // index → {url, duration}
  let allReady = false;
  let pendingStartIndex = 0;
  let loadingWatchdog = null;
  let lastVideoKey = null;     // 巡检用:检测 SPA 切帖子
  let hiddenTrackBackup = null; // 配音期间被压成 hidden 的字幕轨(停止时恢复 showing)

  /* ---------------- UI ---------------- */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return true;
    const root = document.documentElement || document.head || document.body;
    if (!root) return false;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.transnotes-player-btn{display:flex;align-items:center;justify-content:center;',
      'width:34px;height:34px;cursor:pointer;border:none;background:transparent}',
      '.transnotes-player-btn img{width:20px;height:20px;border-radius:3px;opacity:.9;pointer-events:none}',
      '.transnotes-player-btn:hover img{opacity:1}',
      '.transnotes-player-btn.transnotes-active img{opacity:1;filter:drop-shadow(0 0 3px #00a1d6)}',
      // X 无可嵌入的控制栏:固定用播放器右上角圆形浮动按钮
      '.transnotes-player-btn.transnotes-float-btn{position:absolute;top:12px;right:12px;',
      'z-index:60;width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,.55)}',
      '.transnotes-player-btn.transnotes-float-btn:hover{background:rgba(0,0,0,.75)}',
      '.transnotes-player-btn.transnotes-float-btn img{width:22px;height:22px}',
      // 「记录想法」按钮:浮动在配音按钮下方
      '.transnotes-capture-btn{display:flex;align-items:center;justify-content:center;',
      'width:34px;height:34px;cursor:pointer;border:none;background:transparent}',
      '.transnotes-capture-btn svg{width:18px;height:18px;opacity:.9;pointer-events:none;fill:#fff}',
      '.transnotes-capture-btn:hover svg{opacity:1}',
      '.transnotes-capture-btn.transnotes-float-btn{position:absolute;top:60px;right:12px;',
      'z-index:60;width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,.55)}',
      '.transnotes-capture-btn.transnotes-float-btn:hover{background:rgba(0,0,0,.75)}',
      '#transnotes-status{position:absolute;top:12px;left:12px;z-index:60;padding:4px 10px;',
      'border-radius:4px;background:rgba(0,0,0,.7);color:#fff;font-size:13px;',
      'pointer-events:none;display:none}',
      // 加载浮层:暂停期间的视觉提示;层级低于按钮(60),保证加载中按钮可点取消
      '#transnotes-loading{position:absolute;inset:0;z-index:59;display:none;',
      'flex-direction:column;align-items:center;justify-content:center;gap:14px;',
      'background:rgba(0,0,0,.35);pointer-events:none}',
      // 胶囊:圆点 + 标签 + 进度小字 + 滚动声波(品牌珊瑚红)
      '.transnotes-loading-pill{display:flex;align-items:center;gap:10px;max-width:78%;',
      'background:rgba(255,255,255,.96);border-radius:999px;padding:10px 16px;',
      'box-shadow:0 4px 20px rgba(0,0,0,.18);',
      'font:13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1F2329}',
      '.transnotes-loading-dot{width:10px;height:10px;border-radius:50%;background:#E6485D;flex:none}',
      '.transnotes-loading-label{font-weight:600;white-space:nowrap}',
      '.transnotes-loading-progress{color:#9AA1AB;font-size:12px;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      // 声波加载图:GIF 内置动画,不依赖 CSS/JS 动画,避开减弱动态效果等坑
      '.transnotes-loading-wave{display:inline-flex;align-items:center;height:24px;flex:none;margin-left:2px}',
      '.transnotes-loading-wave img{height:24px;width:auto;display:block}',
    ].join('\n');
    root.appendChild(style);
    return true;
  }

  /**
   * 主帖视频:帖子页第一个 article 即主帖,优先取其内部 video;
   * 主帖无视频(回复/引用帖带视频)时兜底取页面第一个 video
   */
  function getVideoElement() {
    const mainArticle = document.querySelector('article');
    if (mainArticle) {
      const v = mainArticle.querySelector('video');
      if (v) return v;
    }
    return document.querySelector('video');
  }

  /**
   * 浮层挂载点:沿 video 祖先链找第一个有实际尺寸的容器;
   * static 容器补 relative 作为绝对定位锚点(尺寸不变,不影响布局)
   */
  function getPlayerContainer() {
    const video = getVideoElement();
    if (video) {
      let el = video.parentElement;
      while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
          return el;
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  function mountInPlayer(el) {
    const player = getPlayerContainer();
    if (!player) return false;
    if (el.parentNode !== player) player.appendChild(el);
    return true;
  }

  function ensureStatus() {
    let el = document.getElementById(STATUS_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = STATUS_ID;
    }
    return mountInPlayer(el);
  }

  function showLoadingOverlay(text) {
    let el = document.getElementById(LOADING_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = LOADING_ID;
      el.innerHTML =
        '<div class="transnotes-loading-pill">' +
        '<span class="transnotes-loading-dot"></span>' +
        '<span class="transnotes-loading-label">AI 中文配音中</span>' +
        '<span class="transnotes-loading-progress"></span>' +
        '<img class="transnotes-loading-wave" src="' + chrome.runtime.getURL('icons/loading-wave.gif') + '" alt="">' +
        '</div>';
    }
    if (!mountInPlayer(el)) return;
    el.querySelector('.transnotes-loading-progress').textContent = text || '';
    el.style.display = 'flex';
  }

  function hideLoadingOverlay() {
    const el = document.getElementById(LOADING_ID);
    if (el) el.style.display = 'none';
  }

  // 声波动画由 GIF 内置,无需 JS 驱动

  /** 注入配音按钮:X 无稳定控制栏,一律浮动在播放器右上角 */
  function injectButton() {
    injectStyles();
    const existing = document.querySelector('.' + BTN_CLASS);
    if (existing) {
      // 播放器容器可能被 React 重建,搬家修正
      mountInPlayer(existing);
      return ensureStatus();
    }
    const btn = document.createElement('button');
    btn.className = BTN_CLASS + ' transnotes-float-btn';
    btn.title = '中文配音';
    btn.setAttribute('aria-label', '中文配音');
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/button.png');
    img.alt = '';
    btn.appendChild(img);
    btn.addEventListener('click', onToggleClick);
    if (!mountInPlayer(btn)) return false;
    return ensureStatus();
  }

  /**
   * 注入「记录想法」按钮:浮动在配音按钮下方,
   * 点击打开捕捉浮层(与快捷键 Ctrl/Cmd+Shift+S 等效)
   */
  function injectCaptureButton() {
    if (!globalThis.DubCapture) return false;
    injectStyles();
    const existing = document.querySelector('.' + CAP_BTN_CLASS);
    if (existing) return mountInPlayer(existing);

    const btn = document.createElement('button');
    btn.className = CAP_BTN_CLASS + ' transnotes-float-btn';
    btn.title = '记录想法(Ctrl+Shift+S)';
    btn.setAttribute('aria-label', '记录想法');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z' +
      'M20.7 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    btn.addEventListener('click', () => DubCapture.open());
    return mountInPlayer(btn);
  }

  function setStatus(text, color) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#fff';
    el.style.display = text ? 'block' : 'none';
  }

  /* ---------------- 顶部 toast(自动抓字幕结果反馈) ---------------- */
  const AUTO_TOAST_ID = 'transnotes-auto-toast';
  let autoToastTimer = null;
  function showAutoToast(text, kind) {
    let el = document.getElementById(AUTO_TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = AUTO_TOAST_ID;
      el.style.cssText = [
        'position:fixed', 'top:24px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:99999', 'padding:6px 14px', 'border-radius:6px',
        'font:13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
        'box-shadow:0 1px 3px rgba(0,0,0,.18)', 'pointer-events:none',
        'opacity:0', 'transition:opacity .2s', 'max-width:80%', 'text-align:center',
      ].join(';');
      document.body.appendChild(el);
    }
    if (kind === 'error') {
      el.style.background = 'rgba(217,48,78,.92)';
      el.style.color = '#fff';
    } else if (kind === 'nosubs') {
      el.style.background = 'rgba(60,64,70,.85)';
      el.style.color = '#fff';
    } else {
      el.style.background = 'rgba(31,35,41,.85)';
      el.style.color = '#fff';
    }
    el.textContent = text;
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(autoToastTimer);
    autoToastTimer = setTimeout(() => {
      if (el) el.style.opacity = '0';
    }, kind === 'ok' ? 1800 : 3500);
  }

  function setState(next) {
    state = next;
    const btn = document.querySelector('.' + BTN_CLASS);
    if (btn) {
      const active = next === 'active';
      btn.classList.toggle('transnotes-active', active);
      btn.title = (active || next === 'loading') ? '停止配音' : '中文配音';
      btn.setAttribute('aria-label', btn.title);
    }
    if (next === 'error') {
      const status = document.getElementById(STATUS_ID);
      if (status && !status.textContent) setStatus('配音已停止');
    }
  }

  /* ---------------- 视频标识与字幕抓取 ---------------- */

  /** 当前帖子标识:{ statusId, key };/status 页外返回 null */
  function getVideoKey() {
    try {
      const u = new URL(location.href);
      const m = u.pathname.match(/^\/[^/]+\/status\/(\d+)/);
      if (!m) return null;
      return { statusId: m[1], key: `x:${m[1]}` };
    } catch (e) {
      return null;
    }
  }

  /**
   * X 的 cue 文本外层包了私有逐词时间轴标签:
   *   <X-word-ms ms="..." index=n character_ranges=...>句子文本</X-word-ms>
   * 用 DOM 解析剥掉全部标签,顺带解码 HTML 实体(&amp; 等)
   */
  function stripCueMarkup(text) {
    const span = document.createElement('span');
    span.innerHTML = text || '';
    return (span.textContent || '').trim();
  }

  /** 等条件成立的轮询工具(间隔 300ms,超时返回 false) */
  function waitFor(cond, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        let ok = false;
        try { ok = !!cond(); } catch (e) { /* 读取异常视为未就绪 */ }
        if (ok) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  /**
   * 抓取 X 自动字幕(零网络请求):
   * X 为多数视频提供自动字幕轨,挂在 video.textTracks(kind=subtitles,
   * 如 "en (auto-generated)")。浏览器只在轨道非 disabled 时才加载 cue 文件,
   * 因此把轨道置为 hidden 等 cues 就绪后读出,再恢复 disabled。
   * 返回 { cues:[{index,start,end,text}], skipTranslate:false, route }
   */
  async function fetchSubtitles() {
    const vk = getVideoKey();
    if (!vk) throw new Error('不在帖子页');
    const video = getVideoElement();
    if (!video) throw new Error('未找到视频播放器');

    // textTracks 在元数据加载后才出现,短暂等待
    await waitFor(() => video.textTracks && video.textTracks.length > 0, TRACK_WAIT_MS);
    const tracks = Array.from(video.textTracks || [])
      .filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    if (!tracks.length) {
      throw new Error('该视频无可用字幕(X 未提供自动字幕)');
    }
    // 英文轨优先(配音目标是译成中文),否则取第一条
    const track = tracks.find((t) => (t.language || '').toLowerCase().indexOf('en') === 0) || tracks[0];

    const hadCues = track.cues && track.cues.length > 0;
    if (!hadCues) {
      track.mode = 'hidden';
      const loaded = await waitFor(() => track.cues && track.cues.length > 0, CUES_WAIT_MS);
      if (!loaded) {
        track.mode = 'disabled';
        throw new Error('字幕加载超时,请重试');
      }
    }

    const parsed = Array.from(track.cues)
      .map((c) => ({ start: c.startTime, end: c.endTime, text: stripCueMarkup(c.text) }))
      .filter((c) => c.text && c.end > c.start);
    track.mode = 'disabled'; // cues 已入内存,恢复默认态,不与 X 播放器抢轨道
    if (!parsed.length) throw new Error('字幕内容为空');

    // 按句尾标点把碎片重组为完整句子(减少 TTS 调用,避免半句割裂)
    const merged = DubCommon.mergeIntoSentences(parsed)
      .map((c, i) => ({ index: i, start: c.start, end: c.end, text: c.text }));
    return { cues: merged, skipTranslate: false, route: 'X 自动字幕' };
  }

  /* ---------------- 自动抓字幕(SPA 巡检触发) ---------------- */
  // 设计要点(与 YouTube/B 站对齐):
  // - 静默:不弹加载浮层、不暂停视频、不抢焦点,只用顶部 toast 反馈一次
  // - 延后:页面停留/视频加载后超过 1.5 秒才抓(避免快速划过浪费请求)
  // - 去重:本会话同 videoKey 只抓一次;SPA 切帖子后由 ensureInjected 清空并重抓
  // - 不与配音冲突:用户已开配音时让主动流程接管
  const AUTO_FETCH_DELAY_MS = 1500;
  const autoFetchedVideoKeys = new Set();
  let autoFetchTimer = null;

  function scheduleAutoFetchSubs(videoKey) {
    if (!videoKey) return;
    if (autoFetchedVideoKeys.has(videoKey)) return;
    autoFetchedVideoKeys.add(videoKey);
    clearTimeout(autoFetchTimer);
    autoFetchTimer = setTimeout(() => {
      runAutoFetchSubs(videoKey).catch(() => {});
    }, AUTO_FETCH_DELAY_MS);
  }

  async function runAutoFetchSubs(videoKey) {
    // 1) 本地缓存短路
    let cached = null;
    try {
      cached = await VdcCache.getSubtitles(videoKey);
    } catch (e) {
      /* storage 异常继续走抓取 */
    }
    if (cached && Array.isArray(cached.cues) && cached.cues.length) {
      console.log('[transnotes] 自动抓字幕:命中缓存', videoKey, cached.cues.length, '句');
      return;
    }
    // 2) 用户已开配音则跳过
    if (state === 'loading' || state === 'active') return;
    // 3) 静默抓取
    try {
      const sub = await fetchSubtitles();
      // 抓取期间切换了帖子:丢弃陈旧结果
      const vkNow = getVideoKey();
      if (!vkNow || vkNow.key !== videoKey) return;
      await DubCommon.safeSendMessage({
        type: 'SUBS_AUTO_READY',
        videoId: videoKey,
        videoKey,
        site: 'x',
        title: document.title || '',
        url: location.href,
        route: sub.route,
        skipTranslate: false, // 英文轨,翻译由 Background 按需补
        cues: sub.cues.map((c) => ({
          index: c.index, start: c.start, end: c.end, text: c.text,
        })),
      });
      console.log('[transnotes] 自动抓字幕完成:', videoKey, sub.cues.length, '句');
      showAutoToast(`字幕已就绪 · ${sub.cues.length} 句`, 'ok');
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/无可用字幕|不在帖子页|未找到视频/.test(msg)) {
        showAutoToast('该视频暂无可用字幕', 'nosubs');
      } else {
        console.warn('[transnotes] 自动抓字幕失败:', msg);
        showAutoToast('字幕准备失败,请手动开启配音重试', 'error');
      }
    }
  }

  function resetAutoFetch() {
    autoFetchedVideoKeys.clear();
    clearTimeout(autoFetchTimer);
    autoFetchTimer = null;
  }

  /* ---------------- 配音期间压制 X 原生字幕显示 ---------------- */
  // 用户若开着 CC,X 会显示自己的字幕层;配音期间压成 hidden,停止时恢复
  function hideNativeSubtitle() {
    const video = getVideoElement();
    if (!video) return;
    for (const t of Array.from(video.textTracks || [])) {
      if (t.mode === 'showing') {
        t.mode = 'hidden';
        hiddenTrackBackup = t;
      }
    }
  }

  function showNativeSubtitle() {
    if (hiddenTrackBackup) {
      try { hiddenTrackBackup.mode = 'showing'; } catch (e) { /* 元素已被重建则忽略 */ }
      hiddenTrackBackup = null;
    }
  }

  /* ---------------- 主流程:开始 / 停止 ---------------- */

  async function onToggleClick() {
    console.log('[transnotes] 配音按钮被点击(X), 当前状态:', state);
    if (!DubCommon.isContextValid()) {
      setState('error');
      setStatus('扩展已更新,请刷新页面后重试', '#c00');
      return;
    }
    if (state === 'active' || state === 'loading') {
      // loading 中点击 = 取消加载;active 中点击 = 停止配音
      await stopDubbing();
      return;
    }
    try {
      await startDubbing();
    } catch (e) {
      console.error('[transnotes] 启动配音失败:', e);
      clearTimeout(loadingWatchdog);
      loadingWatchdog = null;
      hideLoadingOverlay();
      const v = getVideoElement();
      if (v && v.paused) v.play().catch(() => {}); // 加载阶段的暂停由我们发起,失败时恢复
      showNativeSubtitle();
      setState('error');
      setStatus((e && e.message) || String(e), '#c00');
    }
  }

  async function startDubbing() {
    setState('loading');
    setStatus('正在抓取字幕...');

    const video = getVideoElement();
    if (!video) throw new Error('未找到视频播放器');

    // 先暂停视频并展示加载浮层,待首批语音缓冲就绪后自动续播
    // 浮层只显示"AI 语音翻译中"+ GIF,不显示动态进度文案(保持 UI 安静)
    video.pause();
    showLoadingOverlay();

    const vk = getVideoKey();
    const dubVideoId = vk ? vk.key : null;
    let route = 'X 自动字幕';
    // 字幕缓存命中则跳过抓取(同一视频二次配音/换音色重配时秒进合成阶段)
    const cachedDoc = dubVideoId
      ? await VdcCache.getSubtitles(dubVideoId).catch(() => null) : null;
    if (cachedDoc && cachedDoc.cues && cachedDoc.cues.length) {
      cues = cachedDoc.cues;
      console.log('[transnotes] 字幕命中缓存,跳过抓取:', dubVideoId, '| 共', cues.length, '句');
    } else {
      const sub = await fetchSubtitles();
      cues = sub.cues;
      route = sub.route;
    }
    hideNativeSubtitle();
    // 打印首句便于核对字幕与视频是否对应
    console.log('[transnotes] 字幕首句:', cues[0] && cues[0].text, '| 共', cues.length, '句');

    // 抓字幕期间可能切换了帖子
    const vkAfter = getVideoKey();
    if (!vkAfter || vkAfter.key !== dubVideoId) {
      throw new Error('页面帖子已切换,请重新点击「中文配音」');
    }
    setStatus(`共 ${cues.length} 句,启动流水线...`);
    showLoadingOverlay();

    activeVideoId = dubVideoId;
    cueAudioCache = new Map();

    const now = video.currentTime || 0;
    const startCue = cues.find((c) => c.end > now);
    const startIndex = startCue ? startCue.index : 0;
    pendingStartIndex = startIndex;

    syncPlayer = new SyncPlayer({
      cues,
      getAudio: (index) => {
        const entry = cueAudioCache.get(index);
        return entry ? { url: entry.url, duration: entry.duration } : null;
      },
      speed: 1.0, // 真实语速由 Background 在 TTS 合成时使用;此处仅播放速率
      onBuffering: (buffering) => {
        // 播放中缓冲(某句合成跟不上):同样给暂停一个视觉提示
        if (state !== 'active') return;
        if (buffering) {
          showLoadingOverlay();
          setStatus('正在等待语音合成(缓冲中)...', '#f90');
        } else {
          hideLoadingOverlay();
          setStatus('', '');
        }
      },
    });
    syncPlayer.attach(video);

    // 静音原声;配音期间用户通过音量控件取消静音时重新静音(恢复原声请点「停止配音」)
    video.muted = true;
    video.removeEventListener('volumechange', onVolumeChange);
    video.addEventListener('volumechange', onVolumeChange);

    const resp = await DubCommon.safeSendMessage({
      type: 'DUB_START',
      videoId: activeVideoId,
      videoKey: activeVideoId,           // 已是 x:{statusId} 形式,直接作共享缓存 key
      site: 'x',
      title: document.title || '',
      url: location.href,
      route,
      startIndex,
      skipTranslate: false, // X 字幕是英文,走 AI 翻译再 TTS
      cues: cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })),
    });
    if (!resp || !resp.ok) {
      video.muted = false;
      throw new Error((resp && resp.error) || '启动失败');
    }

    // 不立即开播:视频保持暂停+加载浮层,等首批缓冲就绪后由 beginPlayback() 续播;
    // 看门狗超时兜底,防止流水线异常时永远卡在加载态
    allReady = false;
    clearTimeout(loadingWatchdog);
    loadingWatchdog = setTimeout(() => {
      if (state === 'loading') {
        console.warn('[transnotes] 首批缓冲超时,兜底开播(后续句走单句缓冲)');
        beginPlayback();
      }
    }, LOADING_WATCHDOG_MS);
    checkInitialBuffer();
  }

  /** 首批缓冲目标:从起始句起的连续 INITIAL_BUFFER_CUES 句(不足则取剩余全部) */
  function initialBufferTarget() {
    const remaining = cues.filter((c) => c.index >= pendingStartIndex);
    return remaining.slice(0, INITIAL_BUFFER_CUES);
  }

  /** 检查首批缓冲进度;就绪则自动开播(loading 态下由音频到达事件驱动) */
  function checkInitialBuffer() {
    if (state !== 'loading' || !activeVideoId) return;
    const target = initialBufferTarget();
    const ready = target.filter((c) => cueAudioCache.has(c.index)).length;
    if (target.length === 0 || ready >= target.length) {
      beginPlayback();
    } else {
      showLoadingOverlay('');  // 仅 GIF 动画,不再显示调试进度
    }
  }

  /** 首批缓冲就绪:收起加载浮层,启动播放引擎并自动续播视频 */
  function beginPlayback() {
    if (state !== 'loading') return;
    clearTimeout(loadingWatchdog);
    loadingWatchdog = null;
    hideLoadingOverlay();
    syncPlayer.start();
    const video = getVideoElement();
    if (video && video.paused) video.play().catch(() => {});
    setState('active');
    setStatus('首批语音已就绪,后续边合成边播', '#0a7d33');
    setTimeout(() => {
      if (state === 'active') setStatus('', '');
    }, 3000);
  }

  async function stopDubbing() {
    const wasLoading = state === 'loading';
    DubCommon.safeSendMessage({ type: 'DUB_STOP', videoId: activeVideoId });
    clearTimeout(loadingWatchdog);
    loadingWatchdog = null;
    hideLoadingOverlay();
    if (syncPlayer) {
      syncPlayer.stop();
      syncPlayer = null;
    }
    const video = getVideoElement();
    if (video) {
      video.muted = false;
      video.removeEventListener('volumechange', onVolumeChange);
      // 加载阶段被取消:视频是我们暂停的,恢复播放,避免画面卡在暂停态
      if (wasLoading && video.paused) video.play().catch(() => {});
    }
    allReady = false;
    // 释放 Blob URL
    for (const entry of cueAudioCache.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cueAudioCache = new Map();
    activeVideoId = null;
    cues = [];
    showNativeSubtitle();
    setState('idle');
    setStatus('已恢复原声');
  }

  /* ---------------- 音频接收与缓存 ---------------- */

  const chunkHandler = DubCommon.createChunkHandler({
    getCache: () => cueAudioCache,
    onProgress: () => {
      if (state === 'loading') checkInitialBuffer();
    },
  });

  chrome.runtime.onMessage.addListener((msg) => {
    // 上下文失效(扩展被重载)时,回调内的 chrome API 调用可能同步抛错,
    // 包一层 try/catch 防止其变成页面 Uncaught 错误
    try {
      switch (msg.type) {
      case 'DUB_CUE_READY': {
        if (msg.videoId !== activeVideoId) return;
        if (cueAudioCache.has(msg.index)) return;
        try {
          const bytes = DubCommon.base64ToBytes(msg.base64);
          const blob = new Blob([bytes], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          cueAudioCache.set(msg.index, { url, duration: 0 });
          probeDuration(msg.index, url);
          console.log('[transnotes] 收到音频:', msg.index, '(已缓存', cueAudioCache.size, '句)');
          if (state === 'loading') checkInitialBuffer();
        } catch (e) {
          console.error('[transnotes] 音频解码失败:', e);
        }
        break;
      }
      case 'DUB_CHUNK_READY': {
        // 合并块:整段音频 + 每句时间区间,切分回逐句 WAV 后入缓存
        if (msg.videoId !== activeVideoId) return;
        chunkHandler(msg).catch((e) => console.error('[transnotes] 合并音频切分失败:', e));
        break;
      }
      case 'DUB_ALL_READY': {
        if (msg.videoId !== activeVideoId) return;
        allReady = true;
        if (state === 'active') {
          setStatus('全部语音已就绪', '#0a7d33');
          setTimeout(() => {
            if (state === 'active') setStatus('', '');
          }, 3000);
        }
        break;
      }
      case 'DUB_ERROR': {
        if (msg.videoId !== activeVideoId) return;
        stopDubbing();
        setState('error');
        setStatus(msg.message || '合成失败', '#c00');
        break;
      }
      case 'VDC_SEEK': {
        // 侧边栏时间戳跳转:跳到指定位置并继续播放
        const v = getVideoElement();
        if (v && typeof msg.ts === 'number') {
          v.currentTime = msg.ts;
          if (v.paused) v.play().catch(() => {});
        }
        break;
      }
      default:
        break;
      }
    } catch (e) {
      // 上下文失效等场景:静默忽略
    }
  });

  /** 预取音频时长(供溢出加速判断) */
  function probeDuration(index, url) {
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = url;
    probe.onloadedmetadata = () => {
      const entry = cueAudioCache.get(index);
      if (entry) entry.duration = probe.duration;
    };
  }

  /** 配音期间保持原声静音(用户调音量导致取消静音时自动恢复静音) */
  function onVolumeChange() {
    if (state !== 'active') return;
    const video = getVideoElement();
    if (video && !video.muted) video.muted = true;
  }

  /* ---------------- 启动与 SPA 切帖子巡检 ---------------- */

  injectStyles();

  let patrolTimer = null; // 巡检定时器(上下文失效时停止)

  /**
   * 持续保证按钮存在 + 检测帖子切换:
   * X 是 History API 无刷新导航,没有 yt-navigate-finish,
   * 通过比较 URL status id 变化来重置配音状态(沿用 B 站巡检模式)
   *
   * 注意:扩展重载后本脚本上下文即失效(chrome.runtime.getURL 会同步抛
   * "Extension context invalidated"),必须先自检再巡检,失效则停止巡检,
   * 等用户刷新页面加载新版脚本
   */
  function ensureInjected() {
    if (!DubCommon.isContextValid()) {
      if (patrolTimer) {
        clearInterval(patrolTimer);
        patrolTimer = null;
      }
      return;
    }
    const vk = getVideoKey();
    if (!vk) return;
    if (lastVideoKey && vk.key !== lastVideoKey) {
      // 帖子已切换:重置全部状态
      if (state === 'active' || state === 'loading') {
        stopDubbing();
      } else {
        setState('idle');
        setStatus('');
      }
      resetAutoFetch();   // 切换后允许重新触发自动抓
    }
    lastVideoKey = vk.key;
    // 主帖无视频时不注入按钮(避免挂到回复视频上误导用户)
    if (getVideoElement()) {
      injectButton();
      injectCaptureButton();
      // 进入新帖子后,后台静默预抓字幕(去重由 scheduleAutoFetchSubs 内部处理)
      scheduleAutoFetchSubs(vk.key);
    }
  }
  ensureInjected();
  patrolTimer = setInterval(ensureInjected, 2000);

  // 捕捉浮层接入(快捷键在 capture.js 内部注册;此处提供站点 hooks)
  DubCapture.init({
    getVideo: getVideoElement,
    getVideoKey: () => {
      const vk = getVideoKey();
      return vk ? vk.key : null;
    },
    getPlayerContainer,
    getLocalCues: () => cues,
  });

  /**
   * 侧边栏自动抓字幕(不开配音):复用配音的字幕链路写入共享缓存。
   * X 字幕是英文,needTranslate=true,由 Background 按需补翻译
   */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'FETCH_SUBS') return;
    (async () => {
      try {
        if (!DubCommon.isContextValid()) throw new Error('扩展已更新,请刷新页面后重试');
        const vk = getVideoKey();
        if (!vk) throw new Error('不在帖子页');
        const sub = await fetchSubtitles();
        await VdcCache.saveSubtitles(vk.key, {
          site: 'x',
          videoId: vk.key,
          title: document.title || '',
          url: location.href,
          route: sub.route,
          skipTranslate: false,
        }, sub.cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })));
        return { ok: true, videoKey: vk.key, needTranslate: true, count: sub.cues.length, route: sub.route };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    })().then(sendResponse);
    return true; // 异步响应
  });

  // 配音开关快捷键:Ctrl+Shift+D(输入框内与捕捉浮层开着时不触发)
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyD' || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
    if (globalThis.DubCapture && DubCapture.isOpen()) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    onToggleClick();
  }, true);

  // 配音进行中向侧边栏广播播放进度(字幕视图联动高亮)
  setInterval(() => {
    if (state !== 'active' || !activeVideoId || !DubCommon.isContextValid()) return;
    const v = getVideoElement();
    if (!v || v.paused) return;
    DubCommon.safeSendMessage({
      type: 'DUB_PROGRESS',
      videoKey: activeVideoId, // x 的 videoId 已是 x:{statusId} 形式
      t: v.currentTime,
    });
  }, 1000);

  // 侧边栏查询当前播放位置(助教提问定位上下文)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'VDC_GET_TIME') return;
    const v = getVideoElement();
    sendResponse({ ok: true, t: v ? v.currentTime || 0 : 0 });
  });

  // 截取当前视频画面(助教带图提问):经 Background captureVisibleTab 截取后
  // 裁剪到视频区域并压缩(≤1280 宽 jpeg)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'CAPTURE_FRAME') return;
    (async () => {
      try {
        if (!DubCommon.isContextValid()) throw new Error('扩展已更新,请刷新页面后重试');
        const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_SHOT' });
        if (!resp || !resp.ok || !resp.dataUrl) {
          throw new Error((resp && resp.error) || '截图失败');
        }
        const v = getVideoElement();
        const dataUrl = await DubCommon.cropToElement(resp.dataUrl, v);
        return { ok: true, dataUrl };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    })().then(sendResponse);
    return true; // 异步响应
  });
})();
