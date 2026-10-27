# Changelog

## [1.0.9-port.9] - 2026-10-27

### Fixed

- **The history palette had no surface of its own.** It asked for
  `--dsw-alias-bg-elevated`, a token this shell does not define, so the declared fallback
  (`transparent`) applied and the transcript read straight through the dialog — the rows and the
  conversation behind them interfered, which is what the user reported. It now uses the same
  surface as the roaming bar (`--dsw-specific-tip`, falling back to `--dsw-alias-bg-layer-1`), so
  the two history surfaces match and the list sits on something solid.
- The same audit found eight more tokens this shell never defines, each of which had been
  silently resolving to `transparent`: `bg-subtle`, `bg-muted`, `bg-primary`, `border-subtle`,
  `border-accent`, `border-focus`, `border-secondary` and `label-error`. They now map to the
  tokens that exist (`bg-layer-2`, `bg-base`, `border-l1`, `brand-primary`, `border-l2`,
  `state-error-primary`). Visible consequences: the roaming frame band and its left rule, the
  palette's borders and the picker's footer rule were all invisible before.

## [1.0.9-port.8] - 2026-10-27

### 文档

- **两种语言都把「历史跳转」写进 README**：漫游（<kbd>Esc</kbd>）与检索面板（<kbd>Ctrl/Cmd+Shift+H</kbd>）的按键表、
  一格一轮与导轨同一把尺（A-33）、回答与系统轮次也是落点、会抢键时的让位规则、取回方式与智能跟随的口径。
  设置表补上四项（启用历史跳转 / 历史粒度 / 取回方式 / 智能跟随），默认值按 port.5 起**真实生效**的口径写
  （历史粒度默认「每轮对话」）。
- **`docs/history-jump.md` §7.1 的默认值不再是 `'message'`**：与 `src/client/settings.ts`、`src/settings.ts` 对齐为 `'turn'`。
- **新增 `assets/screenshots/history-roam.png`**（1280×820 @2x，取自真实实例）：按 <kbd>Esc</kbd> 后输入框上方的读数
  `历史 第 0 / 1 轮 · 当前草稿`。
- 包描述与关键词补上历史跳转（`history` / `keyboard` / `navigation` / `session-history` / `esc`）。

### 测试

- `tests/mention-navigator.spec.tsx` 新增两组：一次提交只触发一次 `onSend`（`submitting` 跨多次渲染只发一次，
  回到 idle 后再提交才再发）；菜单高度预算把输入框卡片顶边写成 `--dsh-atlas-menu-max`，跟随 resize，
  底部 160px 夹取，卡片消失时移除该变量。
- 语句覆盖 94.87%、分支 90.13%，单测 **1040 通过 / 1 跳过**。

## [1.0.9-port.7] - 2026-10-27

### 修复

- **发布产物里的 `lib/` 落后于源码**：`lib/index.js` 停在 `9ca2757`（port.6 的功能提交），
  之后那次「分类缓存改为实例级」的修复（`397f9da`）只进了 `src/`，没重建进 `lib/`。
  npm 上的 tarball 装的就是 `lib/`，所以 **port.6 发布出去的包带着模块级缓存的旧缺陷**：
  同一进程里插件卸载再挂载，30 秒 TTL 内会拿到上一个实例的技能/会话/插件列表。
  本版重建 `lib/`，产物与源码重新对齐（`cmp` 证明 port.6 的 lib 与重建结果不同）。

### 变更

- 无功能变化：本版只为让发布产物等于已审阅的源码。

### 证据

- 单测 **1030 通过 / 1 跳过**、`tsc --noEmit` 0 错误、`verify:publish` 66 文件、
  语句覆盖 94.64%（5193/5487）、分支 89.83%（3489/3884）。

## [1.0.9-port.6] - 2026-10-27

### 修复

- **默认粒度在客户端没有真正生效**（用户回报：设置里默认仍不是「每轮对话」）。根因是三个地方的口径不一致：
  契约默认 `'turn'`，设置面板兜底 `'turn'`，但 `FrameCursor` / `HistoryPalette` 用的是
  `settings.historyJumpFrames === 'turn' ? 'turn' : 'message'` —— **缺值就落到 `'message'`**。
  宿主交给客户端的可能是**存储层**（`at-file` 里没有这个键）而不是 schema 解析后的对象，
  于是面板显示「每轮对话」而阶梯仍按「条」走，两者当场自相矛盾。
  现在两处都改成 `=== 'message' ? 'message' : 'turn'`：**只有显式选择「每条消息」才细走**。
- 单测 **983 通过 / 1 跳过**，`tsc` 0 错误。

## [1.0.9-port.5] - 2026-10-27

### 变更

- **Esc 的历史阶梯改成「轮」，与页面右侧的轮次导轨同一把尺**（用户选定的方案 A）。
  一格 = 一个 `turn`，身份就是 turn 号，所以同一轮在结构上不可能出现两格：
  上一版把「提问」和「回答」各算一格，11 轮的会话在面板里读作 22 格，而右侧只画 11 格。
- **系统发起的轮次自带一格**：这种轮次没有提问节点，它的最后一个有正文的助手节点就是这一轮唯一的停点（标签 系统），
  与宿主 `turnNavigationItem` 的 `user ?? loaded[0]` 锚点规则、`findLast` 取回答的规则一致。
- **默认粒度改为 `'turn'`**（原 `'message'`）。`'message'` 仍可在设置里选，它保留「每条提问 + 每条回答都停」的细粒度。
- **读数条单位随粒度**：`'turn'` 显示「第 3 / 11 轮」，`'message'` 仍显示「第 3 / 22 条」。

### 测试

- `tests/runtime.spec.ts` 的默认设置形状断言更新为 `historyJumpFrames: 'turn'`。
- 全套 40 文件 **983 通过 / 1 跳过**。

## [1.0.9-port.4] - 2026-10-27

### 修复

- **系统发起的轮次走不到**：上一版只在「该 turn 的 prompt 也在格上」时才建回复格，而系统轮次没有 `user`
  节点（没有人提问），于是那几轮在 Up/Down 里根本不存在。现在无 prompt 的 turn 用它的回答成格，
  并标注**系统**（来源优先于类别：有提问的回复格标 回复，系统轮次的格标 系统）。
- **流式消息的第一条被当成独立的历史消息**：一轮回答可能流出多个助手节点，第一条常是上文的重放，
  上一版给每个节点都建了一格，面板里于是多出一条既不是用户、也不是系统发起的行。
  现在**一个 turn 只留一格**，取最后一个有正文的 `assistant-step`；该 turn 一旦成格即认领，
  outline 不会为同一 turn 再合成一格。

### 测试

- `tests/history-frames.spec.ts` 新增 4 条：回复格归属（用户提问 / 系统发起）、一轮多节点只留一格、
  `'turn'` 粒度不含回复格。
- 重新基线 `tests/history-cursor.spec.tsx` 三处系统轮次断言（窗口里只有回答的 turn 现在是最新停点）。
  全套 40 文件 **983 通过 / 1 跳过**。

## [1.0.9-port.3] - 2026-10-27

### 新增

- **把助手的回复也当作消息的一格，Up/Down 会跳到它上面**（用户口径：*"系统的轮次不会如用户的输入轮次一样随
  up 和 down 移动到对应的位置，也就是应该把系统轮次视作消息的一个类别，也要跳转"*）。
  `src/client/history-frames.ts` 的 `HistoryFrame.kind` 增加 `'reply'`：`'message'` 粒度下，一个有正文的
  `assistant-step` 节点成格，读数条标 `history.replyTag`（回复 / Reply）。有三条边界写进了代码注释与
  `docs/history-jump.md` §5.1.1：
  1. **只在提问也在格上时才成格**（`seenTurns.has(turn)`）——回复排在提问之后，窗口里没有 prompt 的 turn
     （只有 outline 的那部分）保留 outline 合成的格，读数条总数仍按 outline 口径，不会凭空多出回复格；
  2. **`'turn'` 粒度不变**，一回合仍只一格（开头 prompt）；
  3. **不复用**：回复的 `authoredByUser === false`，于是 `Ctrl+↑` 的"复用我写过的话"仍只走用户消息，
     而漫游停在回复上按 Enter 会把这段正文写回输入框（引用/续写）。
