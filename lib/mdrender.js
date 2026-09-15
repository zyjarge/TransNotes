/**
 * 统一 Markdown 渲染器(侧边栏各视图共用:自动笔记 / 助教回答 / 草稿预览)
 *
 * 技术栈(全部本地打包于 lib/vendor/,MV3 不加载远程代码):
 * - marked:Markdown → HTML(含表格、列表、代码块等完整语法)
 * - DOMPurify:HTML 消毒(AI 生成内容不可信)
 * - KaTeX(auto-render):数学公式 $$..$$ / $..$ / \[..\] / \(..\)
 *
 * 保留产品特性:
 * - [mm:ss] 时间戳渲染为可点击锚点,点击经 opts.onTimestamp(sec) 跳回视频
 * - ![](attachments/{shotId}.jpg) 截图按 id 从 VdcCache 取 dataURL 显示
 * - 外部链接新窗口打开
 *
 * 数学公式在 marked 解析前先抽成占位符(否则公式里的 _ ^ 等会被 marked
 * 误认为强调语法),消毒前还原(转义后注入),最后由 KaTeX 就地渲染。
 */
(function () {
  'use strict';

  const TS_TEST_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/;
  const TS_SPLIT_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

  function tsToSec(s) {
    const p = s.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }

  /* ---------------- 数学公式:解析前抽取,消毒前还原 ---------------- */

  function extractMath(md) {
    const store = [];
    const stash = (m) => {
      store.push(m);
      return `MATHSTASH${store.length - 1}END`;
    };
    const out = String(md || '')
      .replace(/\$\$[\s\S]+?\$\$/g, stash)                                  // $$..$$ 块级(可跨行)
      .replace(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g, stash)                 // \[..\] / \(..\)
      .replace(/\$[^\s$][^$\n]*?[^\s$]\$|\$[^\s$]\$/g, stash);              // $..$ 行内(两侧非空格)
    return { out, store };
  }

  function restoreMath(html, store) {
    // 还原为转义后的纯文本(公式里可能有 < > &),交由 KaTeX 渲染
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html.replace(/MATHSTASH(\d+)END/g, (m, i) => esc(store[Number(i)] || ''));
  }

  function renderMath(container) {
    if (typeof renderMathInElement !== 'function') return;
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }

  /* ---------------- 产品特性:时间戳 / 链接 / 截图 ---------------- */

  /** 文本节点里的 [mm:ss] → 可点击锚点(跳过 code/pre/a/公式内部) */
  function linkTimestamps(container, onTimestamp) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        TS_TEST_RE.lastIndex = 0;
        if (!TS_TEST_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (p && p.closest('code, pre, a, .katex')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const node of targets) {
      TS_SPLIT_RE.lastIndex = 0;
      const parts = node.nodeValue.split(TS_SPLIT_RE);
      // split 带捕获组:偶数位是普通文本,奇数位是时间戳
      if (parts.length < 2) continue;
      const frag = document.createDocumentFragment();
      parts.forEach((part, i) => {
        if (i % 2 === 1) {
          const span = document.createElement('span');
          span.className = 'an-ts';
          span.textContent = part;
          span.title = '跳回视频对应位置';
          const sec = tsToSec(part);
          span.addEventListener('click', () => onTimestamp(sec));
          frag.appendChild(span);
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      });
      node.parentNode.replaceChild(frag, node);
    }
  }

  function fixLinks(container) {
    container.querySelectorAll('a[href^="http"]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
  }

  /** 截图引用 attachments/{shotId}.jpg → 缓存里的 dataURL */
  async function resolveImages(container) {
    if (!globalThis.VdcCache) return;
    for (const img of container.querySelectorAll('img')) {
      const m = (img.getAttribute('src') || '').match(/attachments\/(.+?)\.jpg/);
      if (!m) continue;
      const u = await VdcCache.getShot(m[1]).catch(() => null);
      if (u) img.src = u;
    }
  }

  /**
   * 渲染 Markdown 到容器
   * @param {HTMLElement} container
   * @param {string} md
   * @param {object} [opts] { onTimestamp: (sec)=>void }
   */
  async function render(container, md, opts) {
    const { out, store } = extractMath(md);
    let html = marked.parse(out, { breaks: true });
    html = restoreMath(html, store);
    container.innerHTML = DOMPurify.sanitize(html);
    renderMath(container);
    fixLinks(container);
    if (opts && typeof opts.onTimestamp === 'function') {
      linkTimestamps(container, opts.onTimestamp);
    }
    await resolveImages(container);
  }

  globalThis.MdRender = { render };
})();
