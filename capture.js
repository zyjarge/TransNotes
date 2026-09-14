/**
 * 捕捉浮层(YouTube / B 站共用)
 *
 * 观看中低摩擦捕捉「时间戳 + 当前字幕 + 可选截图 + 我的输入」:
 * - 触发:快捷键 Ctrl/Cmd+Shift+S,或站点脚本注入的播放器按钮(调用 DubCapture.open())
 * - 触发后视频暂停,弹出极简浮层(Shadow DOM 隔离样式,不被页面样式污染)
 * - 键盘隔离:浮层内按键在 window 捕获阶段就地拦截(早于站点的 document 监听),
 *   只拦监听器不拦默认行为——输入框照常打字,空格不会触发页面暂停/播放
 * - 预填充:时间戳 + 当前字幕(中文译文优先,来自共享缓存 VdcCache,不重调 AI)
 * - 截图:默认不插入;点「插入截图」经 Background chrome.tabs.captureVisibleTab
 *   截取当前画面(先隐藏浮层再截,避免浮层入镜;绕开跨域 canvas 污染问题),
 *   再按视频元素矩形裁剪,只保留视频画面
 * - 保存:Ctrl/Cmd+Enter;Esc 取消;关闭后若之前是播放中则自动续播
 *
 * 与配音引擎的协调:暂停走 video.pause()(触发 SyncPlayer 的 pause 事件停音),
 * 续播走 video.play()(playing 事件触发重新对齐),无需改动播放引擎。
 *
 * 站点脚本通过 DubCapture.init(hooks) 接入:
 *   hooks.getVideo()           当前 video 元素
 *   hooks.getVideoKey()        当前视频 key(yt:{id} / bili:{bvid}:p{n})
 *   hooks.getPlayerContainer() 浮层挂载容器(全屏时仍可见)
 *   hooks.getLocalCues()       可选,本次会话内存中的字幕(缓存未写入时兜底)
 */