- `src/client/locales.ts` 增 `history.replyTag`（zh 回复 / en Reply），`FrameCursor` 的读数条与
  `HistoryPalette` 的行标记按 kind 而非只按 `systemInitiated` 取标签。

### 变更

- 受影响的既有断言按新契约重排：`tests/history-cursor.spec.tsx`（漫游首停由最新用户消息变为最新回复、
  四次 Up 才到最旧格、行高亮/滚动/`CSS.escape` 的目标 key 由 `u2` 变 `a2`）、
  `tests/history-palette.spec.tsx`（列表由 2 行变 4 行、`data-atlas-frame-count` 由 2 变 4）。
  全套 40 文件 979 通过 / 1 跳过（新增 4 条针对回复格边界的断言）。

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.9-port.2] - 2026-10-26

### 修复

- **历史面板快捷键的文档/实现互相矛盾**：`src/client/history-keys.ts:157 isCommandOnly` 要求
  「命令键且不带 Shift」，于是实现只认 `Ctrl/Cmd+H`，而 `src/client/index.ts:1442` 与
  `docs/history-jump.md` §2 选型表写的是 `Ctrl/Cmd+Shift+H`（选它的理由正是绕开浏览器历史记录与 macOS
  「隐藏应用」）。现在两种拼写打开同一面板（新增 `isPaletteChord`，`HistoryPalette` 复用它），`Alt` 仍被
  排除（Windows 上 `AltGr` 即 `Ctrl+Alt`）。首轮无头实测证据：`Ctrl+Shift+H` 命中 0、`Ctrl+H` 命中 1；
  改后两者都命中。

## [1.0.9-port.1] - 2026-10-26

### 移植

- **基座取自 npm/GitHub 最新发行版 `1.0.9`（tag `v1.0.9`），上游源码包里的新功能以补丁形式叠加上去**：
  源码压缩包自带的那份 `dsh-atlas` 已经无法启动（不带 `lib/`，且写的是宿主的旧设置 API），
  所以移植只搬 `src/`、`tests/`、`docs/` 的行为与代码，构建、依赖装配、发布清单全部沿用 `1.0.9`。
- **宿主 API 对齐 `@deepseek-ai/*@0.2.0-rc.2`**：注入工厂拿到的会话 id 是裸 `string`，进入领域函数前
  用一处 `sid()` 收口成 `SessionId`（品牌类型）；会话跳转改为先问 `uiWorkspace.openSession`，退回旧
  `sessions.open`，两者都没有就如实报"这一版客户端没有会话导航"。
  `useSession` / `useSessions` 这两个标准快照钩子按消费端约定补进 `SessionStandardProps` /
  `GlobalStandardProps` 的模块声明，运行时由 ui-session 提供，不再假装它们不存在。
- **设置命名空间带降级**：`ctx.settings.register` 在新宿主上由 dsh-purge 的兼容层提供；没有这一层时
  不再抛 `TypeError: ctx.settings.register is not a function` 把整个插件拽死，而是警告一句、
  用 schema 默认值继续跑。

### 新增

- **会话历史跳转（History Jump）**：`Esc` 进入选择态后 `↑` / `↓` 在历史消息间走，`Enter` 把那条话
  原样放回输入框；另有 `Ctrl + ↑ / ↓` 不进入选择态直接快速复用；`F1` 打开会话历史面板（可筛选、
  可只显示每轮首条、系统发起的一轮单独标注）。
  配套四个设置项：`historyJump`、`historyJumpFrames`（每条消息 / 每轮）、`historyJumpReuseMode`
  （覆盖 / 追加草稿）、`historyJumpSmartFollow`（是否跟随手动滚动改变"当前位置"，默认关）。
- **设置面板**：新增 `settings.section` 一节，把上面四项按"两个功能共用 / Esc 漫游 / Ctrl+↑↓ 快速复用"
  分组呈现。
- **文件夹选择器重做**：边输入边浏览（`atFile/browse`），不存在或越界的路径用"最长有效前缀 + 剩余部分
  当筛选"回答；`hasChildren` 探测决定能不能展开；Windows 列盘符；工作区外的常用文件夹按
  `sibling` / `parent` / `child` / `recent` / `family` 分组（`atFile/recentFolders`）。
- **条目上限不再吃掉你要的那一行**：名字被 `maxFiles` 截断时，目标那行以 `pinned` 顶到第一行。

## [1.0.6] - 2026-09-27

### 文档

- **tagline 换成"因果 + 承诺"句式（用户审批的 A 方案）**：
  *`any plugin registers · Atlas does everything else · you just @ it, click it, jump anywhere`*。
  去掉了并列形容词堆叠，也去掉了 `@-able` 这个可读性差的合成词（新门禁会把 `@-able` 当作**已退役措辞**直接判红）。
  同步面：`README.md` / `README.zh.md` 的 tagline、`package.json` 与 `dsh.plugin.json` 的 `description`（npm 卡片）、
  配图的 `aria-label` 与**图内那行字**、以及 **GitHub 仓库 About**。
  中文面保持纯中文：*任何插件都能注册 · 其余交给 Atlas · 你只管 @、点、跳*。
- **摘要门禁按"面的类型"分组，而不是放宽检查**：`meta`（两处 `description`）、`en`（英文 README/图）、
  `zh`（中文 README）、`art`（图内那行与 aria-label）各自有必须命中的短语。原因是**短元数据行物理上装不下
  README 的全部承诺**，而图的文案就是审批过的那句（用 `click` 而非 `clickable`）；把要求写死到"哪一类面必须说什么"，
  比把检查放松更有意义。

## [1.0.9] - 2026-09-27

### 文档

- **标签改为 `AT Last, All Sources.`**（原 `@ Last, All Sources.`）：两个 README、`package.json` 与 `dsh.plugin.json`
  的 `description`、配图 `aria-label` 与图内那行字全部同步。用户名形近 `@`，`AT` 才是产品名的起首两字母。
- **词标 `ATLAS` 的起首字母标色**：图里标题的 `<tspan>` 由 `dsh-`（灰 `#77839b`）+ **`AT`（品牌蓝 `#bcd2ff`）**
  + `LAS`（近白 `#eef1f7`）组成。实测 70 / 43 / 61 = 173 px，整词与 tagline 都在卡片内（tagRight 338 / 880）。

## [1.0.8] - 2026-09-27

### 文档

- **tagline 最终定稿（用户最终版，此后不再改动）**，且**中英文各自独立、绝不混排**：
  - `README.md`（英文面，全英文）：`**@ Last, All Sources.**` / `One @ . Jump anywhere.` / 英文引言；
  - `README.zh.md`（中文面，全中文）：`**@ Last, All Sources.**` / `**一 @ 即达。**` / 中文引言。
  - 同步面：`package.json` 与 `dsh.plugin.json` 的 `description`（npm 卡片）、配图的 `aria-label` 与图内那行字。
- **标题 `ATLAS` 标色**：图里的 wordmark 由 `<tspan>` 三段拼成 —— `dsh-` 用灰 `#77839b`、首字母 `A` 用品牌蓝 `#bcd2ff`、
  其余 `TLAS` 用近白 `#eef1f7`。实测三段宽度 70 / 25 / 81 px，整词 173 px，仍在卡片内。
