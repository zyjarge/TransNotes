/**
 * Obsidian 导出器(侧边栏使用)
 *
 * 优先 File System Access API:用户授权一个 Obsidian vault 文件夹后,
 * Markdown 直接写入 vault 根目录,截图写入 attachments/ 子目录
 * (Markdown 内以相对路径 attachments/{shotId}.jpg 引用,笔记迁移不丢图)。
 * 目录句柄存 IndexedDB(扩展页面源),下次导出免重新选择;授权过期时自动重新请求。
 * 默认 vault 在设置页配置;侧边栏导出页可临时切换到另一个文件夹(仅当次会话,不持久化)。
 *
 * 退化方案:chrome.downloads 把 .md 和截图下载到下载目录的 video-notes/ 下,
 * 由用户手动移入 vault。
 *
 * 依赖 lib/cache.js(VdcCache)。仅在扩展页面(侧边栏)使用,不在 content script 使用。
 */
(function () {
  'use strict';

  const IDB_NAME = 'vdc-export';
  const IDB_STORE = 'handles';
  const VAULT_KEY = 'obsidian-vault';

  /* ---------------- 目录句柄存取(IndexedDB) ---------------- */

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ---------------- File System Access ---------------- */

  function isFsSupported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  /** 弹出目录选择器让用户授权 vault 文件夹,并持久化句柄(设置默认位置用) */
  async function pickVault() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbSet(VAULT_KEY, dir);
    return dir;
  }

  /** 授权检查:已授权返回句柄;过期则重新请求(需用户手势上下文);失败返回 null */
  async function ensurePerm(dir) {
    if (!dir) return null;
    if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return dir;
    if ((await dir.requestPermission({ mode: 'readwrite' })) === 'granted') return dir;
    return null;
  }

  /**
   * 取已授权的默认 vault 句柄;授权过期时尝试重新请求(需用户手势上下文)
   * @returns {Promise<FileSystemDirectoryHandle|null>} 未选择过返回 null
   */
  async function getVault() {
    return ensurePerm(await idbGet(VAULT_KEY));
  }

  /** 只读已存的默认 vault 句柄(不请求授权,供界面展示文件夹名;可无手势调用) */
  async function peekVault() {
    return idbGet(VAULT_KEY);
  }

  /* ---------------- 临时导出位置(仅当次会话,不持久化) ---------------- */

  let tempVault = null;

  /** 临时切换到另一个文件夹:弹目录选择器,只存内存,不写 IndexedDB */
  async function pickTempVault() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    tempVault = dir;
    return dir;
  }

  /** 当前临时位置句柄(未设置返回 null) */
  function getTempVault() {
    return tempVault;
  }

  /** 清除临时位置,恢复默认 vault */
  function clearTempVault() {
    tempVault = null;
  }

  async function writeFile(dirHandle, name, content) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  }

  /* ---------------- 导出 ---------------- */

  /** 收集草稿引用到的截图:{ shotId: dataUrl }(笔记截图 + 助教问答画面) */
  async function collectShots(videoKey) {
    const notes = await VdcCache.getNotes(videoKey);
    const qas = await VdcCache.getQA(videoKey);
    const shots = {};
    for (const n of [...notes, ...qas]) {
      if (!n.shot) continue;
      const dataUrl = await VdcCache.getShot(n.shot);
      if (dataUrl) shots[n.shot] = dataUrl;
    }
    return shots;
  }

  async function dataUrlToBlob(dataUrl) {
    const resp = await fetch(dataUrl);
    return resp.blob();
  }

  /**
   * 导出草稿到 Obsidian vault(不可用时退化为下载)
   * @param {string} videoKey
   * @param {string} md markdown 文本
   * @returns {Promise<{method:string, fileName:string, shotCount:number}>}
   */
  async function exportDraft(videoKey, md) {
    const doc = await VdcCache.getSubtitles(videoKey);
    const fileName = VdcNotes.safeFileName((doc && doc.title) || videoKey) + '.md';
    const shots = await collectShots(videoKey);
    const shotIds = Object.keys(shots);

    if (isFsSupported()) {
      // 临时位置优先(本次会话);否则用设置页的默认 vault
      const dir = (await ensurePerm(tempVault)) || (await getVault());
      if (dir) {
        await writeFile(dir, fileName, md);
        if (shotIds.length) {
          const attach = await dir.getDirectoryHandle('attachments', { create: true });
          for (const id of shotIds) {
            await writeFile(attach, id + '.jpg', await dataUrlToBlob(shots[id]));
          }
        }
        return { method: 'vault', fileName, shotCount: shotIds.length };
      }
    }

    // 退化:chrome.downloads 下载到 下载目录/video-notes/
    const mdUrl = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    await chrome.downloads.download({ url: mdUrl, filename: 'video-notes/' + fileName, saveAs: false });
    for (const id of shotIds) {
      const blob = await dataUrlToBlob(shots[id]);
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `video-notes/attachments/${id}.jpg`,
        saveAs: false,
      });
    }
    return { method: 'downloads', fileName, shotCount: shotIds.length };
  }

  globalThis.VdcExporter = {
    isFsSupported,
    pickVault,
    getVault,
    peekVault,
    pickTempVault,
    getTempVault,
    clearTempVault,
    exportDraft,
  };
})();
