/**
 * Content Script:UI 按钮、字幕抓取、同步播放引擎集成
 *
 * 职责:
 * 1. 在 YouTube 视频页注入「中文配音」按钮与状态提示
 * 2. 接收 injected.js(主世界)回传的 ytInitialPlayerResponse 信息
 * 3. 点击按钮:立即暂停视频并展示加载浮层(转圈+进度文案),抓取字幕 →
 *    发 DUB_START(含当前播放位置 startIndex)给 Background → 流式模式:Background
 *    从当前位置开始按批翻译(如需)+合成并逐句推送;首批缓冲(起始句起连续 3 句)
 *    就绪后自动收起浮层并续播,后续句子边合成边播(中途某句未就绪时 SyncPlayer 暂停
 *    视频缓冲等待,同样显示加载浮层);加载中再点按钮 = 取消
 *    字幕三级通道:原生中文字幕轨(直通 TTS)> 英文轨 + tlang 自动翻译(直通)>
 *    英文轨 + DeepSeek(质量兜底);YouTube 对 timedtext 接口强制 pot(PO Token)校验,
 *    裸 baseUrl 只会返回 200 空响应;因此主路径是让主世界的 injected.js 开启播放器
 *    CC 轨道,借播放器自己带 pot 的字幕请求拿到数据(直接请求仅作兜底)
 * 4. 接收 DUB_CUE_READY 音频并缓存;DUB_ALL_READY 仅作状态通知;DUB_ERROR 做状态流转
 * 5. 处理:静音原声、seek 位置同步、广告暂停、SPA 导航重置
 */