- **去掉 tagline 的 `textLength="798"`**：那是为长句设的硬上界，短句下会把 47 个字符**拉伸**到 798 px（≈17px/字），
  看起来像字号被放大。现在按自然 15px 排版，实测行宽 296 px、右边界 336 px（卡片 880）。

### 修复

- **摘要门禁三处 bug**：① 提取器把"标签行"当成了 tagline（改为按 masthead 固定结构取第 2 行）；
  ② 图内那行用"第二个 text 元素"定位，而 wordmark 现由 `<tspan>` 组成 ⇒ 取错元素（改为按内容查找）；
  ③ 缺"英文面不得出现汉字"这条 —— 现在 `README.md` masthead 与图的两个面都按 `clean` 校验，
  英文面出现任何汉字即判红（本轮正是靠它抓出我在英文 README 里多留的那行中文）。

## [1.0.7] - 2026-09-27

### 文档

- **tagline 定稿（用户第二轮审批）**：*`any plugin registers; Atlas does the rest · you just @ it, click it, then jump anywhere.`*
  —— 保留 `All Sources` 作前半句的支点（去掉它，`any plugin registers` 就没有被涵盖的对象），尾句采用 `then jump anywhere`。
  同步面：两个 README、两处 `description`（npm 卡片）、配图 `aria-label` 与**图内那行字**、GitHub About。
  中文面纯中文：*任何插件都能注册；其余交给 Atlas · 你只管 @、点，然后到处跳*。
- **量过再定**：用真实卡片渲染对比三种候选 —— 用户给的**字面版** 113 字符（每字 7.06px，但首尾各出现一次
  `jump anywhere`，读起来像口吃）、去掉重复尾巴版 93 字符（每字 8.58px，字最大）、本定稿 110 字符（每字 7.25px）。
  用户原句里 `All Sources` 与句尾 `jump anywhere` 会语义重复，故按语义保留 `All Sources`、只换尾句。
  对比脚本：`Eason/tagline-compare.mjs`（留在本机可复跑）。

## [1.0.6] - 2026-09-27

### 文档

- **tagline 换成"因果 + 承诺"句式（用户审批的 A 方案）**：*`any plugin registers · Atlas does everything else · you just @ it, click it, jump anywhere`*。
  去掉并列形容词堆叠与 `@-able` 这个可读性差的合成词（新门禁把 `@-able` 当作**已退役措辞**直接判红）。
  中文面纯中文：*任何插件都能注册 · 其余交给 Atlas · 你只管 @、点、跳*。
- **摘要门禁按"面的类型"分组**：`meta` / `en` / `zh` / `art`（图内那行与 aria-label）各自有必须命中的短语 ——
  短元数据行物理上装不下 README 的全部承诺，图的文案就是审批过的那句（`click` 而非 `clickable`）。

## [1.0.5] - 2026-09-27

### 文档

- **tagline 改成"可注册 → 可 @、可点、可跳转"的因果句式**（去掉了与 `@ Last, All Sources` 重复的"一个 @，所有来源"）：
  中英 README、`package.json` / `dsh.plugin.json` 的 `description`（npm 卡片）、配图的 `aria-label` 与**图内那行字**全部同步：
  *any plugin can register its own · Atlas makes it `@`-able, clickable, jumpable*。
- **新增"摘要一致性"门禁**（`scripts/verify-publish-surface.mjs`）：六处摘要（两个 `description`、两个 README tagline、
  SVG 的 aria-label 与**图内文字**）都必须命中语言对应的关键承诺（en: `clickable`/`@-able`/`any plugin`/`categor`；
  zh: `可点`/`可 @`/`任何插件`/`类别`），且 `dsh.plugin.json` 的 `description` 必须与 `package.json` **逐字相同**，
  同时**禁止旧文案回归**（`…can register its own.` 结尾会直接判红）。这条门禁正是为了修掉本轮暴露的真问题：
  1.0.3 改了 README 与 aria-label，**图里画的那行却还是三个版本前的旧句**。
  （反向验证：把旧文案塞进受检面 ⇒ 门禁点名 `still carries the old tagline`。）

### 修复

- **修回配图的字符编码**：本轮我在做失败的反向验证时，有一处恢复用了 PowerShell 的 `Set-Content`/`Copy-Item`，
  把 UTF-8 当 ANSI 读写，导致 `—`、`·` 变成 `鈥?` 与 `路`（截图里表现为 `⍰`）。已用 node 做**字节级修复**
  并逐行 diff 确认：与 1.0.4 相比**只差预期的两行**（aria-label 与图内 tagline），无其他改动。
  教训与仓库既有纪律一致：**文本文件只用 read/edit/write 工具，绝不经 PowerShell 重写**。

## [1.0.4] - 2026-09-27

### 文档

- **配图里那行 tagline 也改了**：1.0.3 只改了 SVG 的 `aria-label`（屏幕阅读器用），**图里画出来的字还是旧的**
  `one @, every source, and any plugin can register its own.` —— 而 README / npm / GitHub 上看到的正是这张图。
  现在图上写的是：
  *`@ Last, All Sources — five built-in categories + @git + any plugin · every reference is a clickable link · a session link jumps`*。
- **给该行加了硬上界**：`textLength="798" lengthAdjust="spacingAndGlyphs"`，任何字体下都不越过卡片内缘。
  并**实测**（headless Chromium 渲染后量盒）：`cardW=880.0 tagLeft=40.0 tagRight=838.0 fit=YES`，
  该行宽度 798 与其声明值一致（脚本 `Eason/svg-fit-check.mjs` 留在本机，可复跑）。

## [1.0.3] - 2026-09-27

### 文档

- **tagline 明确写出「可点链接」**：此前只写"一次点击，直达会话"，没把最直观的那件事说出来 —— **`@` 画出的每个引用都是可点的链接**
  （用主题的链接色，暗色下即蓝 + 悬停虚下划线）。现在 README（中英）、`package.json` 与 `dsh.plugin.json` 的 `description`
  （**npm 卡片上显示的就是这一条**）、配图 `aria-label`，以及 **GitHub 仓库的 About 摘要**四处一致：
  *One @, every source; every reference is a clickable link, and a session link jumps to that session.*

### 修复

- **`release.yml` 去掉无效输入**：`actions/setup-node@v4` 的 `package-manager-cache: false` 不是合法输入，
  每次发布都会打印 `##[warning]Unexpected input(s) 'package-manager-cache'`；改为合法写法 `cache: ''`（表示不缓存包管理器）。

## [1.0.2] - 2026-09-27

### 修复

- **带空格的会话引用不再被切成半个 token**：草稿 token 的读取边界是"到空白为止"，而会话标签里经常有空格
  （`@[继续 LoongCrush J 项目的任务](dsh-session:…)`），于是它被切成 `@[继续` 这一片。现在完整的 wire 引用
  （方括号 + `dsh-session:` 载荷）**优先**被作为一个 token 读入；官方引用语法本来就只有这一种承载空格标签的
  写法，所以修复后这类引用能正确解码成会话并画出可点链接（而不是落进文件规则）。
- **诊断线索**：手打**裸标签**式（`@继续 LoongCrush J 项目的任务`，没有方括号与载荷）在语义上不是会话引用，
  token 只能是 `@继续`；这类不存在的路径在验证阶段会让 Host 报
  `cannot resolve target "…\继续": ENOENT`。要引用会话请用 `@` 菜单的「过去的聊天」插入，它会写入带载荷的
  方括号形态。

### 新增

