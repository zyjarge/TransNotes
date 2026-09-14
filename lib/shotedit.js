/**
 * 截图预览与标记(捕捉浮层 Shadow DOM / 侧边栏共用)
 *
 * - view():全屏灯箱预览,点空白处或 Esc 关闭
 * - edit():仿微信截图的标记编辑器 —— 画笔/矩形/箭头/文字 + 颜色板 + 撤销/清空,
 *   完成后以 jpeg dataURL 回调 onSave(调用方负责写回缓存,通常覆盖同一 shot id,
 *   这样笔记/草稿/Obsidian 导出零改动自动拿到标记后的图)
 * - 纯 canvas 实现,无外部依赖;笔画用矢量动作栈记录,撤销/重绘零位图快照开销
 *
 * 键盘:模态打开期间在 window 捕获阶段就地拦截按键(stopImmediatePropagation,
 * 不拦默认行为,输入框照常打字),避免触发 YouTube/B 站页面快捷键;
 * capture.js 的键盘隔离先注册,经 isOpen() 守卫放行后按键交到这里处理。
 * 鼠标:pointerdown/click 在模态层 stopPropagation,防止点击穿透触发页面暂停。
 */
(function () {
  'use strict';

  const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];
  let openCount = 0;

  function isOpen() {
    return openCount > 0;
  }

  /** 挂载点:容器带 shadowRoot 就挂进 shadow(样式隔离),否则挂容器本身 */
  function mountTarget(container) {
    if (container && container.shadowRoot) return container.shadowRoot;
    return container || document.body;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('图片解码失败'));
      i.src = dataUrl;
    });
  }

  /**
   * 模态打开期间接管键盘:就地拦截其他监听器(不影响默认打字行为),
   * 具体按键逻辑由 handler 决定。返回卸载函数。
   */
  function guardKeys(handler) {
    const h = (e) => {
      e.stopImmediatePropagation();
      handler(e);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }

  /** 模态公共样式与行为:定位、鼠标事件不穿透、关闭计数 */
  function setupModal(container, extraCss) {
    const mount = mountTarget(container);
    const inDoc = mount === document.body;
    const modal = document.createElement('div');
    modal.style.cssText =
      (inDoc ? 'position:fixed;z-index:100000;' : 'position:absolute;z-index:1000;') +
      'inset:0;background:rgba(15,15,15,.92);' +
      'font:13px/1.5 -apple-system,"PingFang SC",sans-serif;' + (extraCss || '');
    for (const t of ['pointerdown', 'pointerup', 'click']) {
      modal.addEventListener(t, (e) => e.stopPropagation());
    }
    openCount++;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      modal.remove();
      openCount--;
    };
    return { mount, modal, close, isClosed: () => closed };
  }

  /** 灯箱预览:点图片外区域或 Esc 关闭 */
  function view({ dataUrl, container }) {
    const { mount, modal, close, isClosed } = setupModal(container,
      'display:flex;align-items:center;justify-content:center;cursor:zoom-out');
    modal.innerHTML =
      '<style>.se-view-img{max-width:92%;max-height:88%;border-radius:4px;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.6);cursor:default}</style>' +
      '<img class="se-view-img" alt="截图预览">';
    modal.querySelector('img').src = dataUrl;
    const unguard = guardKeys((e) => {
      if (e.key === 'Escape') { e.preventDefault(); doClose(); }
    });
    function doClose() {
      if (isClosed()) return;
      unguard();
      close();
    }
    modal.addEventListener('click', (e) => {
      if (e.target === modal) doClose();
    });
    mount.appendChild(modal);
    return doClose;
  }

  /** 标记编辑器:画笔/矩形/箭头/文字 + 颜色 + 撤销/清空;完成回调 onSave(newDataUrl) */
  async function edit({ dataUrl, container, onSave }) {
    const img = await loadImage(dataUrl);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const { mount, modal, close, isClosed } = setupModal(container,
      'display:flex;flex-direction:column');
    modal.innerHTML = [
      '<style>',
      '.se-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;flex-wrap:wrap;flex:none}',
      '.se-bar button{cursor:pointer;border:1px solid rgba(255,255,255,.25);',
      'background:rgba(255,255,255,.08);color:#eee;border-radius:6px;padding:5px 12px;font:inherit}',
      '.se-bar button:hover{background:rgba(255,255,255,.18)}',
      '.se-bar button.on{background:#3ea6ff;border-color:#3ea6ff;color:#0c0c0c;font-weight:600}',
      '.se-color{width:20px;height:20px;border-radius:50%;padding:0!important;',
      'border:2px solid rgba(255,255,255,.25)!important}',
      '.se-color.on{border-color:#fff!important;transform:scale(1.15)}',
      '.se-sep{width:1px;height:20px;background:rgba(255,255,255,.2);margin:0 4px}',
      '.se-flex{flex:1}',
      '.se-done{background:#3ea6ff!important;border-color:#3ea6ff!important;',
      'color:#0c0c0c!important;font-weight:600}',
      '.se-stage-wrap{flex:1;min-height:0;padding:0 12px 12px}',
      '.se-stage{position:relative;width:100%;height:100%;display:flex;',
      'align-items:center;justify-content:center;line-height:0;overflow:hidden}',
      '.se-stage canvas{max-width:100%;max-height:100%;background:#000;',
      'cursor:crosshair;display:block;touch-action:none}',
      '.se-text{position:absolute;z-index:2;background:rgba(0,0,0,.35);border:1px dashed #fff;',
      'border-radius:3px;padding:2px 6px;outline:none;min-width:100px;color:#fff;font:inherit}',
      '</style>',
      '<div class="se-bar">',
      '<button type="button" data-tool="pen" class="on">画笔</button>',
      '<button type="button" data-tool="rect">矩形</button>',
      '<button type="button" data-tool="arrow">箭头</button>',
      '<button type="button" data-tool="text">文字</button>',
      '<span class="se-sep"></span>',
      COLORS.map((c, i) =>
        '<button type="button" class="se-color' + (i === 0 ? ' on' : '') +
        '" data-color="' + c + '" style="background:' + c + '"></button>'
      ).join(''),
      '<span class="se-sep"></span>',
      '<button type="button" class="se-undo">撤销</button>',
      '<button type="button" class="se-clear">清空</button>',
      '<span class="se-flex"></span>',
      '<button type="button" class="se-cancel">取消 (Esc)</button>',
      '<button type="button" class="se-done">完成</button>',
      '</div>',
      '<div class="se-stage-wrap"><div class="se-stage"><canvas></canvas></div></div>',
    ].join('');

    const canvas = modal.querySelector('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const stage = modal.querySelector('.se-stage');

    let tool = 'pen';
    let color = COLORS[0];
    const lineW = Math.max(3, Math.round(W / 400));      // 线宽随图宽自适应
    const fontSize = Math.max(16, Math.round(W * 0.032)); // 字号同理
    const actions = [];   // 矢量动作栈:撤销 = 弹栈重绘,清空 = 清空栈
    let current = null;   // 进行中的拖拽动作(画笔/矩形/箭头)
    let textState = null; // { input, x, y, color } 进行中的文字输入

    function drawAction(c, a) {
      c.strokeStyle = a.color;
      c.fillStyle = a.color;
      c.lineWidth = a.w || lineW;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      if (a.tool === 'pen') {
        if (a.points.length < 2) { // 单点落笔 = 圆点
          c.beginPath();
          c.arc(a.points[0].x, a.points[0].y, (a.w || lineW) / 2, 0, Math.PI * 2);
          c.fill();
          return;
        }
        c.beginPath();
        c.moveTo(a.points[0].x, a.points[0].y);
        for (let i = 1; i < a.points.length; i++) c.lineTo(a.points[i].x, a.points[i].y);
        c.stroke();
      } else if (a.tool === 'rect') {
        c.strokeRect(
          Math.min(a.x0, a.x1), Math.min(a.y0, a.y1),
          Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0));
      } else if (a.tool === 'arrow') {
        const ang = Math.atan2(a.y1 - a.y0, a.x1 - a.x0);
        const head = Math.max(12, (a.w || lineW) * 4);
        c.beginPath();
        c.moveTo(a.x0, a.y0);
        c.lineTo(a.x1, a.y1);
        c.moveTo(a.x1, a.y1);
        c.lineTo(a.x1 - head * Math.cos(ang - 0.45), a.y1 - head * Math.sin(ang - 0.45));
        c.moveTo(a.x1, a.y1);
        c.lineTo(a.x1 - head * Math.cos(ang + 0.45), a.y1 - head * Math.sin(ang + 0.45));
        c.stroke();
      } else if (a.tool === 'text') {
        c.font = 'bold ' + a.size + 'px -apple-system,"PingFang SC",sans-serif';
        c.textBaseline = 'top';
        c.fillText(a.text, a.x, a.y);
      }
    }

    /** 重绘 = 底图 + 动作栈重放 + 进行中的动作 */
    function redraw() {
      ctx.drawImage(img, 0, 0, W, H);
      for (const a of actions) drawAction(ctx, a);
      if (current) drawAction(ctx, current);
    }

    /** 鼠标显示坐标 → 图像原始像素坐标(canvas 经 CSS 缩放显示) */
    function toImg(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (W / r.width),
        y: (e.clientY - r.top) * (H / r.height),
      };
    }

    /* ---------------- 文字输入 ---------------- */

    function openText(e) {
      commitText(); // 先提交上一处未完成的输入
      const cr = canvas.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const scale = cr.width / W;
      const input = document.createElement('input');
      input.className = 'se-text';
      input.style.left = (e.clientX - sr.left) + 'px';
      input.style.top = (e.clientY - sr.top) + 'px';
      input.style.fontSize = Math.max(12, Math.round(fontSize * scale)) + 'px';
      input.style.color = color;
      input.placeholder = '输入文字,Enter 确认';
      stage.appendChild(input);
      textState = {
        input,
        x: (e.clientX - cr.left) / scale,
        y: (e.clientY - cr.top) / scale,
        color,
      };
      input.addEventListener('blur', () => commitText());
      input.focus();
    }

    function commitText() {
      const st = textState;
      if (!st) return;
      textState = null; // 先清状态再移除,blur 重入时为无操作
      const v = st.input.value.trim();
      st.input.remove();
      if (v) {
        actions.push({ tool: 'text', color: st.color, x: st.x, y: st.y, text: v, size: fontSize });
        redraw();
      }
    }

    function cancelText() {
      const st = textState;
      if (!st) return;
      textState = null;
      st.input.remove();
    }

    /* ---------------- 画布交互 ---------------- */

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 抑制 mousedown 的默认焦点行为:canvas 不可聚焦,默认会把刚 focus 的
      // 文字输入框 blur 掉(blur → commitText 会把空输入框立即移除,表现为"点了没反应");
      // 焦点切换由代码显式控制(下方 commitText / openText)
      e.preventDefault();
      if (textState) commitText();
      const p = toImg(e);
      if (tool === 'text') {
        openText(e);
        return;
      }
      if (tool === 'pen') {
        current = { tool, color, w: lineW, points: [p] };
      } else { // rect / arrow 共用起止点结构
        current = { tool, color, w: lineW, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      canvas.setPointerCapture(e.pointerId);
      redraw();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      const p = toImg(e);
      if (current.tool === 'pen') current.points.push(p);
      else { current.x1 = p.x; current.y1 = p.y; }
      redraw();
    });

    canvas.addEventListener('pointerup', () => {
      if (!current) return;
      // 过小的拖拽视为误触(画笔单点保留为圆点)
      const tiny = current.tool !== 'pen' &&
        Math.abs(current.x1 - current.x0) < 3 && Math.abs(current.y1 - current.y0) < 3;
      if (!tiny) actions.push(current);
      current = null;
      redraw();
    });

    /* ---------------- 工具栏 ---------------- */

    modal.querySelectorAll('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        tool = b.dataset.tool;
        modal.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('on', x === b));
        if (tool !== 'text') commitText();
        canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
      });
    });

    modal.querySelectorAll('.se-color').forEach((b) => {
      b.addEventListener('click', () => {
        color = b.dataset.color;
        modal.querySelectorAll('.se-color').forEach((x) => x.classList.toggle('on', x === b));
        if (textState) { // 进行中的文字输入跟随换色
          textState.color = color;
          textState.input.style.color = color;
        }
      });
    });

    modal.querySelector('.se-undo').addEventListener('click', () => {
      actions.pop();
      redraw();
    });
    modal.querySelector('.se-clear').addEventListener('click', () => {
      actions.length = 0;
      redraw();
    });
    modal.querySelector('.se-cancel').addEventListener('click', () => doClose());

    const doneBtn = modal.querySelector('.se-done');
    doneBtn.addEventListener('click', async () => {
      if (doneBtn.disabled) return;
      doneBtn.disabled = true;
      commitText();
      redraw();
      try {
        if (onSave) await onSave(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        console.error('[TransNotes] 截图标记保存失败', e);
      }
      doClose();
    });

    /* ---------------- 键盘与收尾 ---------------- */

    const unguard = guardKeys((e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (textState) cancelText(); // 有输入先撤输入,再按才关编辑器
        else doClose();
      } else if (e.key === 'Enter' && textState) {
        e.preventDefault();
        commitText();
      }
    });
    function doClose() {
      if (isClosed()) return;
      unguard();
      close();
    }

    mount.appendChild(modal);
    redraw();
  }

  globalThis.DubShotEdit = { view, edit, isOpen };
})();