(function () {
  'use strict';

  // 版本标识:用于确认页面加载的是否为最新版(旧版残留脚本无此行)
  console.log('[transnotes] content script v5 (player-button) loaded');
  // 环境自诊断:确认脚本运行在 ISOLATED world(有 chrome API)
  console.log('[transnotes] env:', JSON.stringify({
    hasChrome: typeof chrome !== 'undefined',
    hasChromeRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
    hasOnMessage: typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.onMessage !== 'undefined',
    url: location.href.slice(0, 80),
  }));

  /**
   * 将 injected.js 动态注入页面主世界(MAIN world)。
   * 不使用 manifest 的 "world" 字段(实测部分环境会把同 manifest 的 content script
   * 错误注入到主世界,导致 chrome.runtime 不可用);改为由隔离世界的 content script
   * 创建 <script> 标签,经 web_accessible_resources 加载主世界脚本,兼容性最好。
   */
  function injectMainWorldScript() {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn('[transnotes] injected.js 注入失败:', e);
    }
  }
  injectMainWorldScript();

  const BTN_CLASS = 'transnotes-player-btn'; // 播放器控制栏内的配音按钮
  const CAP_BTN_CLASS = 'transnotes-capture-btn'; // 播放器控制栏内的「记录想法」按钮
  const STATUS_ID = 'transnotes-status';     // 播放器内左上角的状态浮层
  const STYLE_ID = 'transnotes-style';
  const MSG_SOURCE = 'transnotes-injected';
  const MSG_NAME = 'transnotes-player-response';
  const MSG_TT_NAME = 'transnotes-timedtext';   // 主世界捕获到的字幕响应
  const CMD_SOURCE = 'transnotes-content';      // Content Script → 主世界指令
  const CMD_TYPE = 'transnotes-cmd';
  const HIDE_CC_ID = 'transnotes-hide-cc';      // 配音期间隐藏原字幕的 style 元素
  const LOADING_ID = 'transnotes-loading';      // 播放器中央的加载浮层(暂停的视觉提示)
  const INITIAL_BUFFER_CUES = 3;             // 开播前至少就绪的句数(首批缓冲)
  const LOADING_WATCHDOG_MS = 60000;         // 首批缓冲看门狗:超时兜底开播

  let playerInfo = null;        // injected 回传的 {videoId, title, captionTracks}
  let state = 'idle';           // idle | loading | active | error
  let activeVideoId = null;
  let cues = [];
  let syncPlayer = null;
  let cueAudioCache = new Map(); // index → {url, duration}
  let adObserver = null;
  let allReady = false;         // 全部句子是否已推送完成(收到 DUB_ALL_READY)
  let pendingStartIndex = 0;    // 本次配音的起始句 index(首批缓冲统计基准)
  let loadingWatchdog = null;   // 首批缓冲超时定时器

  /* ---------------- UI ---------------- */

  /**
   * 按钮样式:复用 YouTube 原生 ytp-button 外观(尺寸/悬停效果与设置、
   * 全屏等原生按钮一致),仅补充激活色与禁用态;状态浮层绝对定位在播放器内左上角
   */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return true;
    // document_start 时 documentElement 可能尚未存在
    const root = document.documentElement || document.head || document.body;
    if (!root) return false;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.transnotes-player-btn{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px}',
      '.transnotes-player-btn img{width:24px;height:24px;border-radius:4px;opacity:.9;pointer-events:none}',
      '.transnotes-player-btn:hover img{opacity:1}',
      '.transnotes-player-btn.transnotes-active img{opacity:1;filter:drop-shadow(0 0 3px #E6485D)}',
      '.transnotes-player-btn[aria-disabled="true"]{opacity:.5;pointer-events:none}',
      // Shorts 页无控制栏:圆形浮动按钮,挂在播放器右上角(避开顶部标题区);
      // z-index 60 压过播放器错误层 .ytp-error(44)
      '.transnotes-player-btn.transnotes-shorts-btn{position:absolute;top:56px;right:12px;',
      'z-index:60;width:40px;height:40px;border:none;border-radius:50%;',
      'background:rgba(0,0,0,.55);cursor:pointer}',
      '.transnotes-player-btn.transnotes-shorts-btn:hover{background:rgba(0,0,0,.75)}',
      '.transnotes-player-btn.transnotes-shorts-btn img{width:22px;height:22px}',
      // 「记录想法」按钮:与配音按钮同风格(Shorts 浮动位置在配音按钮下方)
      '.transnotes-capture-btn{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px}',
      '.transnotes-capture-btn svg{width:22px;height:22px;opacity:.9;pointer-events:none;fill:#fff}',
      '.transnotes-capture-btn:hover svg{opacity:1}',
      '.transnotes-capture-btn.transnotes-shorts-btn{position:absolute;top:104px;right:12px;',
      'z-index:60;width:40px;height:40px;border:none;border-radius:50%;',
      'background:rgba(0,0,0,.55);cursor:pointer}',
      '.transnotes-capture-btn.transnotes-shorts-btn:hover{background:rgba(0,0,0,.75)}',
      // 层级必须压过播放器错误层 .ytp-error(z-index:44,实测 Shorts 会遮挡我们)
      '#transnotes-status{position:absolute;top:12px;left:12px;z-index:60;padding:4px 10px;',
      'border-radius:4px;background:rgba(0,0,0,.7);color:#fff;font-size:13px;',
      'pointer-events:none;display:none}',
      // 加载浮层:暂停期间的视觉提示(转圈+文字),pointer-events:none 不挡控制栏;
      // 层级低于按钮(60),保证加载中按钮仍可点击取消
      '#transnotes-loading{position:absolute;inset:0;z-index:59;display:none;',
      'flex-direction:column;align-items:center;justify-content:center;gap:14px;',
      'background:rgba(0,0,0,.35);pointer-events:none}',
      '.transnotes-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.25);',
      'border-top-color:#fff;border-radius:50%;animation:transnotes-spin .8s linear infinite}',
      '@keyframes transnotes-spin{to{transform:rotate(360deg)}}',
      '.transnotes-loading-text{color:#fff;font-size:14px;padding:4px 12px;',
      'border-radius:4px;background:rgba(0,0,0,.6)}',
    ].join('\n');
    root.appendChild(style);
    return true;
  }

  /** 状态浮层挂在当前激活播放器内(跟随播放器,全屏/影院模式均可见) */
  function ensureStatus() {
    let el = document.getElementById(STATUS_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = STATUS_ID;
    }
    // Shorts 滚动换 reel 后激活播放器会变,浮层跟着搬家
    return mountInPlayer(el);
  }

  /**
   * 注入配音按钮:
   * - watch 页:嵌入播放器右下控制栏(.ytp-right-controls 最左侧),
   *   与设置/全屏等原生按钮同排,与商业插件同一位置
   * - Shorts 页:无右下控制栏,改为挂在激活 reel 播放器右上角的圆形浮动按钮
   */
  function injectButton() {
    injectStyles(); // 每次重试都补样式(root 早先可能不存在)
    // Shorts 页 DOM 里也存在 .ytp-right-controls,但 chrome-bottom 整体是 0x0 隐藏的,
    // 必须实际可见才用控制栏,否则改用浮动按钮
    const controlsRaw = document.querySelector('.ytp-right-controls');
    const controls = controlsRaw && controlsRaw.getBoundingClientRect().width > 0
      ? controlsRaw : null;
    const player = getPlayerContainer();

    const existing = document.querySelector('.' + BTN_CLASS);
    if (existing) {
      // YouTube 重建控制栏 / Shorts 滚动换 reel 后,按钮可能挂错位置,搬家修正
      if (controls) {
        existing.classList.remove('transnotes-shorts-btn');
        if (existing.parentNode !== controls) controls.insertBefore(existing, controls.firstChild);
      } else if (isShortsPage() && player) {
        existing.classList.add('transnotes-shorts-btn');
        if (existing.closest('#movie_player') !== player) player.appendChild(existing);
      }
      return ensureStatus();
    }

    const btn = document.createElement('button');
    btn.className = 'ytp-button ' + BTN_CLASS;
    btn.title = '中文配音';
    btn.setAttribute('aria-label', '中文配音');
    // 图标用扩展内 PNG(中/A 翻译图标);资源需在 manifest 的
    // web_accessible_resources 中声明,否则页面上下文无法加载
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/button.png');
    img.alt = '';
    btn.appendChild(img);
    btn.addEventListener('click', onToggleClick);

    if (controls) {
      controls.insertBefore(btn, controls.firstChild);
      return ensureStatus();
    }
    if (isShortsPage() && player) {
      btn.classList.add('transnotes-shorts-btn');
      player.appendChild(btn);
      return ensureStatus();
    }
    return false;
  }

  /**
   * 注入「记录想法」按钮:位置跟随配音按钮(控制栏内嵌 / Shorts 浮动),
   * 点击打开捕捉浮层(与快捷键 Ctrl/Cmd+Shift+S 等效)
   */
  function injectCaptureButton() {
    if (!globalThis.DubCapture) return false;
    injectStyles();
    const controlsRaw = document.querySelector('.ytp-right-controls');
    const controls = controlsRaw && controlsRaw.getBoundingClientRect().width > 0
      ? controlsRaw : null;
    const player = getPlayerContainer();

    const existing = document.querySelector('.' + CAP_BTN_CLASS);
    if (existing) {
      if (controls) {
        existing.classList.remove('transnotes-shorts-btn');
        if (existing.parentNode !== controls) controls.insertBefore(existing, controls.firstChild);
      } else if (isShortsPage() && player) {
        existing.classList.add('transnotes-shorts-btn');
        if (existing.closest('#movie_player') !== player) player.appendChild(existing);
      }
      return true;
    }

    const btn = document.createElement('button');
    btn.className = 'ytp-button ' + CAP_BTN_CLASS;
    btn.title = '记录想法(Ctrl+Shift+S)';
    btn.setAttribute('aria-label', '记录想法');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z' +
      'M20.7 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    btn.addEventListener('click', () => DubCapture.open());

    if (controls) {
      controls.insertBefore(btn, controls.firstChild);
      return true;
    }
    if (isShortsPage() && player) {
      btn.classList.add('transnotes-shorts-btn');
      player.appendChild(btn);
      return true;
    }
    return false;
  }

  /**
   * 加载浮层:挂在 #movie_player 内居中显示(转圈+文案),
   * 用于"点击后暂停加载"与"播放中缓冲"两种暂停场景的视觉提示
   */
  function showLoadingOverlay(text) {
    let el = document.getElementById(LOADING_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = LOADING_ID;
      el.innerHTML =
        '<div class="transnotes-spinner"></div><div class="transnotes-loading-text"></div>';
    }
    // 挂到当前激活播放器(Shorts 换 reel 时跟随搬家);播放器未就绪则暂不显示
    if (!mountInPlayer(el)) return;
    el.querySelector('.transnotes-loading-text').textContent = text || '';
    el.style.display = 'flex';
  }

  function hideLoadingOverlay() {
    const el = document.getElementById(LOADING_ID);
    if (el) el.style.display = 'none';
  }

  function setStatus(text, color) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#fff';
    el.style.display = text ? 'block' : 'none';
  }

  /* ---------------- 顶部 toast(自动抓字幕结果反馈) ---------------- */
  // 挂在播放器顶部居中的细条,只展示自动抓结果(成功/失败/无字幕),不打扰用户
  const AUTO_TOAST_ID = 'transnotes-auto-toast';
  let autoToastTimer = null;
  function showAutoToast(text, kind) {
    let el = document.getElementById(AUTO_TOAST_ID);
    const container = getPlayerContainer();
    if (!container) return; // 播放器不在则不挂(避免污染页面其他区域)
    if (!el) {
      el = document.createElement('div');
      el.id = AUTO_TOAST_ID;
      el.style.cssText = [
        'position:absolute', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:60', 'padding:6px 14px', 'border-radius:6px',
        'font:13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
        'box-shadow:0 1px 3px rgba(0,0,0,.18)', 'pointer-events:none',
        'opacity:0', 'transition:opacity .2s', 'max-width:80%', 'text-align:center',
      ].join(';');
      container.appendChild(el);
    }
    // 配色:成功=中性灰底白字(不打扰);失败=浅红底(给出信号但不抢眼);无字幕=灰底
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
    // 强制 reflow 让 transition 生效
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
      // loading 中按钮保持可点:点击视为取消加载(回到 idle)
      btn.setAttribute('aria-disabled', 'false');
    }
    if (next === 'error') {
      const status = document.getElementById(STATUS_ID);
      if (status && !status.textContent) setStatus('配音已停止');
    }
  }

  /* ---------------- 消息:主世界 → Content Script ---------------- */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE || data.type !== MSG_NAME) return;
    // SPA 切换瞬间可能收到上一个视频的陈旧推送,必须与当前页面视频一致才接受
    const pageId = getCurrentVideoId();
    if (pageId && data.data.videoId !== pageId) return;
    // 同一视频重复推送时保留已有字幕信息即可
    if (playerInfo && playerInfo.videoId === data.data.videoId && playerInfo.captionTracks.length > 0) {
      return;
    }
    playerInfo = data.data;
    // 后台静默预抓字幕:用户停留超过 1.5 秒的视频才值得抓(快速划过的不浪费请求),
    // 抓取成功后写入共享缓存,笔记/概览/配音/问答全部零成本复用
    scheduleAutoFetchSubs();
  });

  /* ---------------- 字幕抓取 ---------------- */

  /**
   * 抓取字幕,三级通道(优先级从高到低):
   * 1. 原生中文字幕轨 → 直通 TTS,跳过 DeepSeek
   * 2. 英文轨 + 借带 pot 的 URL 改 tlang=zh-Hans 重取 YouTube 机器自动翻译 → 直通 TTS
   * 3. 英文轨原文 → DeepSeek 翻译(质量最高,兜底)
   * @returns {Promise<{cues: Array, skipTranslate: boolean, route: string}>}
   */
  async function fetchSubtitles() {
    if (!playerInfo) throw new Error('未获取到播放器数据,请刷新页面重试');
    // 防御:playerInfo 必须对应当前页面视频(SPA 切换后可能有陈旧数据残留)
    const pageId = getCurrentVideoId();
    if (pageId && playerInfo.videoId !== pageId) {
      throw new Error('播放器数据尚未切换完成,请稍后再点击「中文配音」');
    }
    const tracks = Subtitles.extractCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: playerInfo.captionTracks } } });
    const zhTrack = Subtitles.selectChineseTrack(tracks);
    const enTrack = Subtitles.selectTrack(tracks);
    if (!zhTrack && !enTrack) throw new Error('该视频无可用字幕(需中文或英文)');
    const track = zhTrack || enTrack;

    let json = null;
    let capturedUrl = null;
    try {
      // 主路径:借播放器带 pot 的 timedtext 请求获取字幕(含完整 URL)
      const cap = await fetchCaptionsViaPlayer(playerInfo.videoId, track);
      json = cap.json;
      capturedUrl = cap.url;
    } catch (e) {
      // 兜底:直接请求 baseUrl(YouTube 未强制 pot 的环境仍可用)
      json = await fetchCaptionsDirect(track);
    } finally {
      // 无论成败,恢复用户原字幕轨道状态
      window.postMessage({ source: CMD_SOURCE, type: CMD_TYPE, cmd: 'restore-captions' }, '*');
    }

    if (zhTrack) {
      return { cues: parseToCues(json), skipTranslate: true, route: '中文字幕轨' };
    }
    // 英文轨:先试 YouTube 机器自动翻译(tlang),不可用再回退 DeepSeek
    if (capturedUrl) {
      try {
        const zhJson = await fetchTranslatedCaptions(capturedUrl, 'zh-Hans');
        const zhCues = parseToCues(zhJson);
        // 机翻直通时把英文原文对齐进 cues(text=en, zh=机翻中文),
        // 否则双语/原文视图只剩中文可显示
        try {
          attachOriginal(zhCues, parseToCues(json));
        } catch (e) {
          console.warn('[transnotes] 英文原文对齐失败,双语视图将只显示中文:', (e && e.message) || e);
        }
        return { cues: zhCues, skipTranslate: true, route: 'YouTube 自动翻译' };
      } catch (e) {
        console.warn('[transnotes] 自动翻译字幕不可用,回退英文 + DeepSeek:', (e && e.message) || e);
      }
    }
    return { cues: parseToCues(json), skipTranslate: false, route: '英文 + DeepSeek' };
  }

  /* ---------------- 自动抓字幕(playerInfo 就绪后延后触发) ---------------- */
  // 设计要点:
  // - 静默:不弹加载浮层、不暂停视频、不抢焦点,只用顶部 toast 反馈一次
  // - 延后:用户停留超过 1.5 秒的视频才抓(SPA 快速划过的不浪费请求)
  // - 去重:同会话同视频只抓一次;缓存命中由 Background 短路,但我们仍读 cache
  //   做一次本地短路,避免无谓地向 Background 发空消息
  // - 不与配音冲突:用户已开配音时让主动流程接管,本函数直接返回
  const AUTO_FETCH_DELAY_MS = 1500;
  const autoFetchedVideoIds = new Set();  // 本会话内已发起过自动抓的视频 id
  let autoFetchTimer = null;

  function scheduleAutoFetchSubs() {
    if (!playerInfo || !playerInfo.videoId) return;
    const videoId = playerInfo.videoId;
    if (autoFetchedVideoIds.has(videoId)) return;
    autoFetchedVideoIds.add(videoId);
    clearTimeout(autoFetchTimer);
    autoFetchTimer = setTimeout(() => {
      runAutoFetchSubs(videoId).catch(() => {});
    }, AUTO_FETCH_DELAY_MS);
  }

  async function runAutoFetchSubs(videoId) {
    // 1) 本地缓存短路:已经抓过就不抓
    const cacheKey = 'yt:' + videoId;
    let cached = null;
    try {
      cached = await VdcCache.getSubtitles(cacheKey);
    } catch (e) {
      /* storage 异常,继续走抓取路径,失败时由 Background 兜底 */
    }
    if (cached && Array.isArray(cached.cues) && cached.cues.length) {
      console.log('[transnotes] 自动抓字幕:命中缓存', cacheKey, cached.cues.length, '句');
      return;
    }
    // 2) 用户已经主动开配音:让主动流程负责,自动抓不重复
    if (state === 'loading' || state === 'active') return;
    // 3) 静默抓取
    try {
      const sub = await fetchSubtitles();
      // 抓取期间页面可能已切换(SPA):核对一次 videoId,陈旧结果丢弃
      const pageId = getCurrentVideoId();
      if (pageId && pageId !== videoId) return;
      await DubCommon.safeSendMessage({
        type: 'SUBS_AUTO_READY',
        videoId,
        videoKey: cacheKey,
        site: 'youtube',
        title: (playerInfo && playerInfo.title) || document.title || '',
        url: location.href,
        route: sub.route,
        skipTranslate: sub.skipTranslate,
        cues: sub.cues.map((c) => ({
          index: c.index, start: c.start, end: c.end, text: c.text, zh: c.zh,
        })),
      });
      console.log('[transnotes] 自动抓字幕完成:', cacheKey, sub.cues.length, '句');
      showAutoToast(`字幕已就绪 · ${sub.cues.length} 句`, 'ok');
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 无字幕视频静默告知一次(用户看到提示就知道这个视频不能生成笔记)
      if (/无可用字幕|未获取到播放器数据|请刷新/.test(msg)) {
        showAutoToast('该视频暂无可用字幕', 'nosubs');
      } else {
        // 其他失败(如 pot 接口异常、网络):也给一次提示,但不打断
        console.warn('[transnotes] 自动抓字幕失败:', msg);
        showAutoToast('字幕准备失败,请手动开启配音重试', 'error');
      }
    }
  }

  // SPA 切视频:清空去重集合并触发新视频的自动抓
  function resetAutoFetch() {
    autoFetchedVideoIds.clear();
    clearTimeout(autoFetchTimer);
    autoFetchTimer = null;
  }

  /**
   * 把英文原文按时间重叠对齐进机翻中文 cues:z.text 从中文改为对应的英文原文,
   * 中文挪入 z.zh。两轨时间轴一致,但语义重组的分句边界可能不同(中英文标点差异),
   * 因此对每条中文句拼接与其时间区间重叠的所有英文句,保证对照完整
   */
  function attachOriginal(zhCues, enCues) {
    for (const z of zhCues) {
      const parts = [];
      for (const e of enCues) {
        if (e.end <= z.start) continue;
        if (e.start >= z.end) break; // enCues 按 start 升序,之后不会再有重叠
        parts.push(e.text);
      }
      z.zh = z.text;
      z.text = parts.join(' ') || z.zh; // 对齐不到时退回中文(不出现空原文)
    }
  }

  /** timedtext JSON → 语义重组后的完整句子序列;内容为空时抛错 */
  function parseToCues(json) {
    const parsed = Subtitles.parseTimedText(json);
    if (parsed.length === 0) throw new Error('字幕内容为空');
    // 先合并过碎片段,再按句尾标点重组为完整句子(修复半句话被单独合成的割裂感)
    const merged = Subtitles.mergeCues(parsed);
    return Subtitles.assignIndexes(DubCommon.mergeIntoSentences(merged));
  }

  /**
   * 借带 pot 的字幕 URL 改参数重取 YouTube 机器自动翻译(tlang)字幕。
   * 时间轴与原轨道一致,文本为谷歌机翻中文
   */
  async function fetchTranslatedCaptions(potUrl, tlang) {
    const u = new URL(potUrl);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.set('tlang', tlang);
    const resp = await fetch(u.toString(), { credentials: 'include' });
    if (!resp.ok) throw new Error(`自动翻译字幕请求失败(HTTP ${resp.status})`);
    const text = await resp.text();
    if (!text.trim()) throw new Error('自动翻译字幕返回空内容');
    return JSON.parse(text);
  }

  /**
   * 主世界协同抓取:让播放器开启英文字幕轨道,
   * 捕获 injected.js hook 到的带 pot 参数的 timedtext 响应。
   * 返回 { json, url }:json 为解析后的字幕数据,url 为带 pot 的完整请求 URL
   * (供 tlang 自动翻译重取使用)
   */
  function fetchCaptionsViaPlayer(videoId, track) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('字幕获取超时'));
      }, 12000);

      const onMessage = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== MSG_SOURCE || d.type !== MSG_TT_NAME) return;
        if (!d.data || !d.data.url || !d.data.body) return;
        // 只接受当前视频、目标语言的字幕
        if (d.data.url.indexOf('v=' + videoId) === -1) return;
        const lang = track.languageCode || 'en';
        if (d.data.url.indexOf('lang=') !== -1 && d.data.url.indexOf('lang=' + lang) === -1) return;
        cleanup();
        try {
          resolve({ json: JSON.parse(d.data.body), url: d.data.url });
        } catch (e) {
          reject(new Error('字幕数据解析失败'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      };

      window.addEventListener('message', onMessage);
      window.postMessage({
        source: CMD_SOURCE,
        type: CMD_TYPE,
        cmd: 'enable-captions',
        videoId,
        track: { languageCode: track.languageCode, kind: track.kind },
      }, '*');
    });
  }

  /** 兜底:直接请求 timedtext baseUrl(带空响应保护) */
  async function fetchCaptionsDirect(track) {
    const url = Subtitles.buildTimedTextUrl(track);
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`字幕抓取失败(HTTP ${resp.status})`);
    const text = await resp.text();
    if (!text.trim()) {
      throw new Error('字幕接口返回空内容(YouTube 要求 pot 校验),请刷新页面后重试');
    }
    return JSON.parse(text);
  }

  /** 配音期间隐藏播放器原字幕窗口(含借道开启 CC 的瞬间) */
  function hideCaptionWindow() {
    if (document.getElementById(HIDE_CC_ID)) return;
    const style = document.createElement('style');
    style.id = HIDE_CC_ID;
    style.textContent = '.caption-window,.ytp-caption-window-container{display:none!important}';
    document.documentElement.appendChild(style);
  }

  function showCaptionWindow() {
    const el = document.getElementById(HIDE_CC_ID);
    if (el) el.remove();
  }

  /* ---------------- 主流程:开始 / 停止 ---------------- */

  async function onToggleClick() {
    console.log('[transnotes] 配音按钮被点击, 当前状态:', state);
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
      showCaptionWindow();
      setState('error');
      setStatus((e && e.message) || String(e), '#c00');
    }
  }

  async function startDubbing() {
    setState('loading');
    setStatus('正在抓取字幕...');
    hideCaptionWindow(); // 配音期间隐藏原字幕(含借道开启 CC 的瞬间)

    const video = getVideoElement();
    if (!video) throw new Error('未找到视频播放器');

    // 商业插件式加载:先暂停视频并展示加载浮层,待首批语音缓冲就绪后自动续播
    video.pause();
    showLoadingOverlay('正在抓取字幕...');

    const dubVideoId = playerInfo ? playerInfo.videoId : null; // fetchSubtitles 会再校验
    // 字幕缓存命中则跳过抓取(同一视频二次配音/换音色重配时秒进合成阶段);
    // 旧缓存无 skipTranslate 字段,按 route 名称推断
    const cacheKey = 'yt:' + dubVideoId;
    const cachedDoc = dubVideoId
      ? await VdcCache.getSubtitles(cacheKey).catch(() => null) : null;
    let sub;
    if (cachedDoc && cachedDoc.cues && cachedDoc.cues.length) {
      sub = {
        cues: cachedDoc.cues,
        skipTranslate: typeof cachedDoc.skipTranslate === 'boolean'
          ? cachedDoc.skipTranslate
          : /中文字幕轨|自动翻译/.test(cachedDoc.route || ''),
        route: (cachedDoc.route || '') + '(缓存)',
      };
      console.log('[transnotes] 字幕命中缓存,跳过抓取:', cacheKey, '| 共', sub.cues.length, '句');
    } else {
      sub = await fetchSubtitles();
    }
    cues = sub.cues;

    // 抓取字幕期间页面可能已切换到新视频(SPA 导航):playerInfo 会被导航监听重置
    // 或更新为新视频,任一不一致都放弃本次启动,避免给新视频配旧视频的音
    const pageIdAfterFetch = getCurrentVideoId();
    if (!playerInfo || playerInfo.videoId !== dubVideoId ||
        (pageIdAfterFetch && pageIdAfterFetch !== dubVideoId)) {
      throw new Error('页面视频已切换,请重新点击「中文配音」');
    }
    console.log('[transnotes] 字幕通道:', sub.route, '| 共', cues.length, '句');
    setStatus(`共 ${cues.length} 句(${sub.route}),启动流水线...`);
    showLoadingOverlay(`共 ${cues.length} 句(${sub.route}),语音合成中...`);

    activeVideoId = dubVideoId;
    cueAudioCache = new Map();

    // 从当前播放位置开始配音:找到当前时间所在/之后的第一句
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
          showLoadingOverlay('语音合成中,缓冲等待...');
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
      videoKey: 'yt:' + activeVideoId,   // 共享缓存 key(字幕/笔记共用)
      site: 'youtube',
      title: (playerInfo && playerInfo.title) || document.title || '',
      url: location.href,
      route: sub.route,
      startIndex,
      skipTranslate: sub.skipTranslate, // 中文字幕轨/自动翻译通道:跳过 DeepSeek 直通 TTS
      cues: cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text, zh: c.zh })),
    });
    if (!resp || !resp.ok) {
      video.muted = false;
      throw new Error((resp && resp.error) || '启动失败');
    }

    // 不立即开播:视频保持暂停+加载浮层,等 DUB_CUE_READY 攒够首批缓冲后
    // 由 beginPlayback() 自动续播;看门狗超时兜底,防止流水线异常时永远卡在加载态
    allReady = false;
    watchAds();
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

  /** 检查首批缓冲进度;就绪则自动开播(loading 态下由 DUB_CUE_READY 驱动) */
  function checkInitialBuffer() {
    if (state !== 'loading' || !activeVideoId) return;
    const target = initialBufferTarget();
    const ready = target.filter((c) => cueAudioCache.has(c.index)).length;
    if (target.length === 0 || ready >= target.length) {
      beginPlayback();
    } else {
      showLoadingOverlay(`语音加载中... 首批 ${ready}/${target.length}`);
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
    if (adObserver) {
      adObserver.disconnect();
      adObserver = null;
    }
    // 释放 Blob URL
    for (const entry of cueAudioCache.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cueAudioCache = new Map();
    activeVideoId = null;
    cues = [];
    showCaptionWindow();
    setState('idle');
    setStatus('已恢复原声');
  }

  /* ---------------- 音频接收与缓存 ---------------- */

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
          if (state === 'loading') checkInitialBuffer(); // 驱动首批缓冲进度
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
        // 全部句子已推送(仅状态通知;播放早已开始)
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

  /* ---------------- 合并块音频切分(共享实现见 lib/dubcommon.js) ---------------- */

  const chunkHandler = DubCommon.createChunkHandler({
    getCache: () => cueAudioCache,
    onProgress: () => {
      if (state === 'loading') checkInitialBuffer(); // 驱动首批缓冲进度
    },
  });

  /* ---------------- 辅助 ---------------- */

  // safeSendMessage / isContextValid / base64ToBytes / 音频切分:
  // 统一由 lib/dubcommon.js 的 DubCommon 提供

  function getVideoElement() {
    const videos = Array.from(document.querySelectorAll('video.html5-main-video'));
    if (!videos.length) return document.querySelector('#movie_player video');
    if (videos.length === 1) return videos[0];
    // Shorts 会预加载相邻 reel,页面同时存在多个 video:取可视面积最大的(当前在播的)
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best || videos[0];
  }

  /**
   * 当前激活视频所属的播放器容器。
   * watch 页:video 祖先里的 #movie_player(有实际尺寸);
   * Shorts 页:#movie_player 与 video 无祖先关系且本身 0x0 隐藏(实测),
   * 此时沿 video 祖先链找第一个有实际尺寸的容器(即 #shorts-player)
   */
  function getPlayerContainer() {
    const video = getVideoElement();
    if (video) {
      const mp = video.closest ? video.closest('#movie_player') : null;
      if (mp && mp.getBoundingClientRect().width > 0) return mp;
      let el = video.parentElement;
      while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          // 浮层需要绝对定位锚点;static 容器补 relative(尺寸不变,不影响布局)
          if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
          return el;
        }
        el = el.parentElement;
      }
    }
    return document.getElementById('movie_player');
  }

  /** 把元素挂到当前激活播放器内(已挂在别处则搬家),返回是否成功 */
  function mountInPlayer(el) {
    const player = getPlayerContainer();
    if (!player) return false;
    if (el.parentNode !== player) player.appendChild(el);
    return true;
  }

  /** 当前是否为 Shorts 页 */
  function isShortsPage() {
    return location.pathname.indexOf('/shorts/') === 0;
  }

  /** 当前页面的视频 ID(watch 页取 v 参数;Shorts 页取 /shorts/{id};其他页返回 null) */
  function getCurrentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname.indexOf('/shorts/') === 0) {
        return u.pathname.split('/')[2] || null;
      }
      return u.searchParams.get('v');
    } catch (e) {
      return null;
    }
  }

  /** 配音期间保持原声静音(用户调音量导致取消静音时自动恢复静音) */
  function onVolumeChange() {
    if (state !== 'active') return;
    const video = getVideoElement();
    if (video && !video.muted) video.muted = true;
  }

  /** 广告检测:播放器进入 ad-showing 时暂停配音调度 */
  function watchAds() {
    if (adObserver) adObserver.disconnect();
    const moviePlayer = getPlayerContainer();
    if (!moviePlayer) return;
    adObserver = new MutationObserver(() => {
      const inAd = moviePlayer.classList.contains('ad-showing');
      if (inAd && syncPlayer) {
        syncPlayer.pauseSchedule();
      } else if (!inAd && syncPlayer) {
        syncPlayer.resumeSchedule();
      }
    });
    adObserver.observe(moviePlayer, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------------- 启动与 SPA 导航 ---------------- */

  injectStyles();

  let patrolTimer = null; // 巡检定时器(上下文失效时停止)

  /**
   * 持续保证按钮存在:YouTube 播放器初始化/界面重绘时会重建控制栏,
   * 一次性注入的按钮可能被抹掉,因此每 2 秒巡检一次,缺失即补
   * (injectButton 幂等:按钮已存在时只补状态浮层,开销极小)
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
    if (location.pathname.indexOf('/watch') !== 0 &&
        location.pathname.indexOf('/shorts/') !== 0) return;
    injectButton();
    injectCaptureButton();
  }
  ensureInjected();
  patrolTimer = setInterval(ensureInjected, 2000);

  // 捕捉浮层接入(快捷键在 capture.js 内部注册;此处提供站点 hooks)
  DubCapture.init({
    getVideo: getVideoElement,
    getVideoKey: () => {
      const id = getCurrentVideoId();
      return id ? 'yt:' + id : null;
    },
    getPlayerContainer,
    getLocalCues: () => cues,
  });

  /**
   * 侧边栏自动抓字幕(不开配音):复用配音的三级字幕通道抓取并写入共享缓存,
   * 之后由 Background 按需补翻译。needTranslate=true 表示是英文轨,还需 AI 翻译
   */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'FETCH_SUBS') return;
    (async () => {
      try {
        if (!DubCommon.isContextValid()) throw new Error('扩展已更新,请刷新页面后重试');
        if (!playerInfo) throw new Error('播放器数据未就绪,请稍后重试');
        const sub = await fetchSubtitles();
        const id = getCurrentVideoId();
        const videoKey = 'yt:' + id;
        await VdcCache.saveSubtitles(videoKey, {
          site: 'youtube',
          videoId: id,
          title: (playerInfo && playerInfo.title) || document.title || '',
          url: location.href,
          route: sub.route,
          skipTranslate: !!sub.skipTranslate,
        }, sub.cues.map((c) => {
          const item = { index: c.index, start: c.start, end: c.end, text: c.text };
          if (sub.skipTranslate) item.zh = c.zh || c.text; // 中文轨直通原文即中文;自动翻译通道 zh 为机翻中文
          return item;
        }));
        return {
          ok: true,
          videoKey,
          needTranslate: !sub.skipTranslate,
          count: sub.cues.length,
          route: sub.route,
        };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    })().then(sendResponse);
    return true; // 异步响应
  });

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
      videoKey: 'yt:' + activeVideoId,
      t: v.currentTime,
    });
  }, 1000);

  // SPA 导航:切视频时重置全部状态(按钮由巡检自动补注入)
  document.addEventListener('yt-navigate-finish', () => {
    if (state === 'active' || state === 'loading') {
      stopDubbing();
    } else {
      setState('idle');
      setStatus('');
    }
    playerInfo = null;
    resetAutoFetch();   // 切换视频后允许重新触发自动抓
    setTimeout(ensureInjected, 800);
  });
})();