- **会话引用可点击跳转**：草稿里手打的 `@<会话id>`（或 `@[标题](dsh-session:…)`）与已发送气泡里仍带 wire 形态的会话引用，
  现在都是**可点链接**——点击即切换当前会话（复用侧栏列表项的同一动作，外观/路由/持久化一致），跨工作区有效。
  判定规则刻意保守：wire 形态按 payload 精确解码（base64url + 规范化回环校验，坏 URI 一律拒绝）；
  **裸标签只有唯一命中**（等于某个会话 id，或等于**唯一一个**会话标题）才成为会话链接，
  所以 `@AGENTS.md` 这种同时也是工作区文件的名字**永远不会被劫持**；同名/过期会话保持原样（可读、不可点）。
  **边界**：**已发送**的气泡只有在 chip 仍带 `dsh-session:` 载荷时才可点 —— Host 在落库前会把提及折成裸标签，
  那时 id 已不在文本里（已按上游通道提报）。
- **新增回归守卫**：补上"profile 未挂 right Sidebar"这条已文档化降级路径的测试（此前**零覆盖**），以及
  会话引用的**组合层接线**守卫；并用"故意破坏实现"实验证明这些守卫真的会失败。

### 文档

- **介绍口径修正**：tagline 与首段补上两点此前只写在代码里的事实 —— ① **会话引用本身就是链接**（草稿里点它即切换会话）；
  ② 本部署实际是 **6 个资源族**（五个内置类别 + 内置的 `@git` provider）。此前的措辞只说"五个内置类别 + provider"，
  读者不会知道菜单里真能看到并使用 `@git`。同步改了 `package.json` 的 `description`（npm 卡片用）、配图的
  `aria-label` 与图内文案，以及"输入快捷键只显示五个类别"这类描述。

## [1.0.1] - 2026-09-26

### 变更

- **声明 DSH 版本要求**：`package.json` 新增 `engines.dsh` = `>=0.1.6-alpha.1`（本插件实测运行于该版本）。
  社区插件市场（`dshmarket`）的卡片会读取 `engines.dsh`（或 lockstep 的 `@deepseek-ai/dsh-*` peers）来显示"主机兼容"角标；
  此前只有 `engines.node`，市场无从判断主机是否满足。
- **发布流程改为 OIDC 可信发布**：`.github/workflows/release.yml` 用 GitHub Actions 的 OIDC 身份发布，
  **不再需要 `NPM_TOKEN`**，也不再需要 2FA/OTP 动态码（npm 的 2026-07-31 changelog 已计划于 2027-01 取消 bypass-2FA token 的直接发布权）。
  首次发布（1.0.0）仍是交互式完成的，因为 npm 的 trusted publisher 只能挂在**已存在**的包上。

## [1.0.0] - 2026-09-26

