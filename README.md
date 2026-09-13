# ytb-tts — 视频中文配音 + 学习笔记

一个 Chrome 扩展(MV3),把 YouTube / B 站视频变成可听、可记、可归档的学习资源:

- **实时中文配音**:抓取视频字幕 → 翻译为中文(DeepSeek 等 OpenAI 兼容服务;YouTube 有中文字幕/自动翻译、B 站有 ai-zh 字幕时直通)→ MiniMax TTS 合成 → 按时间戳与原画面同步播放,原声自动静音
- **观看中捕捉想法**:快捷键/播放器按钮唤出浮层,自动带入时间戳与当前字幕,可插图(视频画面截图),不打断观看节奏
- **笔记侧边栏**:双语字幕(配音进度联动高亮)、AI 概览(章节 + 关键引述,粒度可配)、时间戳笔记(点击跳回视频)
- **自动生成笔记草稿**:视频结束或中途切走时提示,一键生成 Markdown(frontmatter + AI 概览 + 时间戳笔记 + 双语字幕,各章节可在设置中勾选),可编辑后**直接导出到 Obsidian vault**(截图存 `attachments/`,相对路径引用)

**本地优先**:API Key、字幕缓存、笔记、截图全部存在本机 Chrome 存储,无任何开发者服务器与遥测。字幕译文共享缓存——配音翻译过的内容,笔记和双语视图直接复用,不重复调用 AI。

## 安装

本扩展不上架 Chrome Web Store,通过「加载已解压的扩展程序」本地安装。

### 让 coding agent 帮你装

把下面这段话发给你的 coding agent(如 Kimi Code / Claude Code):

> 把 https://github.com/zyjarge/ytb-tts 克隆到一个我指定的固定目录,告诉我完整路径,并用同一个目录完成 Chrome 的「加载已解压的扩展程序」安装(扩展目录是仓库里的 `youtube-zh-dubbing/`)。如果我没有目录偏好,macOS 上建议 `~/Documents/ytb-tts`。然后引导我在扩展设置页填入 API Key。

### 手动安装

1. 克隆或下载本仓库( Code → Download ZIP 后解压),放在一个**固定位置**——安装后不要移动或删除该目录,否则扩展会失效,需重新加载
2. 打开 `chrome://extensions`,开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」,选择仓库内的 **`youtube-zh-dubbing/`** 目录
4. 点工具栏扩展图标旁的菜单 →「选项」打开设置页,填入 API Key(见下;**只用笔记功能的话,填翻译 API 即可,TTS 可不填**)
5. 更新代码后,在 `chrome://extensions` 点扩展卡片上的「重载」,并**刷新已打开的视频页**(页面里的旧脚本不会自动更新)

## 配置 API Key

在扩展设置页填写,Key 只存本机 `chrome.storage.local`,**切勿把 Key 贴进聊天记录、源码或截图**:

- **MiniMax TTS(配音用,选填)**:[platform.minimaxi.com](https://platform.minimaxi.com/user-center/basic-information/interface-key) 创建 API Key;可选音色与语速。**不配置只影响「中文配音」功能**——字幕抓取、翻译、AI 概览、笔记与 Obsidian 导出均不受影响,可只当学习笔记工具用
- **翻译 / AI 概览(笔记功能,必填)**:默认 DeepSeek([platform.deepseek.com](https://platform.deepseek.com/) 创建 Key),可换成任意 OpenAI 兼容服务的 Base URL / Key / 模型
- **笔记选项**:摘要粒度(简洁/普通/详细)、导出笔记包含内容(元信息/摘要/笔记/字幕)

详细配置说明见 [youtube-zh-dubbing/README.md](youtube-zh-dubbing/README.md)。

## 使用

1. 打开带字幕的 YouTube 视频(含 Shorts)或 B 站视频(需登录,需 ai-zh 中文字幕)
2. **配音**:点播放器控制栏的「中文配音」按钮,或按 `Ctrl+Shift+D`;首批语音缓冲就绪后自动开播,原声静音
3. **记笔记**:观看中按 `Ctrl/Cmd+Shift+S` 或点「记录想法」按钮 → 浮层自动带入时间戳与当前字幕,输入想法,`Ctrl+Enter` 保存续播
4. **看笔记**:点工具栏扩展图标打开侧边栏——自动抓取字幕、自动翻译、自动生成概览;字幕随配音逐句高亮,点时间戳跳回视频
5. **归档**:视频结束/切走时会提示是否生成草稿;在侧边栏「笔记导出」页签编辑后点「导出到 Obsidian」,首次授权 vault 文件夹,之后一键写入

## 核心机制

- **流式管线**:从当前播放位置开始,按批翻译 + 逐句合成即时推送,首批缓冲就绪即开播,末尾回填跳过的句子
- **双向调速对齐**:语音比字幕窗口长时,视频轻微减速([0.75, 1.25])与语音轻微加速([0.9, 1.5])各承担一半误差,人耳几乎无感
- **尾部对齐**:起播严重迟到时牺牲句首、对齐句尾,保证下一句准时进场,不丢内容
- **+0.001 速率指纹**:插件设置的 `playbackRate` 永远加 0.001,借此区分"用户手动调速"与"插件自己调的",不与用户拉锯
- **字幕抓取**:YouTube 对 timedtext 接口强制 PO Token 校验,插件借播放器自身携带 pot 的字幕请求获取数据;B 站走 wbi 签名接口(需登录态)
- **共享缓存**:字幕译文、音频、笔记、截图全部本地持久化;同一视频第二次打开,配音近乎即时,笔记与双语视图零 AI 成本

## 仓库结构

```
├── PRD.md                 # 产品需求文档(MVP 范围、技术架构、验收标准)
└── youtube-zh-dubbing/    # Chrome 扩展(MV3)
    ├── manifest.json
    ├── background.js      # Service Worker:流式翻译 + TTS 合并调度 + 笔记/概览/截图消息 + 持久缓存
    ├── content.js         # YouTube Content Script:播放器按钮、字幕抓取、捕捉入口、进度广播
    ├── injected.js        # YouTube 主世界脚本:hook 播放器带 pot 的字幕请求
    ├── bilibili.js        # B 站 Content Script:字幕 API(wbi 签名)、ai-zh 直通、分 P 巡检
    ├── capture.js         # 捕捉浮层(两站共用):键盘隔离、截图裁剪;草稿生成提示条
    ├── sidepanel.html/js  # 笔记侧边栏:字幕/概览/笔记/笔记导出四页签
    ├── options.html/js    # 设置页(API Key、音色语速、摘要粒度、导出内容)
    └── lib/
        ├── subtitles.js   # YouTube timedtext JSON3 解析、片段合并、轨道选择
        ├── translate.js   # OpenAI 兼容翻译封装(分块、按行对应)
        ├── minimax_tts.js # MiniMax TTS 封装(hex 解码、限流自适应队列、多句合并+句级字幕)
        ├── syncplayer.js  # 时间戳对齐播放引擎(双向调速/尾部对齐/缓冲等待,两站共用)
        ├── cache.js       # 共享缓存层:字幕译文/笔记/截图
        ├── notes.js       # 笔记整合:AI 概览(粒度可配)+ Markdown 草稿组装
        ├── exporter.js    # Obsidian 导出:File System Access 直写 vault,退化为下载
        ├── dubcommon.js   # 站点无关公共件(base64/WAV 编码、合并块切分、安全消息)
        └── wbi.js         # B 站 wbi 签名(内置 MD5)
```

## 合规说明

- 仅供个人学习与研究使用;API Key 仅存本机 `chrome.storage.local`
- 不下载、不分发 YouTube/B 站音视频内容;字幕数据仅在浏览器内实时处理
