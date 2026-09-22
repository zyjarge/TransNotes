<p align="center"><img src="icons/icon128.png" width="96" alt="TransNotes 图标"></p>

<!--
  本地托管的 mp4 嵌入 GitHub README(GitHub sanitizer 允许 <video> 标签):
  视频源: docs/assets/transnotes-intro.mp4 (H.265 720p, 4 MB, faststart)
  GitHub 会自动转码成 player-ready 流, <video> 标签可正常播放
  - 加 playsinline 让移动端在内联播放(避免强制全屏)
  - 加 controls 显示原生控件(进度条、音量、全屏)
  - 静音属性让浏览器允许自动播放(部分浏览器策略要求)
-->
<p align="center">
  <video src="docs/assets/transnotes-intro.mp4" width="640" controls playsinline muted preload="metadata" poster="https://img.youtube.com/vi/IdUvRAOk-CI/maxresdefault.jpg"></video>
</p>

<p align="center">
  <sub>📺 也可以在 <a href="https://www.youtube.com/watch?v=IdUvRAOk-CI">YouTube</a> 观看</sub>
</p>

# TransNotes — 把看不懂的课程，变成听得懂、记得住的知识

> 本项目灵感来源于 <https://github.com/zarazhangrui/youtube-digest>,在其基础上进行了功能升级。

> [!NOTE]
> 本项目仅供个人学习与研究使用,请合理合规使用,切勿用于任何商业用途。

> [!WARNING]
> 本项目与 YouTube、B 站(Bilibili)均无任何隶属或官方关系。字幕数据通过逆向分析的网页接口与登录态 Cookie 获取,可能不符合相关平台的服务条款。使用风险由使用者自行承担——因使用本项目导致的账号处置或数据损失,作者概不负责。

一个 Chrome 扩展(MV3),把 YouTube / B 站视频变成可听、可记、可归档的学习资源:

- **实时中文配音**:抓取视频字幕 → 翻译为中文(DeepSeek 等 OpenAI 兼容服务;YouTube 有中文字幕/自动翻译、B 站有 ai-zh 字幕时直通)→ MiniMax TTS 合成 → 按时间戳与原画面同步播放,原声自动静音
- **观看中捕捉想法**:快捷键/播放器按钮唤出浮层,自动带入时间戳与当前字幕,可插图(视频画面截图),不打断观看节奏
- **笔记侧边栏**:双语字幕(配音进度联动高亮)、AI 概览(章节 + 关键引述,粒度可配)、时间戳笔记(点击跳回视频)
- **AI 助教**:观看中就知识点直接提问——自动带入当前播放位置前后的字幕、全片概览与近期问答作上下文;视频没讲透的背景知识(如数学概念)助教会补充讲解并明确标注;问答随草稿一并导出
- **自动生成笔记草稿**:视频结束或中途切走时提示,一键生成 Markdown(frontmatter + AI 概览 + 时间戳笔记 + 双语字幕,各章节可在设置中勾选),可编辑后**直接导出到 Obsidian vault**(截图存 `attachments/`,相对路径引用)

**本地优先**:API Key、字幕缓存、笔记、截图全部存在本机 Chrome 存储,无任何开发者服务器与遥测。字幕译文共享缓存——配音翻译过的内容,笔记和双语视图直接复用,不重复调用 AI。

**技术思路**:不下载视频/音频流,只抓取字幕轨道(带时间戳文本)→ 按句尾标点**语义重组为完整句子**(修复字幕按显示节奏断句导致的"半句话"割裂感)→ 中文文本 → 逐句 TTS 合成 → 按时间戳同步播放。整条链路全部在浏览器内实时完成。

**支持站点**:
- **YouTube**(含 Shorts):字幕三级通道 —— 原生中文字幕轨(直通 TTS)> 英文轨 + `tlang` 自动翻译(直通,谷歌机翻)> 英文轨 + DeepSeek 翻译(质量兜底)
- **B 站**(需登录):ai-zh 中文 AI 字幕 → 直通配音(无需翻译,字幕时间轴与原语音天然对齐);B 站原生英文字幕视频暂不支持

## 安装

本扩展不上架 Chrome Web Store,通过「加载已解压的扩展程序」本地安装。

### 让 coding agent 帮你装

把下面这段话发给你的 coding agent(如 Kimi Code / Claude Code):

> 把 https://github.com/zyjarge/TransNotes 克隆到一个我指定的固定目录,告诉我完整路径,并用同一个目录完成 Chrome 的「加载已解压的扩展程序」安装(扩展目录就是仓库根目录)。如果我没有目录偏好,macOS 上建议 `~/Documents/TransNotes`。然后引导我在扩展设置页填入 API Key。

### 手动安装