首个统一 `@` 提及版本，基于 [`dsh-at-file`](https://github.com/FSMargoo/dsh-at-file) v0.6.5（MIT）扩展。

### 新增

- **引用成本与失效提示**：引用栏按文件大小显示 ≈token 成本（超过 8000 token 高亮），
  并对工作区内已不存在的引用标出「已失效」。两者共用只读端点 `atFile/inspect`——
  只读目录项元数据（存在性/类型/大小），**不读取文件内容**。
- **行范围引用**：`@src/a.ts:12-40` 引用指定行区间（单行 `:7`，倒序自动归一），Host 注入 `lines` 属性；
  目录不接受行范围；Host 不打开文件，因此不校验行号上界。
- **五个类别**：文件、文件夹、Skill、过去的聊天、已安装插件；类别行常驻菜单顶部。
- **`@` 数据源 seam**：第三方插件可用 `ctx.get('atlas').register(...)` 注册自己的 `@` 类别，
  菜单每次打开都从实时注册表重建类别行，**本包不需要为任何 provider 改动**。声明必须带
  `scopes`（会碰什么）与 `testedOn`（真正跑过的 DSH 版本）：缺任一项拒绝注册，版本不匹配以
  `verified: false` 注册，运行版本未知时永不算已验证，`id` 重复直接抛错并指名先注册者。
  两半设计（浏览器 `list` / Host `resolve`）对应 DSH 插件的两个半边，`id` 把两半绑在一起。
  可选 `open(item, ctx)` 只属于浏览器半边：provider 自己声明"点开我的 item 是什么动作"，
  没声明就没有动作（chip 保持不可点，也不会被画成可点）。
- **`@git` 内置数据源**：工作区变更文件（`git status` + `--numstat` 显示增删行数），
  引用内容是该文件的 `git diff`；未跟踪文件走 `diff --no-index`（仍由 git 产出，插件不打开文件）；
  不在 Git 仓库时静默为空。它按第三方方式实现，同样受 seam 的注册与版本门禁约束。
- **引用注入的预算与治理**：`<atlas-reference provider=… item=… scopes=… verified=…>`；
  单条正文上限 16 KiB、单步合计 48 KiB，超长截断并标记 `truncated="true"`，
  正文里的 `</atlas-reference>` 会被转义而无法提前闭合信封；provider 未注册、`resolve` 抛错或
  返回空正文时**不注入任何内容**，也不会阻塞本次发送。
- **类别入口**：`file:` / `folder:` / `skill:` / `chat:` / `plugin:` 前缀，单字母快捷键 `F/D/S/C/P`，英文前缀补全（`fi`/`fo`/`sk`/`ch`/`pl`）与 <kbd>Tab</kbd> 补全提示。
- **已发送消息里的引用可点**：用户消息中渲染出的引用 chip（`@path`、`@"带空格"`、`@skill:name`、
  `@atlas:<provider>/<item>`）点击即打开——文件进右侧栏（无右栏则交宿主打开器），Skill 交给 Skill 源，
  provider item 交给该 provider 自己声明的 `open`。**只有真的能打开的 chip 才显示为可点**，且用的是框架
  自己的链接语言（`--dsw-alias-link` 蓝 + 悬停虚线下划线，渲染即上色）；框架自己接好点击的版本会渲染
  `<button>`，本插件自动让位，不重复触发。插件同时实现了框架的 `openReference` 钩子：客户端在草稿里
  激活某个引用 token 时，由拥有它的 source 打开（含 `@dir/` 这类按语法装饰的文件夹 token）。
- **混合结果**：跨类别搜索，按「最近引用」与「全部匹配」两段展示，每行带类别标签。
- **分组与折叠**：Skill 按管理层级与领域分组；插件按 npm scope 分组；过去的聊天按工作区分组并缩进子会话。
- **三类引用注入**：`<skill-reference>`、`<plugin-reference>`，以及历史会话的官方 `session-reference` 只读快照。
- **三个模型侧工具**：`past_chats`、`read_past_chat`、`plugin_info`。
- **设置项**：类别开关（Skill / 过去的聊天 / 插件）与候选数量上限。
- **历史会话支持**：profile 未挂载 `sessionReferenceResolver` 时由插件自行挂载。
- **性能**：首字符预热、stale-while-revalidate、宿主侧 30 秒缓存、跨窗口扫描合并。
- **图标体系**：按文件类型与语言区分的图标，Skill / 聊天 / 插件行各有图标。
- **容错搜索**：Skill、插件与**文件**的编辑距离模糊匹配。文件搜索**精确优先**——仅在精确排序为空时回退，
  长度小于 3 或含 `/` 的查询保持精确。
- **草稿里的引用就是链接**：识别源是插件自己（token 能解码成引用 + 宿主确认目标存在），不再依赖框架是否
  把该 token 装饰成引用——因此**手打的** `@AGENTS.md` 与从菜单选出来的一样：整条上色、点任意位置都打开、
  鼠标变手型。上色用 CSS Custom Highlight API 逐段绘制（Lexical 的文本 span 只允许一个文本子节点，
  包裹任何一部分都会破坏 token 内的输入），颜色取框架给引用用的同一个变量。
- **草稿里由其它数据源插入的 chip 也能点**：右侧栏文件树写入的原子 chip（框架画成 chip 蓝、且这个客户端
  不接点击）由插件补上打开动作。该源给 chip 的标签是**文件名**而完整相对路径只存在于草稿文本里，所以裸名字
  按两步还原：①插件索引里唯一同名 basename；②索引有歧义（如 `index.ts` 两处）时回退到草稿里唯一的同名
  token；仍不确定就**保持不可点**，绝不打开错的文件。
- **失效与判定时机**：目标已被宿主确认为不存在的 token，按引用栏同一套语言画成**暗色 + 删除线**
  （它是引用，只是打不开），并且**只对"写完"的 token 判定**——后面跟着空白（空格）或后面还有下一行
  （回车）。正在输入的 token 不下结论：`@N` 这类中间态必然"不存在"，边打边画删除线等于替用户还没写完的
  词下判决。**能打开**的 token 则在名字写成那一刻就变蓝，不需要等空格。

### 变更

- **文件夹引用默认在侧边栏打开，本地打开可配置**：草稿与历史消息里的**文件夹**引用被点击时，现在会同时打开
  **右侧边栏**（工作区内用 `dsh-resource://file/session/<会话>/<路径>`；工作区外用框架的第二个地址域
  `dsh-resource://file/absolute/<绝对路径>`）与**本地文件夹**；默认「侧边栏 + 本地打开」，
  设置里可改为「仅侧边栏」或「仅本地打开」（原行为即"仅本地打开"）。
  侧边栏拒绝读取工作区外目录时（内置 files 面板正是如此）不报错中断：那一半静默失败，本地打开照常执行。
- **工作室命名规范落地**：本项目归 **Side Quest（支线任务）** 工作室 —— npm 包名改为 **`@sidequest-007/dsh-atlas`**（工作室 scope + 生态惯例 `dsh-*`），
  `author` 标注工作室，仓库地址与 npm 元数据指向**实际托管仓库** **`jameswatt139240-crypto/dsh-ATLAS`**。
  **有意不动的**：DSH 插件 id 仍是 `dsh-atlas`（仓内 `dsh.plugin.json` / `cordis.patch.yml` / 客户端 bundle id / Typert `package` 与
  `dsh-atlas#…` 编解码 id / 日志前缀 / 设置命名空间 `at-file`），因为它们不是品牌而是**生态与线上的身份**：改了等于换插件、换协议，
  会让已装用户与已发出的引用失配。对外显示名仍为 `dsh-ATLAS`。
- **工作区外引用（外域）· 宿主侧已落地**：`@` 现在可以引用**工作区之外**的绝对路径（DSH 插件开发常要引用
  更上层的 `deepseek-harness` 等目录），并按用户拍板的口径**按权限门控**：
  - **完全权限（`danger-full-access`）**：任何真实存在的绝对路径都可引用，且**用过的会被记进后台账本**；
  - **更窄的模式（仅可查看 / 工作区内修改）**：只放行**账本里已有的**外域——也就是你自己在完全权限下引用过的
    那些路径（含文件本身，以及账本目录下的任何路径）；不新增、不扩大搜索面。
  - 依据（已核对源码）：框架的文件沙箱**只管写入**（`dsh-fs-sandbox`：read-only 拒写、workspace-write 只允许写
    工作区+临时区、danger-full-access 不设栅栏），打开路径也不检查归属，所以"工作区外一律拒绝"本来就是本插件
    自己的规则；现在这条规则改由**宿主**按 `ctx.sandboxPolicy.resolve({ session })` 判定，客户端只渲染宿主的结论。
  - 外域引用在注入时用**独立标记** `<external-reference … />`（不复用 `<workspace-reference>`），模型一眼能看出它
    不在工作区内；引用栏/草稿里也带 `outside` 标记。账本只存**路径**，不存内容，上限 100 行、按最近使用淘汰。
  - **`@folder:` 的「工作区外文件夹」行（S3 已完成）**：完全权限下，`@folder:` 的**最前面**是**工作区上一层目录本身**
    （"引用上层 DSH 目录"正是这句需求的原话），随后是同级的可见兄弟目录（例如 `deepseek-harness/`）。
    **隐藏目录（`.` 开头）一律不列**：工作树上一层通常是缓存与临时目录，列出来反而把真正要用的两三个文件夹挤到折叠线以下
    （这是用户实测截图反馈后改的）。每行都标注「工作区外 · <父目录>」，选中即写入
    `@folder:E:/…/deepseek-harness/` 这样的**绝对路径**（文件夹形态），发送时注入 `<external-reference … kind="directory" />`
    并**记进账本**；此后在窄模式（仅可查看 / 工作区内修改）里，**账本里已记的外域文件夹**照样出现在同一位置
    （宿主裁决，客户端只渲染；见 `atFile/external`）。取一层 `opendir`、跳过符号链接与忽略目录、上限 12 条，**不是遍历**。
  - `@file:` 的"工作区 + 已选外域根"多根搜索是下一个切片（S4）。
- **菜单图标改为插件自绘的真图标（现代线稿，单色）**：根因是框架的菜单行只把候选的 `icon` 交给它自己的
  `ReferenceIcon`，而后者只认 `session` / `file` / `folder` 三种（上游 `ui-primitives/src/ReferenceIcon.tsx`，
  无 default、也不接受组件）；插件此前递的是 React 元素，于是每行都留一个**空图标框**。现在插件改为
  **预定图标槽**（声明三种之一，保证名字统一缩进）＋在列表上方的固定层里画自己的图标（与引用栏同一套
  Tabler 线稿，含按文件类型/语言的标记；`@git` 用分支图标）。**不向框架拥有的行插入任何节点**：只在该槽
  被覆盖时给它加一个属性，用来隐藏框架自己的字形——覆盖不到就什么都不隐藏，不会留下空框。回归护栏：
  菜单每一行的 `icon` 必须是三种框架 kind 之一或完全缺席。
- **类别图标改为语义色**：类别是**意图**（要引用哪一类东西），不是数据，所以只有类别行花颜色，而且每个颜色都对得上它已有的含义：
  **文件=蓝**（产品里引用/链接就是蓝）、**文件夹=绿**（可进入的容器）、**Skill=红**（闪电即能力）—— 最常用的这三个正好是
  最快认出来的三原色；**聊天=紫**（主题里没有这个色相，用固定值）、**插件=琥珀**（扩展在编辑器里一贯是琥珀）、
  **`@git` = 它自己的品牌橙红**。色值写成 `var(主题令牌, 固定回退)`，深浅主题都跟着走。
  **承载数据的行保持中性灰**：二十个文件名配二十种颜色是装饰不是信息，它们的类型字形已经说明了身份。
- **菜单宽度交还框架**：本插件以前用 `max-content` 让菜单按内容变宽，最宽可到 760px —— 结构上就可能**比输入框还宽**。
  现在不再设置宽度，框架自己那套"绝对定位 + left/right 都为 0"把弹层约束成**与输入框同宽**（输入框本身又被
  `--dsh-composer-card-max-width` 限住），长名字改为在卡片宽度内换行。
- **菜单改成"底部工作带"**（用户的交互要求：眼光不要上下来回跑）：
  - 本插件的 `@` 数据源以**正的 `order`** 注册 → 它的分组是菜单里**最后一个**分组，五个类别与提示行都在最靠近输入框的那一带；
  - 行内顺序改为**结果在前、五个类别在后、`Tab 补全` 提示行最后**（提示行新增 `completionHint` 标记，导航器的默认高亮优先落在它上面）；
  - **单个快捷键字母不再触发混合搜索**：只显示五个类别 + 提示行（意图明确时不必让用户从匹配结果里挑）；过滤从「非快捷键的首字母」或「第二个字符」开始。
  - **空查询时高亮归本插件**：否则框架会把高亮放在它自己数据源的首行并 `scrollIntoView`，把我们的底部工作带顶出视野（表现为"类别一闪就变成文件与文件夹"）。
  - **整条工作带锚定到底边**：框架只在**高亮变化**时滚动，而且是 `block:'nearest'`——把高亮行贴到最近的边。只看高亮行就会出现"高亮在类别第一行、于是它被贴到列表底边、下面几行全被折掉"（用户看到的"只显示文件 F"）。因此当**工作带本身就是内容**（没有任何结果行：空查询或单个快捷键字母）时，改为把工作带的**最后一行**锚定到底边（`block:'end'`），整带一起可见；一旦有结果行可读，就不再动滚动位置（那些由框架按高亮保持可见）。重放时机是**内容变化**（查询词、或任一分组的行数——框架自带数据源的候选后到正是靠这个），**单纯的悬停高亮变化不重放**：否则用户往回滚一屏会被拽回来。
- 包名由 `dsh-at-file` 改为 `dsh-atlas`；Remote 命名空间在 `atFile/*` 之外新增 `atMention/*`。
- 工作区索引上限默认值由 5000 调整为 2000。
- 引用栏「打开路径」改用 `ctx.remote.session.openWorkspacePath`。
- **插件在菜单上只拥有两个手势**：高亮在组标题上时按 <kbd>Enter</kbd> 折叠/展开，以及点类别行/返回行后
  保持菜单打开。其余按键（<kbd>Tab</kbd> 补全、<kbd>↑</kbd><kbd>↓</kbd>、<kbd>Esc</kbd>）全部交还框架自己的
  keymap，插件不再接管，也不再假装接管。

### 修复

- **菜单行数改为「天花板 + 滚动条」，并新增 <kbd>PageUp</kbd>/<kbd>PageDown</kbd> 翻页（用户口径，见内部需求文档 R-06）**：`@folder:` 与 `@file:` 的行数上限
  统一为 `MAX_CANDIDATES`（20），**不再为了凑行数而截断或折叠**——装不下就由列表**滚动**；焦点行（以及排在它上面的优先行）在内容变化后一定会被拉回可视区
  （`scrollIntoView({ block: 'nearest' })`，本来就在视野内时是空操作，不会把用户正在读的列表扯走）。新增本插件的第三个菜单手势：<kbd>PageDown</kbd>/<kbd>PageUp</kbd>
  按**实测一页**（列表可视高 ÷ 行高，无布局时 8 行）移动高亮，由框架把它滚进视野；高亮属于别的 `@` 数据源时改为滚动视口，不抢别人的选中项。
- **`@file:` 现在会被草稿里先写下的文件夹「作用域化」（用户口径，见内部需求文档 R-05）**：同一个草稿里 `@e:/work/docs/ @file:` 这样组合输入时，
  以 **`@file:` 之前最近的文件夹引用**为作用域，该文件夹自己的文件（一层）优先列出来，组标题写明**这是哪个文件夹、且在工作区之外**
  （`工作区外 · docs 中的文件`——只说 `docs 中的文件` 会被读成工作区自己的 `docs` 文件夹，用户已指出）。
  **不需要连接词**——作用是位置决定的，不引入「的」之类的自然语言语法。分档与 `@folder:` 同构（区内名称命中 → 作用域名称命中 → `路径匹配`），
  行数上限同为 **20**（`MAX_CANDIDATES`，见 R-06），`路径匹配` 的折叠口径一并复用（默认展开、只吃剩余额度）；作用域只走宿主现有的 `atFile/list`（区外路径一样过 `allowsExternal`），
  按路径缓存并 stale-while-revalidate。无作用域时的 `@file:` 老行为不变。
- **`@folder:` 过滤态的可见区域与行数上限（用户口径，见内部需求文档 R-03/R-04）**：可见区域永远先给**区内、再区外**的**名称命中**；
  整组行数上限 **10**（含分组标题与「返回类别」），名称命中先花预算，`路径匹配` 组**默认展开、只吃剩下的额度**——
  「如果多就折叠」由**预算**执行（名称命中占住前几行，路径命中再多也埋不掉它），预算被吃光时整组**不渲染**（不留一个
  展开也看不到行的死标题），用户手动折叠/展开永远优先，而折/展作用在**看到的状态**上（否则在默认展开的标题上按回车会「折成展开」）；
  空查询里 `选择文件夹…` 不吃预算（它是默认高亮）。同时让弹层**可以长高**：框架给菜单壳内联的 400px 上限由 CSS
  `!important` 覆盖，改用导航器实测的 `--dsh-atlas-menu-max`（上限 760px）；max-height 只封顶不拉伸，所以短列表不会被撑出空白。
- **「选择文件夹…」现在弹出选择器对话框（借官方 browse 后端，自绘外壳）**：官方的应用内对话框**借不到**——它是
  `dsh-client-ui-directory-picker-browse` 的 `BrowseDirectoryFlow`，挂在**工作区选择器私有的子 slot 洞**上
  （`conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`），而"渲染一个洞"的授权只属于声明它的那个 entry
  （`ui-slots` 会以 `slot "…" is not declared` 拒绝第三方），同名洞也不能重复声明；`directoryPicker/pick` 又是**原生**能力，
  只服务 browse 的 profile 会以 `directory-picker/unavailable` 拒绝。**能借的是它俩共用的后端**：
  `ctx.uiWorkspace.listDirectory` / `createDirectory`。所以新增 `FolderPicker.tsx`：路径行（可编辑，Enter 前往）、
  面包屑（`主目录` + 各级祖先都是跳转目标）、文件夹行带 `›` 下钻、`＋ 新建文件夹`、`显示隐藏文件`、`取消` / `打开`；
  `打开` ⇒ 把该目录作为 `@<绝对路径>/` 用 **span-CAS** 的输入机事件插回原 token 位置。有原生选择的 profile 仍优先弹系统对话框，
  两者都没有时回退到菜单内浏览。
- **「选择文件夹…」不再"点了没反应"**：原生选择器被能力拒绝时，以前只打一行控制台就结束（这就是你看到的没反应）——现在接管为
  我们自己的对话框，并说明原因。
- **「选择文件夹…」现在直接开产品自带的目录选择器**：以前打开的是我在菜单里自造的浏览器，而你要的是「添加工作区」那套/系统自带的
  选择界面。现在走 `uiWorkspace.pickDirectory()`（宿主原生选择器），选完把该文件夹作为 `@<绝对路径>/` **插回原 token 位置**——
  用输入机自己的 `slash/input-insert-text`（span-CAS：对话框开着时你若改过草稿，它会拒绝写入而不是写坏草稿）。
  没有该能力的构建**回退**到菜单内浏览（`⬆ 上一级`/其他盘符/子目录），所以那条路没有丢。
- **工作区内文件夹点击改为打开产品自带的「文件」tab**（就是你看文件夹的那棵树，行上还带 `@文件` 插入按钮）；外域文件夹仍开本插件
  自己的 folder tab——那棵树**拒读工作区外**。没有 files tab 的构建回退到 folder tab。**诚实边界**：`ui-sidebar-files` 没有
  params、也没有 reveal API，插件**无法指定"选中哪个文件夹"**，所以树从工作区根打开，定位那一步仍是用户自己点。
- **普通查询现在也会匹配区外文件夹**：区外行不在索引里，以前 `@do` 只能看到工作区内的 `docs`，看不到同名的区外文件夹。
  现在它们按**名字**参与匹配（按整条路径匹配会把某个父目录下所有兄弟都拖进来）。
- **folder tab 的行不再是一片灰底**：主题会给通用按钮上底色，导致每行都像一块底板（截图里那样）；现在行默认无底色，只有悬停才亮。
- **`@folder:` 的排列与优先级重做（按用户口径）**：外域文件夹原先是一张平铺列表，十几个兄弟仓库把**工作区自己的文件夹**挤到折叠线以下。
  现在固定顺序是 `返回类别` → **`选择文件夹…`（默认高亮就停在这一行）** → **默认折叠**的「工作区外文件夹」组 → 「工作区文件夹」组；
  折叠沿用插件本来就拥有的那个手势（组标题上 Enter / 点击），`dir-group` 与既有三种组同权。输入字母过滤时**两组一起过滤且都展开**。
- **`@folder:` 现在能在菜单里浏览文件系统**：点 `选择文件夹…` ⇒ 草稿写成**工作区根的绝对路径**并保持菜单打开（框架自己的
  `continue` 语义），随后列出该目录：`⬆ 上一级`、到盘根时列出**其他盘符**（`C:/ D:/ E:/ …`）、子文件夹（行尾箭头/Tab 下钻，
  直接点就是"就选它"）、以及文件（点了即文件引用）。`@folder:E:/` 这类手输绝对路径同样进入浏览，"换个盘"只需打一个盘符；
  外域路径仍由宿主按引用那道门控裁决，越权时菜单用中文写明**原因**。
- **盘根被规范化成"盘符相对"（真机抓到）**：浏览时"去掉结尾斜杠"那一步把 `E:/` 变成了 `E:`——Windows 上那是**盘符相对**拼写，
  会解析成"E 盘当前目录"（实测直接跳回本工作区）。现在盘根保留斜杠，并有用例钉住 `E:/`、`E:\`、`e:`、`E:/ws/` 四种拼写。
- **文件夹点了打不开侧边栏（工作区内、外都一样）**：两个框架事实叠在一起——`dsh-resource://file/…` 地址由**文件查看器**认领，
  它对目录只能回一句 `"…" is a directory`（用户截图那行红字）；而内置的 `files` tab 是一个**页面**（以会话工作区为根的树），
  **不接受任何地址**（它的 definition 里没有 `patterns`）。于是目录在侧边栏无处可去。现在插件注册**自己的资源类型**
  `dsh-resource://folder/<路径>`（kind `atlas-folder`）并实现对应 tab：一层目录、目录行在本 tab 内下钻、文件行交给原查看器、
  头部「↑ 上一级」+「在系统中打开」；工作区内与外域同一套（外域仍走引用那道门控，越权时**说明原因**而不是抛异常）。
  宿主新增 `atFile/list`（一层、上限 200 条、到盘根时列出其他盘符）——这也是 `@folder:` 菜单内浏览器的地基。
- **手打目录在引用栏里仍按"文件"处理**：草稿 token 已按宿主裁决的 `kind` 升级为文件夹引用，引用栏却仍用自己"按结尾斜杠"的解析
  ⇒ 图标是文件字形、栏内点击也按文件打开（真机实测：`@docs` 的栏内行为 `tabler-icon-file`）。现在栏内行同样读宿主裁决：
  宿主说是目录就显示文件夹图标、并按文件夹打开——两个界面不再对同一个引用给出两种答案。
- **`@folder:` 里选工作区外文件夹"什么都没发生"**：那些行带的是**绝对路径**，而 `onPick` 一律去工作区索引里查，
  必然查不到 ⇒ 返回 `undefined` ⇒ 框架的 pick 无论结果如何都会关掉菜单（`settle()` 里的 `reduce({type:'close'})`），
  于是表现为"选了外域文件夹，菜单消失、草稿里什么都没写"。现在绝对路径行直接落成 `@<绝对路径>/`（并计入使用统计）。
- **`@folder:` 的外域文件夹只剩两三个**：隐藏目录本来是在**取够 11 条之后**才过滤的，而工作树上一层几乎都是
  `.cache`/`.npm-*` 这类点目录（实测 11 个名额里 8 个被它们占掉）⇒ 真正要的 `deepseek-harness` 等被挤掉。
  现在 `listSubdirectories` 新增 `skipHidden`，**在遍历里就跳过**点目录，名额只花在会被展示的文件夹上。
- **手打 `@docs`（无结尾斜杠）不是文件夹链接**：token 语法按结尾分隔符判断文件/文件夹，手打的目录名因此被当成文件。
  宿主的 `atFile/inspect` 早已回答了这个路径**是目录**（`kind: 'dir'`），只是客户端把 `kind` 丢了。现在
  `draftActivation` 读取宿主裁决的 kind：宿主说是目录就按**文件夹引用**处理（与侧边栏插入的 `@docs/` 行为一致），
  结尾斜杠仍然优先；无 kind 的旧宿主不会误升级。
- **`@E:\…` 这类外域路径找不到自己的裁决**：宿主把工作区外路径按自己的规范拼写（正斜杠）返回，而 Windows 用户按平台拼写
  （反斜杠）输入，原先按原始文本查表 ⇒ 查不到 ⇒ 永远不是链接（引用栏也丢成本徽标）。现在两侧的裁决表都按
  `referenceKey`（正斜杠、去结尾分隔符）建键与查表。
- **`点击文件夹时` 设置根本存不下来**：新增持久字段要碰的**线缆 schema** 漏了——`atFileSettingsUpdateSchema`
  没有 `folderOpen` 这一支，而网关是拿它校验参数的，于是每次都 `gateway/arguments-invalid`；`atFileSettingsSchema`
  也没这个字段，写回时会被结果编解码器丢掉（界面永远显示默认值）。两处都已补上，并在 `tests/remote.spec.ts`
  加了往返断言。
- **工作区外的文件夹看不到"隔壁的 junction"**：单层列出兄弟目录时会跳过一切链接（那是**递归**遍历的纪律：链接成环会困住遍历），
  但宿主上那个最常被引用的 DSH 源码树正是以 junction 形式挂在工作区旁边 ⇒ 它**永远不出现**。现在 `listSubdirectories`
  新增 `followLinks`：单层列举时跟随链接，但只在它**确实解析成目录**时才作为一行（指向空处的坏链接不会被当成"打不开的文件夹"抛给用户）；
  递归的工作区索引仍然一律跳过链接（成环风险只在那里）。
- **`@file:` 首次打开把整个工作区塞进菜单**：空查询走 `recentFirstRows`，此前**没有上限**——实测一次返回 180 行。
  框架的菜单**不虚拟化**（每行都真渲染进固定高度的视口），于是每敲一个字符都要重渲染这 180 行再收敛到结果，
  输入过程里菜单一直在重排（"界面一直闪"）。现在与输入查询同样受 `MAX_CANDIDATES` 约束，且优先保留「最近引用」段。
- **改工作室 scope 后"菜单里整组消失"（客户端半边静默没加载）**：`dsh-client-modules` 是按**包名**登记客户端插件的
  （`graphRow(packageName, …)`，注释写明 "entry id (package name)"），而它定位包的方式是从加载器条目名出发、
  向上找第一个 `package.json` 且其 `name` **必须等于该条目名**。包名改成 `@sidequest-007/dsh-atlas` 后，我们
  `cordis.patch.yml` 里的 `name` 仍是 `dsh-atlas` ⇒ 匹配不到 ⇒ **宿主半边照旧加载（所以模型侧工具还在），
  客户端半边却不被登记** ⇒ 按 `@` 只剩别的数据源。现在：`cordis.patch.yml` 的 `name` 用完整包名；
  `build.mjs` 的 bundle 内部 id **从 `package.json` 派生**（不再硬编码，scope 再变也不会漂）；`dsh.plugin.json` 同步。
  `id` 标签仍是无 scope 的 `dsh-atlas`、显示名仍是 `dsh-ATLAS`；`src/invariant.ts` 的注册键也改为完整包名
  （`dsh-invariants` 用它做 `package_allowlist`/`package_blocklist` 匹配）。
- **菜单图标会画到菜单外面（压到输入框上）**：图标层是 `position: fixed` 的自绘层（这正是"不往框架拥有的行里插节点"的代价），
  因此**不继承菜单自己的裁剪**。框架的候选列表是一个滚动视口（`[role="listbox"]`、`overflow-y: auto`），而
  `getBoundingClientRect` 对**被裁掉的内容照样给真实坐标**——于是列表滚动后，滚动区之外那些行的图标槽仍然被测量到，
  图标就被画在菜单**下方**（用户看到：菜单外的输入框上浮着几个文件图标，和输入框里的图文重叠）。
  现在只给**完全落在滚动视口内**的行画图标；被裁掉或正好跨在边线上的行**不覆盖也不绘制**（保留框架自己那个字形），
  找不到视口（框架结构变了）就什么都不画——"退化成一个都不画"永远是安全方向。
- **类别行图标全都一样**：`menuGlyph` 漏了 `mentionKind: 'category'` 这一支，导致六行（含 provider 类别）
  全部落进兜底字形。现在按行的 `value`（`file:`/`folder:`/`skill:`/`chat:`/`plugin:`/`git:`）选各自的
  图标，provider 类别用它 id 声明的字形。
- **按 `@` 后类别"一闪被推走"、"只显示文件 F"**：框架只在**高亮变化**时滚动到高亮行；而框架自带
  `dsh-client-ui-reference` 数据源的行是**后到**的，上方内容变高 → 容器的滚动位置指向更早的内容 →
  我们底部的工作带被推下去（这是"一闪"）。同时框架的滚动用 `block:'nearest'`，只会把**高亮那一行**
  贴到最近的边，因此折叠线正好落在类别第一行上（这是"只显示文件 F"）。现在：高亮在空查询时归本插件，
  并且工作带本身就是内容时把**最后一行**锚定到底边，整带一起显示（见上文"整条工作带锚定到底边"）。
- **provider 类别现在可以有自己的快捷键字母**：取 id 首字母（`@git` → `G`），仅在该字母空闲时生效
  （内置 F/D/S/C/P 与更早注册的 provider 优先）；候选解析（`completionTarget`）与提示行同样支持 provider，
  因此 `@g`、`@gi` 都能落到 `@git:`。
- **provider 类别行的标签**：以前走 `cat.provider.<id>` 本地化键，字典里没有就原样显示键名
  （用户看到的是 `cat.provider.git`）。现在 provider 类别直接用它在 seam 上声明的 `display` 作为标签。
- **按下 `@` 时菜单分组顺序**：本插件的 `@` 数据源与框架自带的 `dsh-client-ui-reference` 同时注册在
  `@` 上，后者注册更早 → 它的文件列表排在前面。现在插件的数据源以**正 `order`** 注册（菜单分组按 `order`
  排序），本插件永远是最后一个分组，即最靠近输入框的那条底部工作带。

- **删除 textarea 时代的死代码**：输入框早已是 Lexical contenteditable，而旧的"行内幽灵补全 + 隐藏镜像测
  光标 + ArrowRight 进目录"整套实现是为 textarea 写的（`HTMLTextAreaElement` 守卫），在这个客户端里
  **永远不会执行**。删除该实现、`FolderNavigator` 及其测试与样式，`MentionNavigator` 从 554 行降到 362 行；
  键盘折叠分组头改挂在菜单状态上（不再依赖输入元素）。
- **文档与行为对齐**：中英 README、AGENTS.md 与注释里"灰色行内补全""<kbd>→</kbd> 进目录"等在本客户端
  不会发生的承诺全部删除或改正（框架的两条装饰正则只认词字符与分隔符，`@atlas:git/item.md` 只会被画到
  最后一个 `/`）。
- **测试在无符号链接权限的机器上不再误红**：`files.spec.ts` 的 fixture 现在探测符号链接能力，
  Windows 未开开发者模式且未提权（EACCES/EPERM）时跳过那一条断言，而不是让整个文件失败。

- **取消不等于失败**：菜单每敲一个字都会取消上一次查询，用户停止回合会取消 Host 侧的展开——这些
  `gateway/cancelled` / `AbortError` 此前被当成故障打进 `console.error`（`git candidates unavailable`、
  `… list failed`、`… expansion failed`、`… resolve failed`），会把真正的故障淹没。现在这四处统一先问
  `isCancellation(error, signal)`：由插件自己取消的就不出声。判断**以调用方的 signal 为准**（外加
  `AbortError` 名字），**不嗅探错误文本** —— 一条真的、恰好写着 "cancelled" 的失败照旧会被报出来。
- **打开引用前先确认目标还在，并把失效的引用标出来**：引用的生命周期长于它指向的文件——文件可能早已被
  删除或改名。此前把已消失的路径交给右侧栏，第三方侧栏（本机 profile 的 `dsh-better-sidebar`，其写路径
  规范化器 `ensureWorkspaceWritePath`）会抛 `cannot resolve target "…": ENOENT … realpath '…'` 的 400 错误。
  现在：引用栏里已知失效的行不提供打开动作（保留「已失效」标记）；chip 与其它入口点击时先用插件自己的只读
  `atFile/inspect` 确认存在性，目标已消失则**把 chip 标成失效**（去掉链接样式、加删除线）并且只打一行
  `console.warn`（此前是 `console.error`，看起来像故障）；探测本身失败（旧 Host 没有该端点）时仍按原样打开，
  不做拦截。seam 的 `open` 现在可以把这次点击的结果回传（`'gone'`），因此 `@atlas:git/<path>` 这类 provider
  提及同样会被标成失效 —— 内置 `@git` 就是把自己那次打开的结果透传上去的。
- **Typert codec 双代兼容**：同时提供 `schema` 与 `create()`，兼容安装版（校验 `codec.schema.parse`）与源码检出（校验 `codec.create()`）两套校验，修复 `strict codec has no create() factory` 导致的挂载失败。
- **引用栏打开文件失效**：旧实现调用的 `connection.api.host.openPath` 在当前 Harness 中已不存在，改用 `session.openWorkspacePath`。
- **设置页最近工作区**：`WorkspaceSnapshot.recentWorkspaceId` 已被移除，改为本地按「最新会话更新时间，否则创建时间」推导。
- **客户端依赖对齐**：`@deepseek-ai/dsh-client-store` 取代已移除的 `dsh-client-runtime`，并引入 `dsh-client-ui-renderer/client` 的 slots 声明。

### 说明

- **许可证为 MIT**：本仓库整体以 MIT 发布（首个版本即如此），是 OSI 认可的开源许可，因此不限制商用，
  也不影响要求开源许可的插件市场。上游 `dsh-at-file` 同为 MIT，其版权声明与许可原文保留在
  `LICENSE-ORIGINAL`，来源映射见 `NOTICE`。
- 首个发布版本**不含广告位**：默认构建（`pnpm run build`）会把 `@` 菜单旁的展示位与其横幅图片
  一并替换为桩，产物中既无广告代码也无图片字节；需要广告版本时使用 `pnpm run build:ads`。
- 与 `dsh-at-file` 二选一安装：两者都占用输入框的 `@` 触发位。
- 引用只传递路径、类别与来源，**从不读取文件内容**；正文由 agent 按需读取。

[1.0.0]: https://github.com/jameswatt139240-crypto/dsh-ATLAS/releases/tag/v1.0.0