(function () {
  'use strict';

  const HOST_ID = 'transnotes-capture';

  let hooks = null;
  let host = null;     // 浮层宿主元素(非 null 表示浮层开着)
  let session = null;  // { video, videoKey, wasPlaying, t, cue, shotId }

  /**
   * 接入站点。在站点脚本初始化时调用一次。
   * @param {object} h 见文件头注释
   */
  function init(h) {
    if (hooks) return; // 幂等
    hooks = h || {};
    window.addEventListener('keydown', onKeydown, true);
    initDraftPrompt();
  }

  /**
   * 键盘隔离:浮层开着时,浮层内的按键在 window 捕获阶段就地拦截。
   * YouTube 等站点的快捷键监听挂在 document(捕获或冒泡),都晚于 window 捕获;
   * shadow 内的事件经重定向后 target 为宿主元素,据此识别"我们的按键"。
   * stopImmediatePropagation 只阻止其他监听器,不影响默认行为——
   * 输入框照常打字,但空格/k/j/l 等不会再触发页面快捷键。
   * 浮层自身的保存/取消快捷键也在此处理(输入框的 keydown 已收不到事件)。
   */
  window.addEventListener('keydown', (e) => {
    if (!host || e.target !== host) return;
    e.stopImmediatePropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  }, true);

  /** 快捷键:Ctrl+Shift+S(Win/Linux)或 Cmd+Shift+S(macOS) */
  function onKeydown(e) {
    if (!e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
    if (e.code !== 'KeyS') return;
    e.preventDefault();
    e.stopPropagation();
    open();
  }

  /** 浮层是否开着(供站点脚本判断,避免与配音加载浮层叠加时重复暂停逻辑混乱) */
  function isOpen() {
    return !!host;
  }

  /** 打开捕捉浮层(快捷键与播放器按钮共用入口) */
  async function open() {
    if (host || !hooks) return;
    // 扩展重载后旧脚本上下文失效:静默返回会让按钮"点了没反应",必须明示
    if (!DubCommon.isContextValid()) {
      toast('扩展已更新,请刷新页面后重试');
      return;
    }
    const video = hooks.getVideo && hooks.getVideo();
    if (!video) return;
    const videoKey = hooks.getVideoKey && hooks.getVideoKey();
    if (!videoKey) return;

    const wasPlaying = !video.paused && !video.ended;
    video.pause();
    const t = video.currentTime || 0;

    // 先弹层后填字幕:存储读取是异步的,先让浮层出现(零等待感),字幕到达后再填
    session = { video, videoKey, wasPlaying, t, cue: null, shotId: null };
    buildOverlay();
    try {
      const doc = await VdcCache.getSubtitles(videoKey);
      let cue = null;
      const found = VdcCache.findCueAt(doc && doc.cues, t);
      if (found) cue = { text: found.text, zh: found.zh || '', start: found.start };
      if (!cue && hooks.getLocalCues) {
        const local = VdcCache.findCueAt(hooks.getLocalCues(), t);
        if (local) cue = { text: local.text, zh: '', start: local.start };
      }
      // 浮层可能已被用户秒关(Esc/Ctrl+Enter):session 失效则不填
      if (session && session.videoKey === videoKey && session.t === t) {
        session.cue = cue;
        fillQuote(cue);
      }
    } catch (e) { /* 缓存不可用时仍可记录纯想法 */ }
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
  }

  function buildOverlay() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:absolute;inset:0;z-index:100;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = [
      '<style>',
      '.panel{width:min(560px,86%);background:#1f1f1f;color:#fff;border-radius:10px;',
      'padding:16px 18px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)}',
      '.head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}',
      '.title{font-size:14px;font-weight:600}',
      '.ts{color:#3ea6ff;font-variant-numeric:tabular-nums;font-size:13px}',
      '.x{background:transparent;border:none;color:#999;font-size:18px;padding:0 2px;',
      'line-height:1;cursor:pointer;margin-left:10px}',
      '.x:hover{color:#fff}',
      '.quote{margin:0 0 10px;padding:8px 10px;border-left:3px solid #3ea6ff;',
      'background:rgba(255,255,255,.06);border-radius:0 6px 6px 0;color:#ddd;font-size:13px}',
      '.quote .zh{display:block;color:#fff}',
      '.quote .en{display:block;color:#999;font-size:12px;margin-top:2px}',
      'textarea{width:100%;box-sizing:border-box;min-height:72px;resize:vertical;',
      'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);',
      'border-radius:6px;color:#fff;padding:8px 10px;font:inherit;outline:none}',
      'textarea:focus{border-color:#3ea6ff}',
      '.thumb{display:none;margin-top:8px;max-height:120px;border-radius:6px;',
      'border:1px solid rgba(255,255,255,.2)}',
      '.foot{display:flex;align-items:center;gap:10px;margin-top:12px}',
      'button{cursor:pointer;border:none;border-radius:6px;padding:6px 14px;font-size:13px}',
      '.shot{background:rgba(255,255,255,.12);color:#fff}',
      '.shot:hover{background:rgba(255,255,255,.2)}',
      '.save{background:#3ea6ff;color:#0c0c0c;font-weight:600;margin-left:auto}',
      '.save:hover{background:#6fbdff}',
      '.hint{color:#888;font-size:12px}',
      '.err{color:#ff8080;font-size:12px;display:none}',
      '</style>',
      '<div class="panel">',
      '<div class="head"><span class="title">记录想法</span>',
      '<span><span class="ts"></span><button class="x" type="button" title="关闭(Esc)">×</button></span></div>',
      '<blockquote class="quote" style="display:none"><span class="zh"></span><span class="en"></span></blockquote>',
      '<textarea placeholder="此刻的想法…"></textarea>',
      '<img class="thumb" alt="截图预览">',
      '<div class="foot">',
      '<button class="shot" type="button">插入截图</button>',
      '<span class="err"></span>',
      '<span class="hint">Ctrl+Enter 保存 · Esc 取消</span>',
      '<button class="save" type="button">保存</button>',
      '</div>',
      '</div>',
    ].join('');

    const container = (hooks.getPlayerContainer && hooks.getPlayerContainer()) || document.body;
    if (container === document.body) host.style.position = 'fixed';
    container.appendChild(host);

    root.querySelector('.ts').textContent = fmtTime(session.t);

    // 保存/取消快捷键在 window 捕获阶段的键盘隔离里统一处理(见文件上部),
    // 这里只接按钮;输入框的 keydown 已收不到事件(传播在 window 捕获即被拦截,
    // 默认输入行为不受影响)
    const textarea = root.querySelector('textarea');
    root.querySelector('.save').addEventListener('click', save);
    root.querySelector('.shot').addEventListener('click', () => takeShot(root));
    root.querySelector('.x').addEventListener('click', () => close(true));
    textarea.focus();
  }

  /** 字幕异步到达后填入引用区(有译文时中文为主、原文小字;无译文只显示原文) */
  function fillQuote(cue) {
    if (!host || !cue || (!cue.text && !cue.zh)) return;
    const q = host.shadowRoot.querySelector('.quote');
    q.style.display = 'block';
    if (cue.zh) {
      q.querySelector('.zh').textContent = cue.zh;
      q.querySelector('.en').textContent = cue.text || '';
    } else {
      q.querySelector('.zh').textContent = cue.text || '';
    }
  }

  /**
   * 把整页截图按视频矩形裁剪,只保留视频画面。
   * content script 里可直接读视频元素位置;截图 dataURL 是扩展自己生成的,
   * canvas 无跨域污染。视频不在可视区时退回整页截图。
   */
  async function cropToVideo(dataUrl) {
    const v = session && session.video;
    if (!v) return dataUrl;
    const r = v.getBoundingClientRect();
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('截图解码失败'));
      i.src = dataUrl;
    });
    // captureVisibleTab 图像尺寸 = 视口 CSS 尺寸 × DPR,按比例换算裁剪区域
    const scaleX = img.naturalWidth / (window.innerWidth || img.naturalWidth);
    const scaleY = img.naturalHeight / (window.innerHeight || img.naturalHeight);
    const sx = Math.max(0, r.left * scaleX);
    const sy = Math.max(0, r.top * scaleY);
    const sw = Math.min(img.naturalWidth - sx, r.width * scaleX);
    const sh = Math.min(img.naturalHeight - sy, r.height * scaleY);
    if (sw < 10 || sh < 10) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext('2d')
      .drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  /** 截图:先隐藏浮层(否则会入镜),经 Background captureVisibleTab 截取后裁剪到视频区域 */
  async function takeShot(root) {
    const btn = root.querySelector('.shot');
    const err = root.querySelector('.err');
    err.style.display = 'none';
    btn.disabled = true;
    btn.textContent = '截图中...';
    host.style.visibility = 'hidden';
    await new Promise((r) => setTimeout(r, 250)); // 等浮层真正从画面消失
    const resp = await DubCommon.safeSendMessage({ type: 'CAPTURE_SHOT' });
    host.style.visibility = '';
    btn.disabled = false;
    btn.textContent = session.shotId ? '重新截图' : '插入截图';
    if (resp && resp.ok && resp.dataUrl) {
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        const dataUrl = await cropToVideo(resp.dataUrl);
        await VdcCache.saveShot(id, dataUrl);
        session.shotId = id;
        const thumb = root.querySelector('.thumb');
        thumb.src = dataUrl;
        thumb.style.display = 'block';
        btn.textContent = '重新截图';
      } catch (e) {
        err.textContent = '截图保存失败:' + ((e && e.message) || e);
        err.style.display = 'inline';
      }
    } else {
      err.textContent = '截图失败:' + ((resp && resp.error) || '未知错误');
      err.style.display = 'inline';
    }
  }

  /** 保存笔记并关闭;内容与截图都为空时等同取消 */
  async function save() {
    if (!session) return;
    const root = host.shadowRoot;
    const comment = (root.querySelector('textarea').value || '').trim();
    if (comment || session.shotId) {
      const note = {
        id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        ts: session.t,
        text: (session.cue && session.cue.text) || '',
        zh: (session.cue && session.cue.zh) || '',
        comment,
        shot: session.shotId,
        createdAt: Date.now(),
      };
      try {
        await VdcCache.addNote(session.videoKey, note);
      } catch (e) {
        const err = root.querySelector('.err');
        err.textContent = '保存失败:' + ((e && e.message) || e);
        err.style.display = 'inline';
        return;
      }
    }
    close(true);
  }

  /** 关闭浮层;resume 且打开前在播放则自动续播(配音引擎经 playing 事件自动重对齐) */
  function close(resume) {
    if (host) {
      host.remove();
      host = null;
    }
    const s = session;
    session = null;
    if (resume && s && s.wasPlaying && s.video.paused) {
      s.video.play().catch(() => {});
    }
  }

  /** 播放器内的轻提示(3 秒自动消失),用于扩展上下文失效等必须明示的场景 */
  function toast(text) {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;bottom:72px;left:50%;transform:translateX(-50%);z-index:101';
    const root = el.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>.t{background:rgba(20,20,20,.9);color:#fff;padding:8px 14px;border-radius:6px;' +
      'font:13px/1.5 -apple-system,"PingFang SC",sans-serif;}</style>' +
      '<div class="t"></div>';
    root.querySelector('.t').textContent = text;
    const container = (hooks && hooks.getPlayerContainer && hooks.getPlayerContainer()) || document.body;
    if (container === document.body) el.style.position = 'fixed';
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  /* ---------------- 草稿生成提示条 ----------------
   * 视频播放结束(ended)或中途离开(切视频/分P/离开页面)时,
   * 若该视频有笔记或字幕缓存,提示用户是否生成笔记草稿(由用户决定)。
   */

  const promptedKeys = new Set(); // 每个视频每次会话只提示一次
  let lastPromptKey = null;       // 巡检用:上一次看到的 videoKey

  function initDraftPrompt() {
    // ended 不冒泡,用捕获阶段监听;只响应主视频元素
    document.addEventListener('ended', (e) => {
      const v = hooks.getVideo && hooks.getVideo();
      if (v && e.target === v) {
        const key = hooks.getVideoKey && hooks.getVideoKey();
        if (key) maybePrompt(key);
      }
    }, true);
    // 中途离开检测:两站统一用 2 秒巡检比较 videoKey(YouTube SPA 与 B 站分 P 都是无刷新导航)
    setInterval(() => {
      if (!DubCommon.isContextValid()) return;
      const key = hooks.getVideoKey ? hooks.getVideoKey() : null;
      if (lastPromptKey && key !== lastPromptKey) maybePrompt(lastPromptKey);
      lastPromptKey = key;
    }, 2000);
  }

  async function maybePrompt(videoKey) {
    if (promptedKeys.has(videoKey) || host) return; // 已提示过 / 捕捉浮层开着时不打扰
    let notes = [];
    let doc = null;
    try {
      notes = await VdcCache.getNotes(videoKey);
      doc = await VdcCache.getSubtitles(videoKey);
    } catch (e) { return; }
    // 没记过笔记也没开过配音(无字幕缓存)的视频,草稿没有内容,不提示
    if (!notes.length && !doc) return;
    promptedKeys.add(videoKey);
    showBanner(videoKey, notes.length, doc && doc.title);
  }

  function showBanner(videoKey, noteCount, title) {
    const banner = document.createElement('div');
    banner.style.cssText =
      'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:101';
    const root = banner.attachShadow({ mode: 'open' });
    root.innerHTML = [
      '<style>',
      '.bar{display:flex;align-items:center;gap:10px;background:rgba(20,20,20,.92);color:#fff;',
      'padding:10px 14px;border-radius:8px;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;',
      'box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:70vw}',
      '.msg{word-break:break-all}',
      'button{cursor:pointer;border:none;border-radius:5px;padding:5px 12px;font-size:13px}',
      '.go{background:#3ea6ff;color:#0c0c0c;font-weight:600}',
      '.go:hover{background:#6fbdff}',
      '.no{background:transparent;color:#999}',
      '.no:hover{color:#fff}',
      '</style>',
      '<div class="bar">',
      '<span class="msg"></span>',
      '<button class="go">生成草稿</button>',
      '<button class="no">忽略</button>',
      '</div>',
    ].join('');
    const msg = root.querySelector('.msg');
    msg.textContent = noteCount > 0
      ? `「${(title || '该视频').slice(0, 30)}」保存了 ${noteCount} 条笔记,生成笔记草稿?`
      : `「${(title || '该视频').slice(0, 30)}」已有字幕缓存,生成笔记草稿?`;

    const container = (hooks.getPlayerContainer && hooks.getPlayerContainer()) || document.body;
    if (container === document.body) {
      banner.style.position = 'fixed';
      banner.style.top = '60px';
    }
    container.appendChild(banner);

    const dismiss = () => banner.remove();
    const timer = setTimeout(dismiss, 15000); // 15 秒无操作自动消失
    root.querySelector('.no').addEventListener('click', () => {
      clearTimeout(timer);
      dismiss();
    });
    root.querySelector('.go').addEventListener('click', async (e) => {
      clearTimeout(timer);
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = '生成中...';
      const resp = await DubCommon.safeSendMessage({ type: 'GEN_DRAFT', videoKey });
      if (resp && resp.ok) {
        // 手势允许时直接打开侧边栏;不行则提示用户点扩展图标
        DubCommon.safeSendMessage({ type: 'OPEN_PANEL' });
        msg.textContent = '草稿已生成,点击工具栏扩展图标打开笔记面板查看/导出';
        btn.style.display = 'none';
        setTimeout(dismiss, 5000);
      } else {
        msg.textContent = '生成失败:' + ((resp && resp.error) || '未知错误');
        btn.textContent = '重试';
        btn.disabled = false;
      }
    });
  }

  globalThis.DubCapture = { init, open, isOpen, close };
})();