1. 克隆或下载本仓库( Code → Download ZIP 后解压),放在一个**固定位置**——安装后不要移动或删除该目录,否则扩展会失效,需重新加载
2. 打开 `chrome://extensions`,开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」,选择**仓库根目录**
4. 点工具栏扩展图标旁的菜单 →「选项」打开设置页,填入 API Key(见下;**只用笔记功能的话,填翻译 API 即可,TTS 可不填**)
5. 更新代码后,在 `chrome://extensions` 点扩展卡片上的「重载」,并**刷新已打开的视频页**(页面里的旧脚本不会自动更新)

## 配置 API Key

在扩展设置页填写,Key 只存本机 `chrome.storage.local`,**切勿把 Key 贴进聊天记录、源码或截图**:

- **MiniMax TTS(配音用,选填)**:[platform.minimaxi.com](https://platform.minimaxi.com/user-center/basic-information/interface-key) 创建 API Key;可选音色与语速(默认:青涩青年音色,语速 1.0);Group ID 仅旧版账号需要才填。**不配置只影响「中文配音」功能**——字幕抓取、翻译、AI 概览、笔记与 Obsidian 导出均不受影响,可只当学习笔记工具用
- **翻译 / AI 概览(笔记功能,必填)**:默认 DeepSeek([platform.deepseek.com](https://platform.deepseek.com/) 创建 Key),可换成任意 OpenAI 兼容服务的 Base URL / Key / 模型
- **字幕口语化润色(实验)**:设置页「文本模型」区可开启——TTS 前把中文字幕再过一遍文本模型,书面语/翻译腔改写为自然口语;英文通道合并进翻译调用,中文直通通道单独润色;润色结果与纯翻译分开缓存,互不影响
- **笔记选项**:摘要粒度(简洁/普通/详细)、导出笔记包含内容(元信息/摘要/笔记/助教问答/字幕)、**自定义笔记模板**(内置模板只读,可查看提示词并「基于此新建」改造;自定义模板可编辑/删除,当前默认模板需先切换默认才可删除)

## 使用

1. 打开带字幕的 YouTube 视频(含 Shorts)或 B 站视频(需登录,需 ai-zh 中文字幕)
2. **配音**:点播放器控制栏的「中文配音」按钮(YouTube 普通视频在控制栏右侧;Shorts 在播放器右上角圆形浮动按钮;B 站在控制栏右下区),或按 `Ctrl+Shift+D`;点击后视频先暂停并显示加载浮层,首批语音缓冲(起始句起连续 3 句)就绪后自动续播,原声静音;缓冲期间再次点击可取消
3. **记笔记**:观看中按 `Ctrl/Cmd+Shift+S` 或点「记录想法」按钮 → 视频暂停并弹出浮层,自动带入时间戳与当前字幕(浮层内按键已与页面快捷键隔离),可插入截图(自动裁剪到视频画面;截图可点击放大预览,点「标记」可在图上添加画笔/矩形/箭头/文字),`Ctrl+Enter` 保存续播,`Esc` 取消
4. **看笔记**:点工具栏扩展图标打开侧边栏——自动抓取字幕、自动翻译、自动生成概览;字幕随配音逐句高亮,点时间戳跳回视频
5. **归档**:视频结束/切走时会提示是否生成草稿;在侧边栏「笔记导出」页签编辑后点「导出到 Obsidian」——默认导出位置在设置页配置(vault 文件夹),导出页可临时切换到其他文件夹(仅当次会话);未配置则退化为下载到「下载目录/video-notes/」

支持:暂停 / 拖动进度条 / 倍速播放(自动重新对齐);无字幕视频会给出明确提示。配音期间原声保持静音(调音量会被自动恢复静音,想听原声请点「停止配音」)。

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Shift+S`(macOS `Cmd+Shift+S`) | 捕捉想法(记笔记) |
| `Ctrl+Shift+D`(macOS 同为 Ctrl+Shift+D) | 开关中文配音 |

## API 成本估算

| 项 | 单价参考 | 一个 10 分钟视频(~150 句) |
|---|---|---|
| MiniMax TTS | 约 ¥0.002/千字符(以官方计费为准) | 约 ¥0.01~0.03 |
| 翻译(DeepSeek) | 输入 ¥0.5/百万 tokens、输出 ¥2/百万 tokens | 约 ¥0.01 以内 |

总成本极低(每次观看约几分钱量级),主要瓶颈是限流而非费用。以官方控制台计费为准。

## 合规说明

- 仅供个人学习与研究使用;API Key 仅存本机 `chrome.storage.local`
- 不下载、不分发 YouTube/B 站音视频内容;字幕数据仅在浏览器内实时处理

## 支持这个项目

TransNotes 是一个业余时间的开源项目。如果它真的帮你把看不懂的课程变成了听得懂、记得住的知识,欢迎请作者喝杯咖啡——你的支持是我持续打磨它的动力。也欢迎 Star、提 Issue 和分享给你的朋友。

<p align="center">
  <img src="icons/wechat_qr.jpg" width="100%" alt="赞赏海报(微信 / 支付宝)">
</p>
