# 需求：会话历史跳转（History Jump）

> 状态：**已评审，决策锁定，实施中** · 日期：2026-09-28 · 范围：`@sidequest-007/dsh-atlas` 客户端半
>
> 一句话：**在 Atlas 里补上 Cursor 的那套"把过去那句话捞回来"的键盘流** —— 一次快捷键
> 打开当前会话的历史消息清单；一次 `Esc` 把焦点从输入框交还给整个聊天区，聊天区整体高亮，
> 此后 `↑`/`↓` 在「当前聊天框」和「上一条用户消息所在的框」之间来回跳；`Enter` 把选中的
> 那句话原样放回输入框。

---

## 1. 为什么做

用户给的口径是 Cursor 的两个好用之处，拆开是两件事：

| 用户想要的能力 | 现在在 DSH 里怎么做 | 代价 |
| --- | --- | --- |
| 重用过去说过的话 | 鼠标滚上去 → 框选 → `Ctrl+C` → 回到输入框 → `Ctrl+V` | 五步，且中间会丢焦点 |
| 在历史消息之间跳 | 只有右侧 Turn 导轨可点（`TurnNavigator`），无键盘入口 | 只能用鼠标 |

Atlas 的产品承诺是「你只管 @、点，**然后到处跳**」（README tagline）。目前"跳"只覆盖
**引用物**（文件/文件夹/Skill/会话/插件），不覆盖**会话自身的历史**——这是最后一个没被
接上的跳转面。补上它之后，一次会话里的完整回溯路径是：

```
@ 找到东西  →  跳过去  →  （新）Esc 跳回过去那句话  →  Enter 把它拿回来  →  改一改  →  再发
```

### 1.1 目标用户动作（验收语言）

1. 我在输入框里想改刚才那句话说错的地方 → 不用去滚、不用复制粘贴。
2. 我想看看这条会话里我到底问过什么 → 一次按键，一张清单。
3. 我在聊天区看着某段历史，想顺着上下文把某一问捞回来 → 两次按键。

---

## 2. 现状盘点（已核对宿主源码，标注验证方式）

> 这一节是本需求的地基。**每一条都来自 `../deepseek-harness` 源码或本仓库源码**，
> 未实测的一律标 `⚠ 待实测`。

### 2.1 聊天区的 DOM 契约（`packages/client/ui-chat`）

| 元素 | 属性 | 出处 |
| --- | --- | --- |
| 会话滚动容器 | `[data-conversation-scroll]` | `ui-conversation/.../skeleton/ConversationContent.tsx:267` |
| 输入框座位 | `[data-composer-seat]` | 同上 `:260` |
| 输入框卡片 | `[data-composer-card]` | 本插件 `src/client/MentionNavigator.tsx:250` 已在用 |
| 消息流容器 | `[data-chat-flow]` | `ui-chat/.../chat/ChatView.tsx:770` |
| 单条消息行 | `[data-chat-anchor-key="<key>"]` | `ChatNodeSeat.tsx:129` |
| 同上（排序键副本） | `[data-chat-flow-key]` | `ChatNodeSeat.tsx:130` |
| 同上（**节点种类**） | `[data-chat-flow-kind="user\|steering\|assistant-step\|…"]` | `ChatNodeSeat.tsx:131` |
| 同上（所属 turn） | `[data-chat-turn="<n>"]` | `ChatNodeSeat.tsx:132` |

`key` 的构造是**可解码的**：`ui-conversation/.../contract/conversation.ts:295`
`"${kind.length}:${kind}${id}"`。用户消息的 definition kind 是 `input-message`
（`ui-chat/.../conversation-nodes/message.ts:45`），所以
`data-chat-anchor-key="13:input-message<MessageId>"`。
**这条是本需求"DOM ↔ 数据对齐"的唯一可靠锚点。**

`⚠ 待实测`：本机 `apps/web/dist` 是一份**旧构建**（里面搜不到 `data-chat-flow-kind`、
`data-conversation-scroll`），线上 3080 跑的那份是否带这些属性必须实测确认。
若缺失，走 §7 的降级方案。

### 2.2 Chat 快照是 session 级标准 hook（**本需求最重要的一条好消息**）

- `ui-chat/src/client/contract/slots.ts:170-174` 把 `useChat: UseChat` 声明进
  `SessionStandardProps`；
- `ui-chat/src/client/apply.ts:73` 用 `ctx.uiSession.provide({ hooks: ['chat'] })` 真正注册它。

`ui-renderer/src/client/scoped-slots.tsx:368-394` 的 `standardProps()` 把 scope 级标准
属性**整包**发给该作用域的每一个 slot 组件。**所以本插件的
`conversation.input.overlay` 组件可以直接拿到 `useChat`**，读到的是宿主自己那份权威快照：

```ts
interface ChatSnapshot {
  order: readonly string[]                       // 渲染顺序的节点 key
  nodes: ChatNodeStore                            // get(key) → 节点（含 kind / data / location）
  locations: ChatLocationNodeIndex                // getTurn(turn) → 节点 key 列表
  navigation: ChatTurnNavigationIndex             // items() → 已加载 turn 的 { turn, anchorKey, prompt, response }
  timeline: ConversationTimelineSnapshot          // turnOrder / turns
}
```

`UserMessageNode` 的 `data` 形状（`conversation-nodes/message.ts:77-83`）：
`{ kind, messageId, seq, time, content, source }` —— **`content` 就是原始消息块，
不是渲染后的 DOM 文本**。

> **结论：整个需求不需要新增任何 wire 端点，也不需要碰 Host 半边。**
> 帧索引、原文、turn 归属全部来自 `useChat`。

### 2.3 输入机：写回草稿的官方入口

`ui-conversation/src/client/contract/input.ts:216-227` `InputActions.setDraft(text)`，
对任何 session 作用域 slot 组件可见（本插件的 `ReferenceLinks` 已经在解构 `useInput`）。
实现见 `input/editor/runtime.ts:148-161`：**整体替换草稿、光标落在末尾、合并进 undo 历史**。

→ 这正是"重用一条历史消息"需要的全部：一次 `setDraft` + 一次 `focus()`。

### 2.4 历史分页：`loadThrough` 是公开方法

`api/session-controller/src/client/contract/session.ts:124-133`：

```ts
loadOlder(): Promise<void>
loadThrough(seq: SessionSeq): Promise<void>   // 翻页直到窗口覆盖该 seq
```

而 `ISessions.sessionOf(ctx): SessionFace`（`contract/sessions.ts:116`），
`SessionFace = ISession & ObservableSnapshot<SessionSnapshot>`。
本插件已经会 `sessions.scope(sessionId)` 拿 `actx`（`src/client/index.ts:871`），
所以再走一步 `sessions.sessionOf(actx)` 就能翻页，`snapshot.hasMore` / `loadingOlder`
判断状态。

> **结论：F2 漫游可以覆盖"尚未加载"的历史**——向上越过窗口顶部时插件自己翻页。
> 这比"只支持已加载窗口"强一个量级，但也带来一个必须实测的时序问题（§8 A-04）。

### 2.5 键盘现状

- **宿主没有任何全局 keymap 服务**（`packages/` 全仓 `addEventListener('keydown')` 只有 6 处：
  Modal / Menu / 灯箱 / 设置页 / ContextMeter / 统计弹窗，且全在浮层里）。快捷键组合键是**空地**。
- 输入框的 `Esc` 只在 `@`/`/` 菜单打开时被消费（`input/editor/keymap.ts:106-115`
  → `ui-input-trigger/src/client/controller.ts:236-240`）。**菜单没开时 `Esc` 是空键**，
  本需求可以安全接管。
- `↑`/`↓` 在菜单打开时被输入机仲裁（`controller.ts:228-235`）；菜单关闭时是编辑器内移动光标。
  → F2 进入选择态后必须自己拦截，且**先判断菜单是否开着**。

### 2.6 宿主自己的 Turn 导轨（可复用的事实，不是可复用的代码）

`TurnNavigator.tsx` 已经证明了三件事，可以直接照抄手法：
① 用 `[data-chat-anchor-key]` 精确定位行（`ChatView.tsx:40-47` 的 `anchorElement`）；
② 落位用 `el.scrollTop += flowTop(row, el) - 24`（`ChatView.tsx:421`）；
③ 区分「已加载」与「未加载」两类 turn，未加载的先翻页再落位（`ChatView.tsx:726-744`）。

---

## 3. 需求范围

拆成两个功能，**共享同一份帧索引与同一套视觉语言**。

### F1 · 历史消息面板（检索型）

| 编号 | 需求 |
| --- | --- |
| R-01 | 一次快捷键唤起面板，**在聊天窗口内**（不是侧边栏、不是系统对话框）以浮层形式显示当前会话的历史消息 |
| R-02 | 列表每行 = 一个 turn：左侧 turn 序号/时间，主体是该 turn 的用户提问摘要，下方一行是助手回答摘要 |
| R-03 | 面板内可直接键入过滤（子串匹配，匹配提问与回答两段） |
| R-04 | `↑`/`↓` 移动高亮，`Enter` 把高亮行**取回输入框**并关闭面板，`Esc` 关闭 |
| R-05 | 列表默认倒序（最近的在最上），`Enter` 取回后光标在输入框末尾 |
| R-06 | 面板不得遮挡输入框（`--dsh-composer-height` 已知可用），也不得遮挡正在流式输出的最后一条 |
| R-07 | 面板标题固定显示"当前会话"与消息条数；会话为空时显示空态文案而不是空白 |

### F2 · 消息框漫游（就地型）

| 编号 | 需求 |
| --- | --- |
| R-10 | 在输入框按 `Esc` → 焦点离开输入框，**整个聊天区被高亮**（外层选中态），进入选择态；光标初始落在**当前聊天框**（输入框这一格） |
| R-11 | 选择态内 `↑` 往更早一格、`↓` 往更晚一格；`↓` 从最后一条用户消息回到"当前聊天框"，`↑` 从"当前聊天框"进入**上一个用户消息所在的框** |
| R-12 | 每一格都被可见高亮，且自动滚动到可视区（`block: 'nearest'`，不打断用户正在看的滚动） |
| R-13 | 在**用户消息格**上按 `Enter` → 该消息原文整体写回输入框、光标落到末尾、焦点回到输入框、选择态解除 |
| R-14 | 在**助手/工具格**上按 `Enter` → 只解除选择态并把焦点还给输入框，不写草稿（这一格不可重用） |
| R-15 | 选择态内再按 `Esc` → 解除选择态，焦点回输入框，草稿**不变** |
| R-16 | 选择态内按任何可打印字符 / `Enter` / `Backspace` → **先解除选择态并退出（不拦截）**，按键按原义落到输入框（`Enter` 照常发送） |
| R-17 | 向上越过已加载窗口顶部且会话还有更早历史 → 自动 `loadThrough` 翻页，落位后继续向上；无更多历史时停在最旧一格并给一次轻提示 |
| R-18 | 帧列表随会话增长实时更新：新发一条消息后再次 `Esc`，"当前聊天框"之上多出一格 |
| R-19 | 切换会话立即解除选择态并清空光标 |
| R-20 | `Esc` 进入选择态时，**若正有 turn 在生成中且宿主把 `Esc` 解释为"停止生成"**，本功能让位（见 §6 冲突矩阵 C-02） |

### F1/F2 共同口径

| 编号 | 需求 |
| --- | --- |
| R-30 | 帧粒度 = **一条用户消息一格**（`user` 与 `steering` 同等成格）；锚点 = 该消息自己的行 |
| R-31 | 助手消息、工具调用、思考块**不单独成格**（`historyJumpFrames='message'` 时才放开成独立格） |
| R-32 | `steering`（插话）消息**单独成格**并在格上标"插话"（决策 D-03/D-07） |
| R-33 | 重用的文本 = `UserMessageNode.data.content` 里的文本块拼接结果（**原始文本**），不是 DOM 渲染文本；`@label` 形态的引用保持 `@label` 原样回填，从而在输入框里重新被识别为可 `@` 的引用 |
| R-34 | 附件（图片/文件）**不随重用回填**，只回填文本；原消息含附件时在面板/格上标注"含附件" |
| R-35 | 「当前聊天框」（输入框那一格）永远是游标序列的**最后一格**，内容是用户正在输入的草稿；`↓` 越过最后一条历史消息即回到它（决策 D-02） |
| R-36 | `Ctrl/Cmd+↑` / `Ctrl/Cmd+↓` 在输入框内**直接**逐格回溯（不经选择态、不画高亮），语义与 F2 的 `↑`/`↓` 完全一致（决策 D-05） |

---

## 4. 交互规格

### 4.1 F2 状态机

```
        ┌──────────────┐   Esc    ┌──────────────┐  Esc/Enter/可打印键
        │  输入态       │ ───────► │  选择态       │ ─────────────────► 输入态
        │ (草稿有焦点)  │ ◄─────── │ (聊天区高亮)  │
        └──────────────┘  Enter   └──────────────┘
                          (重用)      │  ↑ ↓
                                     ▼
                              光标在某一格上
                                     │ 越界且 hasMore
                                     ▼
                              翻页中(loadThrough) → 落位 → 继续
```

- 「整个聊天区高亮」= 外框描边 + 极弱的内发光，**不改变任何行的背景**；
  「某一格高亮」= 该行的左侧 2px 品牌色竖条 + 极弱底色。二者**必须能同时分辨**。
- 选择态期间，输入框本身**保持可见且可读**（它是列表的最后一格，不是被遮住的旁观者）。

### 4.2 按键表

| 场景 | 键 | 行为 |
| --- | --- | --- |
| 输入态 | `Esc` | 进入选择态（菜单已开 / 模态已开 / 会话生成中 → 让位，见 §6） |
| 输入态 | `Ctrl/Cmd+↑` | **直接**上溯一格并写回草稿，不进选择态（R-36） |
| 输入态 | `Ctrl/Cmd+↓` | **直接**下溯一格并写回草稿；已在「当前聊天框」则是空操作（R-36） |
| 选择态 | `↑` | 更早一格（越界 → 翻页） |
| 选择态 | `↓` | 更晚一格；从最后一条历史消息再向下 → 回到「当前聊天框」（草稿） |
| 选择态 | `Enter` | 用户格 → 重用回输入框；非用户格 → 仅退出 |
| 选择态 | `Esc` | 退出选择态，焦点回输入框 |
| 选择态 | 可打印字符 / `Backspace` | 退出选择态并**不拦截**，按键按原义落输入框 |
| 选择态 | `Tab` | 退出选择态（不移动焦点，让浏览器按原义走） |
| 选择态 | `PageUp` / `PageDown` | 跳 5 格（与菜单分页同一口径） |
| 选择态 | `Home` / `End` | 最旧一格 / "当前聊天框"（**边界跳转，不环绕**） |
| 任意 | `Ctrl/Cmd+Shift+H`（也接受不带 Shift 的 `Ctrl/Cmd+H`） | 开关 F1 面板 |
| F1 面板 | `↑` `↓` `Enter` `Esc` / 可打印字符 | 移动 / 取回 / 关闭 / 过滤 |

**第六轮补充的两条口径（A-15 / A-17），以及第八轮对 A-15 的反转（A-18 / A-19）：**

| 场景 | 键 | 行为 |
| --- | --- | --- |
| 选择态 | `Ctrl/Cmd+↑` `Ctrl/Cmd+↓` | ~~与裸 `↑` `↓` 逐帧等价~~ **→ 第八轮反转：仍走"快速复用"语义**，即取回该帧文本写回草稿，**不是**选择态的方向键（**A-18** 推翻 A-15；理由见 §A.12.1） |
| 选择态 | `↑` 在**最旧**一格的下一按 | **先尝试翻页**（A-12）；确认无更早历史后**再按一次环绕**（A-17）。环绕落点是**草稿位**（写回用户自己的草稿）。**仅漫游如此**——见下方 A-21 行 |
| 选择态 | `↓` 在**草稿位**的下一按 | 环绕到**最旧一条**历史消息（A-17 的反向。槽位 `0=草稿`、`N=最旧`，故两端的环绕互为镜像，**不是**回到最新一条）。**仅漫游如此**——见下方 A-21 行 |
| 输入态 | `Ctrl/Cmd+↑` `Ctrl/Cmd+↓` | 上溯/下溯一格并**写回草稿**；环绕仍在草稿位停止（不在 idle 态自动绕回，避免连按打转） |
| 输入态 | 无历史消息时 `Ctrl/Cmd+↑` | **必须给出可见反馈**（读数条提示无更早历史），不得静默无反应（A-16） |
| 两者的帧集合 | — | **chord 只在"用户主动发起"的帧之间循环**（预先过滤掉系统/插件发起的轮次，A-19 第 1 条）；**选择态漫游保留全部帧**（含系统发起），用于查看某条历史附近的前后记录 |
| 两者的游标 | — | **各自独立**：滚动页面 / 点右侧标尺栏都**不改变**任一功能的内部位置，除非开启**智能跟随**（`historyJumpSmartFollow`，默认关，A-19 第 2/3 条） |
| **两者的首尾循环** | — | **A-21 第九轮按功能拆分 A-17**：**漫游仍循环**（两端的环绕互为镜像，照 A-17 执行）；**`Ctrl/Cmd+↑/↓` 不再循环**，走到两端就**夹取停住**（"Ctrl up 和 down 去掉 首尾循环"）。**这一行必须与上面两条漫游行一起读**：循环是漫游的行为，不是两个功能的共同行为 |
| **chord 的起点** | — | **A-21**：刷新页面或用户发起新消息后，chord 的内部位置**重置回草稿位**，使用户复用文本的起点始终是"当下的初始位置"。刷新本就不需要代码（槽位是 `useState(0)`）；"新消息"的判定锚在 **chord 自己的遍历长度**变化上，并用"是否有轮次在跑"把用户发言与后台注入分开。**漫游不受此影响**（它的位置是用户显式停放的结果） |
| **提示栏描述哪个游标** | — | **A-25（A-21 的连带面）**：提示栏描述**最后动作过的那个游标**。两个游标独立（A-19），所以"漫游开着"并不等于"漫游游标动过"——先 `Esc` 再按 `Ctrl+↑` 时漫游游标一步未动，此时提示栏**必须**显示 chord 所在帧，否则会出现"输入框已是 `HISTORY-1`、提示栏却写 `当前草稿`"的自相矛盾。因此该判定是**状态**（`quickIsCurrent`）而非由 phase 推导。**并且**：chord 在自身最旧一帧被夹取时给出边缘提示，其可见性不依赖漫游 phase（`roaming: phase === 'roaming' || edgeReached`）——这就是 A-16"不得静默无反应"在 A-21 取消循环后仍然成立的原因 |
| **移到某一条时页面是否跟着动** | — | **A-26**：漫游走到**只存在于 outline 的帧**时，**必须先把该回合翻页进来，再滚动到它真正的行**（这类帧的 key 是合成的 `turn:N`，没有任何消息行带它，所以旧实现滚了个空）。系统发起的回合最容易触发，因为它同时是"最可能只剩投影"和"预览为空"的那一类（与 A-20 同源）。**翻页后仍无行可滚**（虚拟列表尚未铺行）**不提示**——那是正常情况；**因为没行才翻页、翻完仍没行**、以及**此构建没有翻页能力**这两种才在提示栏说明。**注意与 A-13 的关系**：A-26 的翻页使常规漫游步骤不再经过 A-13 的延后路径，**chord 成了唯一还能落到未加载帧上的手势**，因此 A-13 的守卫也必须覆盖 chord——否则 chord 会把 outline 的**有界预览**（截断文本）写进输入框 |

### 4.3 快捷键选型理由

| 候选 | 判定 |
| --- | --- |
| `Ctrl/Cmd+H` | ❌ Chrome/Edge 保留为"历史记录"，网页无法拦截 |
| `Ctrl/Cmd+Alt+H` | ❌ Windows 上 `AltGr` = `Ctrl+Alt`，输入路径时会误触 |
| `Cmd+H`（macOS） | ❌ 系统级"隐藏应用" |
| `Ctrl/Cmd+K` | ❌ 已被宿主命令菜单占用（`toggleCommandMenu`） |
| `Alt+H` | ❌ 部分 IME 用 `Alt` 做候选切换 |
| **`Ctrl/Cmd+Shift+H`** | ✅ Brave / Chrome 下空闲；语义是 History；平台统一（Win 与 macOS 同为 `Ctrl/Cmd+Shift`）。**实测口径（1.0.9-port.1）**：实现同时接受不带 Shift 的 `Ctrl/Cmd+H`，因此 A-06 的实测结论与本节选型并不冲突——两种拼写打开同一面板，`Alt` 仍被排除（Windows 上 `AltGr` 即 `Ctrl+Alt`） |

同时**必须可关闭**：设置里给"启用历史跳转"总开关，关掉后所有键彻底让位（§7）。

---

## 5. 数据契约

### 5.1 帧索引（客户端，零 wire 变更）

```ts
interface HistoryFrame {
  key: string            // Chat 节点 key = data-chat-anchor-key 的值
  turn: number | undefined   // node.location.turn.turn；unresolved 的节点没有归属 turn
  seq: number            // node.data.seq（durable seq，仅用于排障与去重）
  time: number           // node.data.time（epoch ms）
  kind: 'user' | 'steering' | 'reply'
  authoredByUser: boolean // kind === 'reply' 时恒为 false
  systemInitiated: boolean// 该 turn 的起点是不是系统发起（无 prompt 的格子在读数条上标注来源）
  hasAttachment: boolean
  text: string           // 原始文本
  preview: string        // 供列表显示的截断预览
}
```

构建：`useChat(s => s.order)` → `s.nodes.get(key)` → 过滤 `kind ∈ {user, steering, assistant-step}`
→ 按 `order` 定序、按 `turn` 归并（`turn` 相同的多条 steering 并入同一格还是各成一格：见 §10 待确认 D-03）。
没有 `turn` 的行（`location.kind === 'unresolved'`，通常是系统提示一类的注入上下文）**不成格**。

#### 5.1.1 阶梯就是页面右侧那把尺：一轮一格（A-33，2026-10-27 用户定案）

用户原话（第二轮）：「其实历史消息应该和 dsh 右侧的如图 的一致」，并选了方案 A。
右侧那条刻度是宿主自己的 `turnOutline` 投影：`turn/start` 折出一格，`user/message`（仅
`source.kind === 'user'`）填 prompt，`assistant/message` 取**最新**一条有正文的作为 response，
`seq` 就是 `turn/start` 的序号（翻页目标）。所以**一格 = 一个回合**，与谁发起无关。

Esc 的阶梯照抄这条规则，实现见 `src/client/history-frames.ts`：

- **默认粒度 `'turn'`**：一个 turn 只产出一格。有提问的轮次，锚在它的第一个提问节点上
  （`user`／`steering`），`answer` 挂第二轮行的回答摘要；没有提问的轮次（系统发起），
  锚在它**最后一个**有正文的助手节点上，标签是 **系统**。
- **结构上去重**：`seenTurns` 按 turn 认领，加上"有提问的轮次不再产出回复格"这一条，
  同一轮不可能出现两格——上一版把提问和回答各算一格，11 轮读作 22 格，而右侧只画 11 格。
- **回答只认最后一个节点**：一轮可能流出多个助手节点，第一段常是上文重放（浏览器通道实测：
  同一段开头在一轮之内出现两次），这与宿主 `turnNavigationItem` 的 `findLast` 取值一致。
- **`'message'` 粒度仍可选**：它保留"每条提问 + 每条回答都停"的细走法，读数条单位是「条」；
  `'turn'` 的读数条是「轮」。两个单位的区别写在读数条上，不靠猜。
- **翻页与总数**：窗口没加载的轮次由 outline 补格（`unloaded`，用 `seq` 翻页），
  所以读数条的总数 = 右侧刻度的格数。验收就用这一条：面板格数必须等于 `nav[aria-label="轮次导航"]` 的格数。

### 5.2 DOM 落位

```
document.querySelector('[data-chat-anchor-key="<key>"]')     // 与 ChatView.anchorElement 同一手法
→ row.scrollIntoView({ block: 'nearest' })                   // 已被 ChatView 的 follow-scroll 接管时需先脱钉
```

> ⚠ **R-12 与 ChatView 的 follow-scroll 会打架**：`ChatView.tsx:534` 在 `atBottom` 为真时
> 任何新内容都会 `toBottom()`。跳转必须先把会话从"贴底跟随"里摘出来
> （滚一下就自然脱钉，或复用 `chatScroll.save` 的语义）。这是 §8 A-05 的实测项。

### 5.3 面板列表数据

优先用 `useChat(s => s.navigation.items())`（宿主已经算好的 turn 摘要：
`{ turn, anchorKey, prompt, response }`），不足处（无 `seq`/`time`/附件标记）再按
`anchorKey` 回查 `nodes`。**不新增 Host 端点。**

### 5.4 翻页

```
face = sessions.sessionOf(sessions.scope(sessionId))
face.loadThrough(frame.seq)      // SessionSeq：durable seq
// 期间读 face 的 snapshot.loadingOlder / hasMore
```

---

## 6. 冲突矩阵（必须逐一处理）

| 编号 | 冲突 | 裁决 |
| --- | --- | --- |
| C-01 | `@`/`/` 菜单打开时按 `Esc` | **让位**：读 `inputTriggers.sessionOf(actx).menu.getSnapshot().open`，为真则不接管 |
| C-02 | 模态框的 `Esc`（`Modal.tsx:43-47` 冒泡监听，不 `preventDefault`） | **让位**：`document.querySelector('[role="dialog"][aria-modal="true"]')` 命中则不接管 |
| C-03 | turn 生成中按 `Esc`（宿主未来可能给它"停止"语义） | **让位**：`sessions.list.getSnapshot().byId[id]?.running === true` 时不接管 |
| C-04 | 会话切换 | 立即解除选择态、清空光标、关闭面板 |
| C-05 | 新消息追加 / 流式输出 | 帧索引增量重建；**不得**在选择态下强行抢滚动 |
| C-06 | 用户正在拖动会话滚动条 | 选择态下 `↓`/`↑` 之外不接管滚动；`scrollIntoView` 一律 `block: 'nearest'` |
| C-07 | 输入法组合中的 `Esc` / `↑` / `↓` | `event.isComposing` 或 `keyCode === 229` 一律放行（照抄 `keymap.ts:44-48`） |
| C-08 | 其它 `@` 菜单手势（PageUp/PageDown） | F2 的 PageUp/PageDown **仅在选择态生效**；菜单开着时让位给 `MentionNavigator` |

---

## 7. 设置与降级

### 7.1 设置项（新增字段 → **六处规则**，漏一处就静默失效）

**A-23：设置界面按"归属"分组**，三组各有标题与一行说明。分组不是排版偏好，而是**口径**——一条同时作用于两个功能的设置，如果混在其中一个功能的块里，用户会读成只对该功能生效（这正是用户报告的"容易弄混淆"）。

| 分组 | 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| **两个功能共用** | `historyJump` | boolean | `true` | F1+F2 总开关；关掉后所有键彻底让位 |
| **两个功能共用** | `historyJumpFrames` | `'message' \| 'turn'` | `'turn'` | 帧粒度：**默认一轮一格**（与右侧轮次导轨同一把尺，A-33）；`'message'` 时提问与每条回答各一格 |
| **两个功能共用** | `historyJumpReuseMode` | `'replace' \| 'append'` | `'replace'` | 重用时覆盖草稿还是追加到草稿末尾 |
| **Esc 漫游** | `historyJumpSmartFollow` | boolean | **`false`** | **智能跟随**（A-19 第 3 条）：开启后两条功能的内部游标才随**用户滚动 / 点击右侧标尺栏**到达的位置同步；默认关闭 = 两条功能各自维护自己的位置（A-19 第 2 条） |
| **Ctrl + ↑ / ↓ 快速复用** | （暂无专属设置） | — | — | 该组的**行为**由 A-21 锁定：不循环、随新消息重置回草稿位。分组本身即为将来新增该功能专属设置预留位置 |

**A-22：文案里不得出现暗示两个快捷键等价的表述**（如"也可直接用 Ctrl+↑/↓"）。两个功能是**独立**的快捷键，共用设置用分组标题说明即可，不靠一句"也可用……"来带过。

要改的地方（`AGENTS.md` 的"六处"）：
`src/contract.ts`（接口 **和** `AtFileSettingsUpdate` 联合）· `src/settings.ts`（schemastery 字段）·
`src/index.ts`（Host update 分支）· `src/client/index.ts`（写动词）· `SettingsSection.tsx`（设置行）·
—— 其中**两个 wire codec 本身就在 `src/contract.ts`**，少一个 arm 写入会报
`gateway/arguments-invalid`，少一个结果字段 UI 会静默回弹。

### 7.2 能力探测与降级

| 缺失的能力 | 降级 |
| --- | --- |
| `useChat` 未挂载 | F1/F2 整体禁用，设置里说明"当前客户端不支持"，**不静默失败** |
| `data-chat-anchor-key` 缺失 | 用 `order` 序号 + `data-chat-flow-key` 序号做位置对齐；两者都缺 → 只保留 F1 面板的"取回"能力，去掉滚动落位 |
| `data-chat-flow-kind` 缺失 | 改用 `useChat` 的 `node.kind` 判定（本来就不依赖它，见 §5.1）——**因此这条其实不是硬依赖** |
| `loadThrough` 不可用（老客户端） | F2 不越界翻页，停在已加载窗口最旧一格并提示"更早的历史未加载" |
| 浏览器无 Custom Highlight API | 用 `data-*` 属性 + 普通 CSS 画高亮（既有 `draft-links.ts:403` 的探测写法可抄） |

### 7.1 实测通道（2026-10-03 查证）

关于"怎么在 3080 GUI 上验收"，两条此前**猜错**的事实，现已源码查证：

1. **刷新页面不足以加载新 bundle —— 必须重启 3080。** `packages/client/modules/src/index.ts:898-903`
   的注释写明，bundle 是**激活时快照**（"the immutable bytes"），存在按包名索引的
   `table` 里；`fetchBundle()`（:635）只从这个 table 读字节，**从不读盘**。唯一的重读入口是
   `rebuilt(id)`（:663-685），而:658 的 JSDoc 明确它是"HMR watch 的注册钩子"。

   而 `dsh-client-hmr` 的 stat 轮询（默认 500 ms）**只在这个 dev 链被挂载时存在**，
   当前 3080 的 `web` profile 配置里 grep 不到它；插件自身文档也印证同一结论
   （`dsh-better-sidebar` 的 `chunk-loader.d.ts`：*"Chunk-only source edits still need a
   manual page refresh (the HMR poll watches only `client.js`)"*）。
   → **此前"刷新一下就行"的说法是错的**：2026-10-02 启动的 3080 进程内存里是旧 bundle，
   重建 `lib/client.js` 不会改变它已 serve 的字节。验收前需**重启 `dsh web`**。

2. **3080 需要 launch token 才能访问。** `packages/client/connection/src/browser-auth.ts`
   的 401 带 `WWW-Authenticate: DshLaunchToken realm="dsh web"`；凭据是 `dsh web` 打印的
   **一次性 launch token**，由访问该打印 URL（`?token=…`）换取 authority-bound cookie。
   token 本身由 `processLaunchToken()`（:52-57）用 `randomBytes` 生成并只存在**进程内 WeakMap**，
   **外部读不到**（这是正确的安全设计，不要去绕过）。
   → 验收必须由**已经持有 cookie 的那个浏览器**打开，或由用户重启 `dsh web` 并访问它新打印的 URL。

**重启前请确认 bundle 里确实有本功能**（`lib/client.js`，已构建，2026-10-03 02:34:19）：以下字符串都应存在——`atlas-history-jump`、`atlas-history-palette`、`loadThrough`、`next === state.slot`（A.1 第 1 项修复）、`inputActionsRef`（A.1 第 2 项修复）、`sessionRef`（A.2 第 4 项修复）。逐个实测均为 `True`。

---

## 8. 验收标准（可执行）

### A. 功能

- [x] A-01 输入框有焦点、菜单未开、模态未开时按 `Esc` → 输入框失焦，聊天区出现外层高亮。（见 §A.5：真正的原因是生成闸门读错信号，且 `Enter` 从不失焦；两项均已修复并实测。）
- [x] A-02 此刻按 `↑` → 高亮落在**上一条用户消息**所在格，且该格被滚进可视区。（同上，§A.5）
- [x] A-03 此刻按 `↓` → 高亮回到"当前聊天框"（输入框那一格）。（同上，§A.5）
- [x] A-04 在用户格按 `Enter` → 输入框里是**那条消息的原始文本**（含原有的 `@路径` 原样），光标在末尾，聊天区高亮解除。（同上，§A.5。**且写下即可继续输入**——用户实测反馈"无法回答当前已输入的草稿"，根因是**写入与聚焦的顺序**，见 §A.6。浏览器回归用例 `A-04b`。）
- [x] A-05 连按 `↑` 到已加载窗口顶部且 `hasMore` → 自动翻页并继续向上；无更多历史时停在最旧一格。（实现口径：越过最旧**已加载**帧时调用 `sessions.sessionOf(actx).loadThrough(frame.seq)`；`loadThrough` 不可用的旧客户端按 §5.4 降级为「停在已加载窗口最旧一格」，该降级亦有单测覆盖。**本轮补上 §5.4 要求的可见提示**：停在最旧已加载帧时读数条显示"更早的历史尚未加载"，不再静默；单测 `says so when the walk is parked at the oldest loaded frame`，另一条 `keeps the highlight on the oldest frame when roaming past the top` 钉住"停在原地且位置读数不变"。）
- [x] A-06 面板：`Ctrl/Cmd+H` 打开 → 显示当前会话的消息列表；输入子串 → 列表实时过滤；`Enter` → 文本回填输入框、面板关闭。（实现口径：§10 D-05 当时锁定 `Ctrl/Cmd+H` 而非 `Ctrl/Cmd+Shift+H`；1.0.9-port.1 起两者都接受，理由见 §2 选型表；列表按**帧**而非按 turn 罗列，面板同时匹配预览与助手答案。Windows 浏览器实测：4 行 → 过滤 1 行 → `Enter` 关闭且回填。）
- [x] A-07 重用的文本与原消息**逐字一致**（用一条含代码块、多行、`@` 引用、emoji 的消息验证）。（单测：`writes the original text back verbatim, code fences and refs included`——预览被折叠，但 `setDraft` 收到的是 `frame.text` 原文。）
- [x] A-08 重用后 `@` 引用在输入框里**重新被识别为引用**（触发 dock 显示），与手工输入 `@路径` 等价。（**两侧已实测**：机制一侧——`readContent` 只取 `type === 'text'` 的块**逐字** `join('\n')`，A-07 的逐字相等单测钉住了写回的是原始 token 而非渲染后的 DOM；dock 一侧——浏览器实测里手工输入 `@package.json ` 使 dock 出现 1 行（证明该页 dock 确实在工作），而重用一条不含 `@` 的消息后 dock 为空且草稿里不含该 token（证明写回的是**文本**，若注入的是标记则 token 会残留）。**仍未做的**：直接断言"重用一条**含** `@` 引用的历史消息使 dock 亮起"——验收通道的 fixture 里没有任何一条用户消息含 `@` 引用，凭空写这条断言等于让测试开始说谎。**已于第二十轮补齐**：验收通道新增 `history-walk-long` fixture（其中最新一轮 turn 40 的用户消息自带 `@package.json`），A-08b 直接断言——一次裸 `ArrowUp` 选中该帧、`Enter` 重用后 composer 文本**逐字**等于原文且含 `@package.json`，`[data-atlas-dock]` 恰好 1 行且含 `package.json`；把写回改成丢 token 的变异会让它与 B-10 同时变红。见 §A.5.3 与 §A.19.3。）

- [x] A-09 漫游读数条**停靠聊天框上方且不遮挡其他 dock**：渲染在 `conversation.input.dock` 槽位（纵向 flex + 6px 间距，结构性不重叠），在输入框之上、在聊天卡片水平范围内，空闲时**不占行**。（**已实测**：浏览器用例 `A-09/A.8` 直接比对读数条、输入框、卡片与同层兄弟的 rect；jsdom 侧三条用例分别钉住"读数条由 dock 半边渲染"、"不再测量也不写自定义属性"、"空闲时 dock 无新行"、"position 既非 fixed 也非 absolute"。宽度契约两条缺一不可，修复过程见 §A.8.2。）
- [x] A-10 `Ctrl/Cmd+↓` 回到草稿位时，拿回的是**用户自己写的字**；且用户在某轮漫游**之后**重新打的草稿，不会被上一轮遗留的暂存顶掉。（**两侧已实测**：浏览器用例 `A-04c` 先打字再上翻若干帧、再逐次下翻，断言最终**逐字**等于自己输入的文本；jsdom 侧两条用例覆盖暂存替换与"多帧漫游保留第一份暂存"。修复前实测拿回的是 `Create the relative path…`——本轮测试从未输入过的文字，见 §A.7.2。）
- [x] A-11 读数条**外观对齐 `/goal` 官方样式**（用户第四轮需求，此前只在对话里提过、文档未记）：背景/描边/圆角/高度/字号族与框架自身的 dock 卡片（`GoalBar`、`TodoPanel`）**同源**，即直接套用其 CSS 变量与几何数值，而非自造一套视觉。（**已实测**：浏览器用例 `A-09/A.8` 取 `[data-goal-bar] > :first-child` 这张**框架真实卡片**逐项比对 `height / radius / borderWidth / background`；jsdom 侧用例钉住两层结构——外层垫片 + 内层卡片——与其子元素构成。配方、两层盒子的必要性与 `0.5px` 报 `1px` 的 DPR 结论见 §A.9.1。）
- [x] A-12 漫游中在**已加载窗口的最旧一条**再按 `↑`，**自动翻页**到上一页并继续漫游，**不需要**用户去点页面右侧的标尺栏；只有**确认没有更早历史**时才停下并提示"已到已加载历史的最旧一条"。（**两侧已实测**：浏览器用例 `A-10/A.9` 一路按 `↑` 至游标停住、再按一次，断言提示出现、游标**不跳**、按 `↓` 后提示消失；jsdom 侧用例 `continues the walk into a page that actually arrives, and keeps counting` 用"真的把窗口撑大"的 loader 断言游标**继续前进**且序号与总数同步。此前的实现每次都误报"已到最旧"，根因是 promise 结算早于 React 渲染导致的读值竞态，见 §A.9.2。）

- [x] A-13 漫游的**帧总数与页面右侧标尺刻度一致**：帧列表除"已加载窗口"外，还必须并入会话级投影 `turnOutline`（整份日志），使**窗口里一条用户消息都没有**时总数也**不为 0**（用户第五轮反馈：截图上读数条写 `第 0 / 0 条`、标尺却有一排刻度）。未加载的轮次按用户口径"**全部纳入，按标尺刻度走**"成为可漫游的一格，并标记为 `unloaded`（只带投影的截断预览）。合并**按 `turn` 排序**（窗口可能从会话中间开始），且**窗口已持有的轮次以窗口为准**（否则原文会被截断预览顶掉）。（**已实测**：jsdom 侧 4 条用例覆盖"空窗口按投影计数"、"已加载窗口优先且不重复"、"畸形投影条目被窄化丢弃"、"投影缺失/非数组时退化"；浏览器用例 `A-13` 钉住不变量"总数 ≥ 标尺刻度数且 > 0"。**反向验证**：stash 掉修复后该 5 条以用户症状失败，其中一条的读数 `历史第 0 / 0 条当前草稿` 与截图逐字相同。根因与取证边界见 §A.10。）
- [x] A-14 `Ctrl/Cmd+↑` 在**窗口未加载任何用户消息**时也能调出历史消息（用户第五轮反馈原话："ctrl up 也无法调出 历史消息"，与 A-13 同根因、同轮修复）。另：`Enter` 落在 `unloaded` 帧上时**先翻页再写草稿**，取回的是该轮的**原文**而非投影的截断预览；翻页仍未带来该轮时**不写任何东西**（宁可不动，也不拿半句话冒充用户消息）。暂存键用 **`turn`**：投影帧的 key 是合成的 `turn:2`，加载后同一轮的帧用节点 id，两种拼法对不上；也不能用索引，翻页会使游标以下的索引整体位移。（**两侧已实测**：jsdom 侧 `lets the quick chord summon a message the window has not loaded` 断言从输入框直接 `Ctrl+↑` 逐次取回投影轮次的文本；`pages a turn in before reusing it…` 断言先 `loadThrough(22)` 且**最终写入的是原文**、`not.toContain('truncated previ…')`；`reuses a loaded frame immediately` 钉住**另一条臂**——已加载帧不得多付一次往返；另两条覆盖"翻页没带来该轮"与"帧在翻页途中消失"。浏览器用例 `A-13` 里 `Ctrl+ArrowUp` 从空草稿取回非空文本。）
- [x] A-15 ~~**选择态下 `Ctrl/Cmd+↑` / `Ctrl/Cmd+↓` 必须与裸 `↑` / `↓` 同义**~~ **（本口径已被 A-18 推翻，2026-10-03）**（用户第六轮反馈原话："进入ESC模式后，按ctrl + up或down 为何还是识别为 up 或 down？"）。**实测更正了第一版诊断**：选择态下 `Ctrl+↑` 并**不是**被整条丢弃 —— `resolveIntent` 的 `command && (ArrowUp|ArrowDown)` chord 分支排在 `phase === 'idle'` 判定**之前**，所以选择态下它也命中该分支，返回与裸 `↑` **字面相同**的 `{ kind: 'step' }`。用户说"还是识别为 up 或 down"是**准确的**：唯一差别是这次步进带着 **chord 语义**（走 `reuse` 把该帧**写回草稿**），而不是选择态自己的语义。**当时**的修法是把选择态的修饰键降级为裸方向键；**第八轮用户明确要的是相反的**——chord 应保留自己的"快速复用"语义，见 A-18 与 §A.12.1。诊断过程与"现象描述不是诉求"的教训保留在 §A.11.1。
- [x] A-16 **`Ctrl/Cmd+↑` / `Ctrl/Cmd+↓` 必须与当前会话的内容无关**（用户第六轮反馈原话："即便不进入ESC模式，ctrl up 或down 是否起作用 在不同的会话中 不同，例如 @Wheel Done复刻 by Space Bunny、@继续TripleIME开发 完全不起作用，但ESC是对哦"）。现状：idle 态的 chord 走"先 `stepSlot` 再 `reuse`"，而 `reuse` 写的是**历史帧的文本**；当帧列表为空时 `frameAtSlot` 返回 `undefined`，落到 `restoreOwnDraft()` —— 而 `ownDraftRef.current` 是 `undefined`（从未被覆盖过），于是它只调 `focusComposer()` 然后 **return**：既没写任何东西，也没给用户任何提示。会话越短/越新，`frames` 越可能为空（或全部是 `unloaded` 的投影帧），chord 就越像"完全不起作用"；而那两个会话正是**长会话**，它们的窗口已被分页/压缩，`snapshot.nodes` 里没有用户节点 → 帧为 0。修法：① `Ctrl/Cmd+↑/↓` 在 idle 态若**无从上溯**（帧为空），必须给出可见反馈而不是静默；② 说明并锁定"chord 与 `Esc`+`↑` 走同一条 `loadThrough` 取帧路径"，使两者不会出现"一个能用另一个不能用"。见 §A.11.2。
- [x] A-17 **历史漫游到尽头后必须首尾循环**（用户第六轮需求原话："希望实现 按键可在消息列表尽头循环到另一头的历史消息，例如：从历史第一条消息到了 最后一条之后，再按Ctrl up 就会回到 草稿（如果有的话）或者 历史第一条消息（如果没有草稿的话）"）。口径：**`Ctrl/Cmd+↑` 走到最旧一条后，再按一次回到草稿位**（写回用户自己的草稿）。槽位是 `0 = 草稿`、`N = 最旧`，因此**反向也循环**：在草稿位按 `↓` 环绕到**最旧一条**（两端的环绕互为镜像 —— 实现期实测纠正了"回到最新一条"的直觉，见 §A.11.5 第 3 条）。这是用户明确点名的**跨端循环**，`stepSlot` 现有的"夹取在 `[0, frameCount]`"必须改成**环绕**，且环绕方向与"上溯"一致。`Home` / `End` 仍为**边界跳转**（不循环），且 `↑` 在边界**仍要先尝试翻页**（A-12/A-05 的契约不能被循环顶掉：循环是"确认没有更早历史之后"的下一拍，由 `pageTriedRef` 记住"这一端已经请求过翻页"）。见 §A.11.3。

**第八轮新增（用户 2026-10-03 第五轮反馈；三条旧验收通过后提出的两点）**：

- [x] A-18 **选择态下 `Ctrl/Cmd+↑` / `Ctrl/Cmd+↓` 必须执行"快速复用"语义，而不是选择态的方向键语义**（用户原话："进入ESC模式后 ctrl up和down 为何还是起的 ESC模式的up 和down的功能？"）。**这条与 A-15 是同一处的两次相反口径，必须一起读**：A-15 的结论是"选择态下修饰键降级为裸方向键"，用户这条把它**推翻**了——用户要的是**两个功能各自保留自己的语义**：裸 `↑`/`↓` = 选择态的"移动高亮去看"，`Ctrl+↑`/`Ctrl+↓` = 快速复用的"把那条消息取回草稿"。因此 `resolveIntent` 里那条"选择态把修饰键降级"的闸门（`!navigating && (ctrlKey || metaKey || altKey)` 形态）要**改掉**：选择态下 `Ctrl/Cmd+↑/↓` 仍走 **chord 分支**（`page: false` 的 `step` + `reuse`），与 idle 态同义。见 §A.12.1；**A-15 的验收条目据此改写**。

  **实现完成（2026-04-10）**，提交 `5253f5f`。闸门已撤掉；回归单测 `reuses a frame on Ctrl+Up while roaming instead of only moving` 与 `reuses a frame on Ctrl+Down while roaming too`。**同时修掉了两条让这条口径长期未被发现的"空转用例"**：原先的 `treats Ctrl+Up exactly like ArrowUp while roaming` 在用例内部声明了一个从未接到组件上的 `const written: string[] = []`，随后断言 `expect(written).toEqual([])`——**恒真**。这就是 A-15 的错误口径能通过验收的原因，教训记为"**断言一件实现从未做过的事，是用例的 bug**"。见 §A.12.1。
- [x] A-19 **两条功能各自维护内部当前位置；循环时按各自的帧集合过滤**（用户原话："ctrl up 或down 是在用户发起的历史消息（但不包括系统主动发起的 轮次，因为用户并没有主动发消息）之间循环，以方便用户复用之前的消息，因此循环时要预先过滤掉 系统发起的消息；而 ESC模式主要是为了跳转到任何类型的历史消息（包括系统主动发起的），以方便用户查看该历史消息附近前后的记录；同时，无论用户手动移动了什么不同的页面，两个功能都是按自己内部的当前位置来处理"）。三件独立的事，逐条锁定：
  1. **帧集合不同**：快速 chord 的循环**只走用户主动发起的帧**（`source.kind === 'user'`，即 §2 的"帧"定义），**预先过滤掉系统/插件发起的轮次**；选择态漫游**保留全部帧**（含系统发起），因为它的用途是"查看某条历史附近的前后记录"。
  2. **游标各自独立**：两条功能各有自己的当前位置，互不覆盖。"用户手动滚动了页面"或"点了右侧标尺栏跳到某处"**都不改变**任一功能的内部位置。
  3. **唯一例外是"智能跟随"设置**：设置里开启后，内部位置才**随用户对页面的滚动、或点击右侧标尺栏到达的位置**智能判定并同步。**这是一个新增的持久化设置字段**（默认**关闭**，因为默认口径是第 2 条的"各自独立"）→ 必须走 §7.1 的**六处规则**。见 §A.12.2。

   **实现完成（2026-04-10）**，三条均已落地并各有回归单测：
   - 第 1 条：`HistoryFrame.authoredByUser` + `userAuthoredFrames()`；`resolveIntent` 的 `step` 携带必填 `quick`，chord 分支为 `quick: true`、漫游四个分支为 `false`。回归：`skips a system-initiated frame when walking with the chord`、`keeps the system-initiated frame reachable while roaming`。
   - 第 2 条：`quickSlot` 与 `slot` 两个 state + 各自一套分页/边界算术（`walkCount` 由 `intent.quick` 选择）。回归：`keeps the two cursors independent in both directions`、`reuses a frame on Ctrl+Up while roaming instead of only moving`。
   - 第 3 条：`historyJumpSmartFollow`（六处规则走全）；`FrameCursor` 用一个 `document` 捕获阶段 `scroll` 监听，按 `[data-chat-anchor-key]` 行到阅读线的距离选最近帧，同时重置两个游标。回归：默认关（`leaves both cursors alone when smart follow is off, which is the default`）、开启后随手动滚动重定位（`re-seats the walk on the row at the reading line when smart follow is on`）、随标尺栏跳转重定位（`re-seats the chord from a ruler jump, which is itself a scroll`）。
   - **三条实现均做过变异测试**：把 `walkFrames` 换回 `state.frames`、把游标重新合并为一个、把 `smartFollow` 恒置为 `true`，都各自让对应回归单测转红。
   - **第 3 条不需要 Host 改动、也不需要新线协议**——这是**查证过的结论，不是假设**：标尺栏点击走 `onNavigate` → `navigateToTurn`（`ChatView.tsx:722`），它**滚动的是聊天记录本身**，并不存在一个独立的"标尺栏位置"状态。所以"手动滚动"和"点标尺栏"到达客户端时是**同一个 `scroll` 事件**，位置信号完全可从现有 DOM（`[data-conversation-scroll]` + `[data-chat-anchor-key]`）读出。

  注：第 1 条与 A-16 的诊断**互相印证**——A-16 里"长会话 chord 完全不起作用"正是因为窗口分页后 `snapshot.nodes` 里没有用户节点、帧为 0；按本条口径，"用户主动发起的帧"才是 chord 的域。见 §A.12.2。

  注：A-19 第 2 条落地后，**A-16 的浏览器 e2e 用例前提失效**：它先把**漫游**游标走到最旧帧，再按 chord。现在 chord 有自己的游标，漫游走多远都不影响它，所以该用例改为**驱动 chord 自己**走到边界（用草稿的变化观察它的位置）。**这是用例的前提错了，不是产品坏了**——同一位置上"设计上就该花掉这一次按键"的情形，改的永远是用例。

**第九轮新增（用户 2026-04-10 验收 A-18/A-19 通过后提出的五点）**：

- [x] A-20 **漫游跳到系统发起的帧时，提示栏必须标注来源与其文字**（用户原话："ESC模式下 如果跳转到 系统发起非用户发起的消息，在提示栏也要显示标注为系统及其文字，不要像现在一样是空白"）。**根因已定位到具体一行**：`session-turn-outline/src/projection.ts:110` 的 `case 'user/message': if (event.data.source.kind !== 'user') return state` —— 大纲**只**在人类亲自发言时才记录该轮的 `prompt`，所以系统发起的一轮的 `prompt` 恒为 `''`，未加载时提示栏那格就是空白。而大纲的条目是 `z.object({ turn, seq, prompt, response }).strict()`，**不携带 source**，因此"未加载的系统轮"唯一证据就是它那个空 `prompt`。修法：`HistoryFrame` 增加**每轮判定**的 `systemInitiated`（与**每个节点**、无 source 时保持 `undefined` 的 `authoredByUser` 区分开——`undefined` 是"没有 source 可读"，**不是**"非用户发起"，所以不能据此标"系统"）；`RoamView` 增加 `tag`，栏内在分隔线与正文之间渲染 `.dsh_atlas_roamBarOrigin`。
  **实现完成（2026-04-10）**，提交 `5b8dac2`。回归单测：`labels a system-initiated frame in the roam bar and still shows its text`、`does not label a normal user frame as system-initiated`、`fills the blank cell of an unloaded system turn with the origin and a reason`。**验收脚本已实测**：`pnpm run check` 绿（815 passed | 1 skipped）。
- [x] A-21 **`Ctrl+↑/↓` 去掉首尾循环；并在刷新页面或用户发起新消息后重置内部位置**（用户原话："Ctrl up 和 down 去掉 首尾循环；且刷新页面或用户 发起新消息后 都将内部位置重置，以确保用户复用文本的起点始终是当下的初始位置（草稿位置）"）。**这条按功能拆分 A-17**：`stepSlot` 增加必填的 `allowWrap`，chord 传 `false`（在两端**夹取**），漫游仍传 `true`（**循环**照旧）。**"刷新页面"无需一行代码**——槽位是 `useState(0)`，重载本来就落在草稿位；需要重置的是"上一次复用把草稿留在半途"的那种存活状态，所以信号锚在**用户的下一条真实消息**上，锚的是 **chord 自己的遍历长度 `quickFrames.length`**（而不是整份帧表：插件注入的帧不在 chord 的位置空间里，不该重置它），并用 `sessionRunning` 把"用户刚发了消息"与"列表因别的原因变长"分开。
  **实现完成（2026-04-10）**。两处实现细节是**实测出来的、不是设计时想当然的**，都记在案：
  1. **重置必须发生在渲染期，不能放在 `useEffect` 里**。第一版写成 effect 调 `setQuickSlot(0)`，症状是"按了 Ctrl+↑ 却跳到最旧一条"。插桩证实：effect **确实**跑了，但它把重置排成了**第二次渲染**，而同一 tick 到达的 keydown 会**抢在它前面**读到旧槽位——于是从旧位置继续走。改成渲染期调整后，修正后的槽位就属于"看见新帧的那一次渲染"，任何 handler 都不可能再观察到旧值。
  2. **回归单测的 fixture 必须让"会话不变而节点集变长"**。用替换 `table` 的写法会让 `useChat` 的**函数身份**改变，那在组件看来是**切换会话**（另一条早就存在的重置路径），于是用例会**在没有 A-21 代码的情况下也通过**。改用既有的 `sessionStub`（同一身份、`set` 换内容）才真正测到本条。
  回归单测：`stops the quick chord at the oldest frame instead of wrapping (A-21)`、`still wraps the roaming walk, which is where A-17 keeps holding`（**这一对必须一起读**：它同时钉住"chord 不再循环"与"漫游仍然循环"，任何把两个功能又合并回去的改动都会让其中一条转红）、`resets the chord to the draft once the user sends a new message`、`leaves the roaming walk parked where it was when a new message arrives`、`starts the chord at the draft on a fresh mount, which is what a refresh gives`；`history-keys` 侧 `stops at the oldest frame instead of wrapping when wrapping is refused`、`still moves normally when wrapping is refused and no end is reached`。**反向验证**：把重置分支改成恒假后，`resets the chord…` 以 `expected [ 'first question' ] to deeply equal [ 'third question' ]` 转红，真实症状逐字复现。
  **同时被本条推翻的旧用例**（口径变了，用例跟着改，不是产品坏了）：`wraps the quick chord as well as the roaming walk` → 反写为 `stops the quick chord at the oldest frame instead of wrapping (A-21)`；`does not re-write on every extra quick-chord press at the oldest frame` 原先**借循环的副作用**断言"不重复写入"，现在直接断言"多按不动、一个字都不写"。
- [x] A-22 **删掉设置里"也可直接用 Ctrl+↑/↓"这类暗示两个快捷键等价的文案**（用户原话："设置里 "也可直接用Ctrl+1/1。" 的文字去掉，因为不符合最新两个功能都是独立的快捷键的原则"）。**实现完成（2026-04-10）**：`settings.historyJumpDesc` 的中英两版都删去该分句（保留"走到尽头会循环到另一端"，因为那是**漫游**的行为，仍然成立）。
- [x] A-23 **两条功能的设置必须分组，不能混在一起**（用户原话："设置里 两个功能的设置应该分开，如果两个功能都有设置的话；不要混在一起，用户容易弄混淆"）。**实现完成（2026-04-10）**：历史相关的行按**归属**拆成三组，各有标题 + 一行说明——「两个功能共用」（总开关、历史粒度、复用方式）、「Esc 漫游」（智能跟随）、「Ctrl + ↑ / ↓ 快速复用」。共用的那组**显式写明它同时作用于两者**，这正是原来混淆的来源：一条共用设置混在某个功能块里，用户会读成只对该功能生效。新增样式 `.dsh_atFile_groupTitle` / `.dsh_atFile_groupDesc`；新增文案 `settings.historyGroup.{shared,sharedDesc,roam,roamDesc,quick,quickDesc}`（中英各一套）。
- [x] A-24 **智能跟随打开后容易卡死**（用户原话："智能跟随打开后 ，容易卡死 ，请查日志或补充有效日志"）。**根因是性能而非逻辑**，已定位并修复（提交 `7d34cd6`）：`scroll` 每帧会触发很多次，而处理函数**在每次事件里**都跑 `querySelectorAll('[data-chat-anchor-key]')` 并对每一行调 `getBoundingClientRect()`；每次 `getBoundingClientRect()` 都**强制一次同步布局**，于是"一次滚动事件 = 每个已渲染行一次布局"，会话越长行越多、越拖越卡 —— 正是用户说的"卡死"。修法是 **rAF 合并**（无论多少事件，每个动画帧至多测量一次）+ 用 `scrollerRef` 记住滚动容器。回归单测 **数的是昂贵操作的次数**（`measures the reading position once per frame, not once per scroll event`：25 次滚动事件应当只产生 2 次布局读取，而非 50 次）——**"功能还能用"这类断言抓不到性能回归，必须计数**。
  **本条的第二半（补日志）也已完成（2026-04-10）**：`measure()` 在单帧要测的行数超过 `SLOW_ROW_THRESHOLD`（500）时 `console.warn` **一次**，点明"每帧每行一次布局读取就是已知的卡死（A-24）"。阈值定得远高于任何真实会话的行数，所以**健康路径永远安静**，日志只在真正出问题时才有意义——回归单测 `stays quiet for a normal transcript, so the warning keeps its meaning` 钉住的正是这一半。**反向验证**：去掉阈值与一次性守卫（改成每次测量都警告）后，两条用例分别以 `expected 2 to be 1` 与 `expected [ Array(1) ] to deeply equal []` 转红。

- [x] A-25 **提示栏必须描述"刚刚动作的那个游标"，而不是漫游游标**（A-21 落地后由浏览器用例暴露，属 A-21 的必然连带面，故一并记录）。**现象**：先按 `Esc` 进入漫游、再按 `Ctrl+↑` 复用文本时，漫游游标**一步都没动**（A-19 给了 chord 自己的游标），而提示栏此前**无条件**跟随漫游槽位，于是出现"输入框里已经是 `HISTORY-1`，提示栏却写 `History 0 / 24 Current draft`"——**不是"少了一句提示"，而是与用户眼前的草稿自相矛盾**。**修法**：提示栏跟随**最后动作过的游标**，用状态 `quickIsCurrent` 记录（`case 'enter'` 置 `false`，`moveCursor` 那一处按 `intent.quick` 置位），因此 `chordIsCursor` 是**状态**而非 `phase !== 'roaming'` 的推导——**这一条是关键**：按 phase 推导在浏览器用例里直接失败，因为"漫游开着"与"漫游游标动过"是两件事；提示栏的总数也随之取该游标自己的列表（`readoutCount`）。
  **同时补齐 A-16 在 A-21 下的反馈通路**：chord 在自身最旧一帧处被**夹取**时置 `edgeReached`，提示栏因此可以**不进入漫游 phase** 就显示这一句（`roaming: phase === 'roaming' || edgeReached`）——**不去改 phase 是刻意的**，实测那样会把漫游状态泄漏进三条无关用例。回归单测两条：`describes the frame the CHORD wrote, not the roaming slot it never moved (A-21)` 与 `follows the chord even while the roaming walk is open (A-21)`（后者复刻浏览器用例的真实形状：先 `Esc` 再走 chord）。
  **浏览器用例的口径也随之订正**：`A-16: the chord is never a silent no-op` 原先断言"边缘那一下会让草稿或提示**发生变化**"，而 A-21 取消循环后**没有第二个状态可去**，该断言等于要求旧行为复活；改成断言**边缘上提示栏确实在描述 chord 所在的那一帧**（`Oldest loaded message` + 该帧文字），并保留防卡死的下半段（从边缘按 ↓ 必须还能移动）。13 条浏览器用例全绿。
- [x] A-26 **漫游到"未加载帧"时页面必须跟着变化；仍然滚不动时必须说明原因**（用户原话："ESC模式下 当前位置移动到 下一条 系统消息时，为何页面没有跟着变化，没有就像 移动到下一条 用户消息会页面跟着变化一样？请核对"）。**根因不是"系统消息"这个类型，而是"这一帧只在 outline 里"**：这类帧的 key 是合成的 `turn:N`（`history-frames.ts`），没有任何消息行带这个 key，于是 `querySelector` 查不到元素，滚动**无声地什么都没做**——用户看到的是"游标动了、页面没动"。**为什么偏偏报系统消息**：投影只在人类消息上记 `prompt`（与 A-20 同一处根因），系统回合因此 `prompt` 为空，它既是 outline 里最可能只剩投影的帧，也是唯一"预览为空、什么都看不到"的帧，两个症状同源。**修法（用户选"都做"，并追加两条限定）**：(1) **把这一帧翻页进来，再滚动到它真正的行**——等页面落地后才滚动，因为那时才有行可滚；请求按**回合号**记账而非节点 key（翻页会插入帧，同一回合的已加载帧用节点 id，两种写法永远对不上，理由同 A-13）。(2) **仍然滚不动时要说出来**，但**提示范围要窄**：已加载帧找不到行是**正常**的（虚拟列表、行还没画出来），每次都提示就成了噪音；可上报的只有两种——**因为没行才被翻页、翻完仍然没行**，以及**此构建压根没有翻页能力**。提示**只在提示栏出现**（用户选定），不做行闪烁。**实现要点**：`scrollFrameIntoView` 改为返回**是否找到行**（否则"降级"与"坏掉"长得一模一样）；`RoamView` 新增 `offscreen`，**与 `edge` 分开**——`edge` 说"历史到头了"，`offscreen` 说"这一条在、但此构建没有锚点可滚"，把后者报成前者等于在历史没到头时说到头了；store 的按值比较**补上漏掉的 `tag`**（两条帧可计数与预览都相同而只有来源不同，系统回合预览为空，于是从一条走到另一条时提示栏会留着上一条的来源标记）。
  **顺带修掉一个截断缺陷（新用例暴露，非用户报障）**：chord 直接沿游标复用、不走漫游那一步的翻页（这正是 A-26 之后它成为**唯一**能落到 outline 帧上的手势的原因），而它对未加载帧**无条件**调用 `reuse`，把投影的**有界预览**写进了输入框。A-13 的守卫现在同样覆盖 chord。**这条说明**：A-26 的翻页把 A-13 的延后路径从常规路径上挤走了（常规漫游步骤已不再经过它），原来被它遮住的那条分支才浮出来——**覆盖率会因此变红，而变红的是"路径消失"，不是"代码变差"**，必须补一条能真正走到的用例，不能删断言。回归单测四条：`pages an unloaded frame in, then scrolls to the row the page reveals (A-26)`、`says so when the paged-in frame still has no row to show (A-26)`、`defers the chord onto an outline frame, then writes the loaded text (A-13 + A-26)`、`says so when the chord cannot page an outline frame in (A-13 + A-16)`。

- [x] A-27 **文件夹的两次点击：第一次在右侧栏打开它所在的位置并选中该行，第二次交给操作系统的文件管理器**（用户原话："@Eason/ 第一次点击 右侧侧边栏没有打开 这个文件夹 且选中（是否可实现？），再次点击后 没有打开 资源管理器"，并指出"omarchy侧也是一样的问题"）。**旧的两个手势没有一个是用户要的**：第一次点会走产品的 files 分页——那一页**不接受任何参数**，既不知道要展开哪个文件夹，也无从选中某一行，工作区外的文件夹更是连那一页都没有；第二次点只是**又开了一次本插件自己的文件夹页**，而用户要的是桌面那边的窗口。**修法**：(1) 第一次点 = 打开该文件夹的**所属目录**并**选中**被点的那一行（`openOwningFolder` → 本插件自己的 `folder` 页 `dsh-resource://folder/<path>`，`params: { select }`），于是用户落在文件夹**里面**而不是工作区顶部；所属目录由 `resolveOwningDir(path, dir)` 决定——绝对路径直接用，能在 workspace 索引里查到的取该条目的路径，没有目录部分的顶层名字取它自己的父目录，查不到的退回 `workspaceRootFromIndex()`；**`owningFolderOf` 的 `''` 是"没有自己的目录部分"，不等于工作区**（Host 的 `list('')` 从它自己的浏览根开始），直接拿来用会把用户丢到文件系统顶部。(2) 第二次点 = `openNativeFolder` → `openPath(absolute)`，**普通打开而不是 `reveal`**：`reveal` 的语义是"在父目录里选中我"，对文件夹会把用户留在外面，而用户要的是进到文件夹里。(3) "这是第几次"由**点击台账**判定（`lastClick`/`ledgerKeyOf`/`repeatClick`/`noteClick`，写入是**翻转**——同一个链接记过的再记一次即清空，所以隔一轮再点又从"第一次"开始），**不看点击时间、也不看 `detail`**：这不是双击手势，m02489 的裁定就是"不依赖快速双击"。(4) 右侧栏是**可选**服务：`resolveSidebarRight(ctx)` 为 `undefined` 时第一次点直接落到 `openNativeFolder`（`openOwningFolder` 里的 `sidebar === undefined` 分支），挂不挂侧栏都工作；会话没有 `cwd` 时**不编造路径**，`console.warn('[dsh-atlas] this folder has no absolute path to open: …')` 并返回 `'gone'`。**口径变更（要记住的张力）**：此前 m02489 把文件夹的打开方式固定成"只走右侧栏"、由设置项 `folderOpen` 决定（该设置卡已不在 `src/client/SettingsSection.tsx` 里，字段只留着保住旧安装的存储形状），本轮的两次点击手势**取代**了那一条——用户的新要求更晚也更具体，以新要求为准。**同一份台账也接在草稿 token 上**（实机核对时发现的缺口）：`src/client/DraftLinks.tsx` 注入 `repeatClick`/`noteClick`，`src/client/index.ts` 的草稿桥接把 `actionFor` 的**二参形式**、台账判重与写入一并传下去——此前草稿 token 的第二次点击**什么都不做**，因为桥接只用了一参 `actionFor`、从不读写台账；接上之后，输入框里同一个 token 的两次点击与 dock 行、transcript chip 行为一致（guest 真机按键级验证见 §A.19.7）。回归单测六条：`opens a directory row in the sidebar, selected, and NOT locally (A-16.7 + m05904)`、`opens a directory row in this plugin folder tab even with no files tab`、`hands a FOLDER to the desktop file manager on the second click (m05904)`、`still opens a folder in a profile that mounts NO Sidebar at all`、`refuses to invent an absolute path for a folder it cannot resolve`、`answers the second click on the same token the way the dock row does`（`tests/draft-links.spec.tsx:545`）。
- [x] A-28 **工作区内的绝对路径必须被认出来，不能因为"它是绝对路径"就被外部权限闸门拒掉**（用户原话："omarchy侧 的 @/mnt/EShare/Eason/Rust/DSH/ 为何没找到，明明如图1 有的…是否是linux侧前缀处理有问题导致有效的路径无法被识别？该dsh文件夹路径是 /mnt/EShare/Eason/Rust/DSH"，Windows 侧同样有 `@Eason/Rust/DSH/` 认不出的现象）。**根因不是 Linux 前缀，而是"绝对"被当成了"工作区之外"**：`inspectOne`（dock 画引用）与 `resolveMention`（真正把内容喂给模型）只要看到绝对路径就先过 `allowsExternal`，于是权限窄的会话里，不在外部台账上的绝对路径**直接被判失效**——哪怕这个绝对路径正好就是工作区自己；同一个文件夹用相对拼写能打开、用绝对拼写打不开，用户看到的就是"路径明明存在却认不出来"。**修法**：绝对**且落在工作区内**的路径走工作区分支——`const inside = external && isUnder(cwd, absolute)`，外部闸门只在 `external && !inside` 时生效（`isUnder` 与 `src/runtime.ts`/`src/reference.ts` 的列目录绕行是同一套判定）。于是 `/mnt/share/proj`（cwd `/mnt/share`）、`E:/proj/src`（cwd `E:/proj`）这类绝对拼写与 `proj`、`src` **收敛成同一条引用**：`outside` 只在真正越界时置位，绝对拼写也不再往外部台账里写根（外部台账的根会变成文件夹选择器的常用项，写进去等于污染）。**用户猜的"Linux 前缀处理"经核对不成立**：绝对路径的前缀处理一直是原样透传，错的是闸门的适用条件；这一条对 Linux 与 Windows 同样成立，也在 Windows 侧复现。回归单测两条：`accepts an absolute path only with access, marks it external, and reports it for the ledger`（越界行为不变：无权限仍拒绝、有权限仍打 `<external-reference>` 并记台账）与 `accepts an absolute token inside the workspace and refuses those that escape it`（工作区内的绝对拼写产出 `<workspace-reference>`、不进外部台账；`@../secret.ts`、`@src/../../secret.ts` 即使在完全权限下也仍被拒）。
- [x] A-29 **列表里永远只有一个"当前项"，且翻页后上一页的最后一项就是下一页的第一项**（用户原话："omarchy；如图2，怎么有两个当前项（阴影条目）…需求要优化为，向下翻页后，上一页的最后一项要出现在下一页的第一项（让用户理解两页的连续性），且下一页这个新页面的当前项位于第二项"）。**两个症状、两个根因**：(1) 两个当前项——行自带 `:hover` 底色，指针停着不动时那一行一直亮着，翻页后它与键盘游标各行其是，看起来有两个当前项；(2) 翻页的滚动量是"刚好让新游标可见"的最小值，于是上一页的最后一行与新的游标**同时**可见，用户读不出"下一页从这里开始"。**修法**：(1) 删掉 `.dsh_atlas_pickerRow:hover`——**指针反馈就是同一个高亮**（`onPointerEnter` 把游标移到指针所在的那一行），世界上只剩一个当前项；(2) 翻页比整页**少滚一行**：`row.top < box.top` 时 `container.scrollTop += row.bottom - box.bottom + row.height`，`row.bottom > box.bottom` 时 `container.scrollTop += row.top - box.top - row.height`，于是新游标落在页面**第二行**，上一页的最后一行（上行时是上一页的第一行）留在前缘，两页可见相接。**不用 `scrollIntoView`**：它会滚动所有可滚祖先，把整个 shell 连同指针一起滑走。`moveBy` 两端夹取、**不循环**（漫游循环是 A-17 的裁定，选择器不适用）；指针重定向靠 `hoverRow` 按精确坐标 `(x,y)` 去重，忽略滚动导致的 `mouseover`。回归单测两条（`tests/folder-picker.spec.tsx`）：`keeps the row that was last on the page as the first row of the next`（第 5 步后可见行恰为 `['E:/','Folder1','Folder2','Folder3','Folder4']`、`scrollTop()` = 80）、`mirrors that rule walking up, with the row it left ending the page above`。
- [x] A-30 **已展开的行，Enter 必须是折叠**（用户原话："如图4 里展开的当前项（Rust）回车后，没有折叠呢？"）。**根因**：每行的动作只由 `hasChildren` 决定，而 Host 对**没有探测过**的文件夹会答 `undefined`，那种行的动作是 `probe`（"进去时再定"）——于是对一个已经展开的文件夹按 Enter 只会**再问一遍**，答案仍是未知时表现为"按了没反应"，即便 Host 答了也仍然是 `expand`，还是展开。**修法**：**展开中的行永远携带折叠动词**——`action: isOpen ? { kind: 'expand', path: entry.path } : entry.hasChildren === false ? { kind: 'choose', … } : entry.hasChildren === true ? { kind: 'expand', … } : { kind: 'probe', … }`，`activate` 随之 `collapse`；闭合行不变（已知为空 ⇒ 叶子、Enter 收下；其余 ⇒ 展开；未知 ⇒ 进去时再定）。提示栏文案同步（`↑↓ 移动 · Enter 展开/折叠/选中 · Ctrl+Enter 落盘 · Tab 切换 · Esc 返回/关闭`，中英各一条）。回归单测：`collapses a folder it had to look at first, on the second Enter (m05904)`——它就是"先探一下、再展开、再折叠"的真实顺序。
- [x] A-31 **scoped 插件名必须被当成一个完整的提及**（用户原话："@plugin:@sidequest-007/dsh-atlas 为何也识别不了，omarchy和windows都是如此"）。**根因在共用规则里的"提及"定义**：提及是 `@` 加一串"非空白、非 `@`"的字符，而插件用 **npm 模块名**命名，scoped 名字**自带一个 `@`**（`@sidequest-007/dsh-atlas`）——内层那个 `@` 被当成第二个提及的开头，token 于是被劈成两半：`plugin:` 半截谁都认不出来（dock 列不出行、宿主也注入不了插件说明），`sidequest-007/dsh-atlas` 那半截被当成一条 workspace 路径，画出一个**根本不存在的文件**。**修法（一处判定、所有扫描方共用）**：`src/tokens.ts` 把 scoped 形式写进 token 语法本身——`MODULE_NAME_TOKEN = String.raw\`(?:@[^\s@/]+\/)?[^\s@]+\``、`PLUGIN_TOKEN = String.raw\`plugin:${MODULE_NAME_TOKEN}\``、`MENTION_TOKEN = String.raw\`(?:${PLUGIN_TOKEN}|[^\s@]+)\``，**plugin 形式排在前面**，所以它先吞掉整个 scope；`src/mention.ts`、`src/client/FilesDock.tsx`、`src/client/ReferenceLinks.tsx`、`src/references.ts` 里的私有正则全部删除，改从 `src/tokens.ts` 取。宿主侧 `expandPluginMentions` 的 `isEnabled` 收到的就是**完整的 scoped 模块名**（`pluginInventory` 的 `moduleName` 本来就是这个形状），不再只认 `dsh-atlas`。**一个刻意的边界**：`@plugin:` 类别标签本身仍是 inert 的（`src/client/reference-links.ts` 的 `INERT_HANDLES` 现提成共用函数 `isInertHandle`）——插件名是一个标签、不是资源，**永远不该被画成文件**；ReferenceLinks 读原始 token 时同样跳过它，所以这一次修的是"识别"，不是把插件的 scope 变成可点链接。**实现期踩到的坑（留档）**：`String.raw` 漏掉过一次，`\s` 在普通模板串里退化成 `s`，字符类变成"非 s 非 @"，`@src/index.ts` 被跳过、`@docs/` 被截成 `@doc`，**29 条既有用例同时转红**——`src/tokens.ts` 里每个片段都必须 `String.raw`，这正是这份文件存在的理由（它是唯一的判定实现，宿主与客户端各自打包却共用同一份）。回归单测五条：`reads a scoped plugin name as ONE token instead of splitting off its scope (m05904)`、`reads a scoped plugin name as one row and invents no path for its scope (m05904)`、`keeps a scoped module name whole, scope and all (m05904)`、`asks for the scoped module name itself, never for the bare scope (m05904)`、`never reads the scope of a plugin mention as a file path (m05904)`。
- [x] A-32 **第二次点击交给桌面的绝对路径必须由宿主解析，不能依赖客户端的会话摘要**（用户复报 `m02155`：「@lib/types/client/ 第二次点击 没能打开 资源管理器 且打开 client 文件夹；Omarchy 侧也是，但我发现 omarchy 侧可以在第二次点击的时候调用和侧边栏『在系统中打开』一样的功能来将 client 打开」）。**定位**：第一次点击走的是**宿主解析**（`dsh-resource://folder/lib/types`，宿主按会话 cwd 解析），它对了只证明**宿主**知道工作区在哪；第二次点击的绝对化此前**完全在客户端**（`absoluteReferenceOf` → `sessionWorkspaceRoot` → `sessions.list.getSnapshot().byId[id]?.cwd`），而那份摘要**可以不携带目录**，失败时只有 `console.warn('[dsh-atlas] this folder has no absolute path to open: …')` + `'gone'`，UI 上没有任何可见后果——用户看到的就是"点了没反应，也没开资源管理器"。用户在 omarchy 上看到**能**工作的那个按钮是本插件文件夹页自己的「在系统中打开」(`folder.system`)，它的实参是 `listing?.path`，即**宿主 `atFile/list` 回传的规范绝对拼写**——来源不同，正是两者一通一不通的分界。**判据**：`DirectoryListing.path` 是"所列目录的规范拼写（正斜杠）"，且宿主对**缺失/越界**的目录**也照回** `path: canonical`（`src/runtime.ts` 的 list 分支：`const cwd = agent.session.header.cwd` → `const absolute = isAbsoluteReference(path) ? path : resolve(cwd, path)` → `const canonical = externalPath(absolute)`），所以**一次 `atFile/list` 就是在宿主侧把引用解析成绝对路径的完整答案**。**改法**：新增 `hostResolvedFolder(sessionId, path)`（`src/client/index.ts:1107`），先问宿主 `listDirectory`（即 `atFile/list`，与文件夹页同一个调用）取 `listing.path`；宿主答不了（老宿主没有 list 端点、at-file 被设置关掉、或线上失败）时**回退**到原来的 `absoluteReferenceOf`。`openNativeFolder` 因此变成 `async`，把宿主给的规范路径交给**同一个** `openPath`（文件夹页那个按钮也是它）。**口径变更**：A-27 第五条"会话没有 cwd 时不许编造路径，只允许 warn + `'gone'`"仍然成立——现在依然**不编造**，只是不再把"客户端不知道工作区根"等同于"这个文件夹打不开"：根由宿主给出，真正的 `'gone'` 只剩"宿主与摘要都说不出路径"这一种。**回归单测**：`resolves a folder through the Host listing, so a summary with no cwd cannot kill the second click (m02155)`（boot 里**完全不给 `sessionList`**，只给 `atFileList`：第一次点击仍走本侧算出的 `dsh-resource://folder/lib/types` 且**不列目录**，第二次点击必须 `atFile.list('s1','lib/types/client','')` 并以 `{ path: '/ws/lib/types/client' }` 调 `openPath`）；既有的 `hands a FOLDER to the desktop file manager on the second click (m05904)` 夹具没有 `atFile.list`，因此它现在钉的是**回退**那一支，注释已写明。**变异证据**：把 `hostResolvedFolder` 改回只读 `absoluteReferenceOf`（不列目录）⇒ 上述新用例转红，报 `expected "vi.fn()" to be called with arguments: [ 's1', 'lib/types/client', '', …(1) ] / Number of calls: 0`（实测）。详见 §A.20.6。



两项均为**实现期自查**（非用户报障），各自带回归单测：

1. **旧帧连按会重复写回**。落在当前格上的步进曾穿到 quick chord 分支，而该分支通过 `reuse` 写草稿；于是在最旧一帧继续按 `Ctrl/Cmd+↑`，每多按一次就把同一条消息**再写一遍**——`append` 模式下文字被反复追加（复现：到达最旧帧后又多写 3 次）。修法：`next === state.slot` 时吞掉按键（对顶部 `Ctrl+↑` 而言与"走到头"语义一致，同时挡掉浏览器自身的默认动作）。回归单测：`does not re-write on every extra quick-chord press at the oldest frame`。
2. **注入面不得作为 effect 依赖**。`reuse` 曾闭包捕获 `inputActions`，而 shell **每次渲染都重新注入**，于是按键监听的 effect 反复重跑。按既有铁律改为 ref（`inputActionsRef`），监听只依赖 `enabled`。回归单测：`keeps one step per press when the shell re-injects its faces`。

另有一处**测试自身**的卫生问题：`scopes the scroll to the frame row the build exposes` 把它的 `u2` 锚点行留在了共享的 jsdom 文档里，导致后续用例滚动时命中残留行、被误读为"一次按键滚动两次"。两个会建行的用例现在都在结束时移除该行。

#### A.2 对照清单逐条核对源码时查出并修掉的缺陷

A.1 修的是"实现跑起来才暴露"的问题；这一轮换成**把 B/C 清单逐条对照源码**，于是查出两处"声明了却没做"——它们的共同特征是**看起来已完成**：接口里有字段、清单里有条目，但没有任何调用点，也没有任何测试会失败。

3. **B-03 的 `generating` 是一个死字段**。`HistoryEnvironment` 声明了它、`FrameCursor` 从未传入、`resolveIntent` 从未读取，三处都缺，于是"生成中按 `Esc` 不进入选择态"这条**完全不存在**——而它在清单里挂着、接口里也有名字。这一条尤其值得记：**一个从未被读取的可选字段，比缺少这个字段更难发现**。修法：从**既有**的 Chat 快照字段 `partial`（流式助手步骤，非 null 即在生成）接线，不新增任何服务或 wire 调用；沿用 ref 实时读取（理由同 A.1 第 2 条）。刻意**不**给面板快捷键与 quick chord 加这个闸门——等待回答时翻历史正是用户要做的事。回归单测：`does not enter while a turn is generating, but keeps the palette chord`、`leaves Escape alone while a turn is generating`。
4. **B-06 的会话切换没有重置**。这一条此前被我在总结里写成了"未验证"，实测发现它**本来就是坏的**：composer 链路（`ConversationContent` → `composerSeat` → `InputBar` → `overlayAnchor`）**没有任何按会话的 `key`**，React 因此跨会话**复用同一个 overlay 实例**，`slot`/`phase` 会被带进下一个会话——而第 N 格在那边是**另一条消息**，残留高亮就指向了错误的对象。本 slot 唯一可得的会话信号是标准属性 `useChat`（按会话变化），故 hook 标识一变即重置；重置放在 **render 期间**而非 passive effect：按键监听读的是 `stateRef`，用 effect 会留下一帧"按键仍作用于上一会话"的窗口。回归单测：`drops the walk when the session under it changes`，**已验证把修复改回 `if (false)` 即失败**。

顺带修正一处**测试假象**：spec 的 `chatStub` 原先每次 `props()` 调用都新建一个 `useChat` 函数，而真实的 hook 是**按会话**稳定的——这在新代码下会被读成"每次渲染都切了会话"。现改为按 table 对象缓存（同一会话 → 同一函数），另提供 `sessionStub` 供"同一会话内节点集合变化"的用例（收缩、帧消失、长度不变）使用：它的标识固定、只换 table。这不是为了迁就实现，而是**让测试不再说谎**——旧写法本身就与真实运行时契约不符。

同样地，C-02 是**计划而非结果**：落地时发现 `SessionStandardProps` 本就是空的、由各 UI 适配器自行 merge，因此从消费方 `declare module` 补声明即可，无需把 `@deepseek-ai/dsh-client-ui-chat` 加进依赖。已在 C 段标注为"改为不引入该依赖"。

#### A.3 真实浏览器验收通道：装载契约与踩到的坑

为了在**不碰用户 3080 进程**的前提下拿到真机证据，在 harness 里建了一条 web e2e 通道（`apps/web/tests/history-jump.e2e.ts`）：用 `launchWebScaffold` 起一个独立 scaffold，`extraInstallAnchors` 指向本仓库的 `package.json`，再从 `snapshots/acp/cancel-tool-calls/session.v3.jsonl` 播一个 5 轮用户消息的会话，最后用 Brave 驱动真实 composer。`scaffold.authenticatedUrl` 是 scaffold **进程内**签发的 token URL，因此既不用碰用户的 launch token，也没有绕过任何鉴权。

这一轮把通道从"跑不起来"推到"能启动、能播种、能导航、能选中会话"，过程中确认了三条**装载契约**——它们都不是本插件的缺陷，但都会伪装成"功能没生效"：

1. **`extraInstallAnchors` 只负责"可被 import"，不负责"被装载"**。它做的事是 `mkdir node_modules/<name>` + `symlink(packageDir, …, 'junction')`（`scaffold.ts:674-690`），即复刻 `dsh plugin add` 留下的软链。但 Loader 是**按名字**实例化插件的，没人"点名"就不会有 entry。因此必须**同时**提供 `extraOverlayPath`，其内容就是那行 `insert: [{ name: '@sidequest-007/dsh-atlas' }]`。
   *我此前判断该 overlay "冗余"并删掉了它，是错的*——当时的观察（host 半边有反应）不足以证明 client 半边也装载了。
2. **`dsh.client.inject` 必须能在 scaffold 的 entry 表里全部解析**。本插件的六个依赖（`dsh-api-remotes`、`dsh-api-session-controller`、`dsh-client-connection`、`dsh-client-locale`、`dsh-client-ui-input-trigger`、`dsh-client-ui-sidebar-right`）在 scaffold 的表里**都在**，所以它不是本轮的原因；但它是一条必须先排除的闸门。
3. **client bundle 只有"批量 URL"这一条可取路径**。`/plugins/<id>/client.js` 单包形式**返回 404**（实测），可用的形式是启动图里的 `batches[].url`，形如 `/plugins/??<id>/client.js,<id>/client.js&rev=…`（实测 200，且列表内含 `@sidequest-007/dsh-atlas/client.js`）。用单包 URL 去探测会得到**假阴性**。

确认已成立的事实（供下一轮直接接着走）：`__DSH_BOOT__.entries` **含** `@sidequest-007/dsh-atlas`；应用批次的批量 URL 返回 **200**；页面**零 console 错误、零 pageerror**；composer 存在（1 个 `[data-composer-input][contenteditable="true"]`）且**能拿到焦点**；`[data-chat-anchor-key]` 有 9 行；`Escape`/`ArrowUp` **确实到达 document**（capture 探针实测，target 为那个 contenteditable，且 `defaultPrevented=false`）。

**因此结论是**：bundle 已送达、entry 已入图、按键已到达，但**本插件的 `apply()` 没有产生任何注册**——DOM 里**一个 `data-atlas*` 属性都没有**（连不依赖历史数据的 dock 也没有），且**没有任何报错**。下一轮应从"这个 entry 在浏览器侧究竟有没有被激活"入手（读 client-modules 的 `loadCache`/激活日志），而**不是**继续调断言——A-01/A-02/A-03/A-04/A-06/B-09 的失败是同一个根因的六个表现，不是六个问题。

### B. 冲突与边界

- [x] B-01 `@` 菜单打开时按 `Esc` → 只关菜单，不进入选择态。（`resolveIntent` 在 `idle` 阶段以 `menuOpen` 拦下；选态中改为只认 `Escape` 退出。）
- [x] B-02 任意模态打开时按 `Esc` → 模态关闭，不进入选择态。（`modalOpen` 是 `resolveIntent` 最早的闸门之一。）
- [x] B-03 turn 生成中按 `Esc` → 不进入选择态。（**本轮补齐**：原先 `HistoryEnvironment.generating` 只声明、**从未被传入或读取**，属"看着像做了、实际没做"。现从 **`useSession(s => s.running)`** 经 ref 实时读取并接线——注意**不是** Chat 快照的 `partial`，后者在中途取消的步骤上会一直保持非 null，见 §A.5。面板快捷键与 quick chord 刻意**不**受此闸门限制——等待回答时翻历史正是用户要做的事。单测：`does not enter while a turn is generating, but keeps the palette chord`、`leaves Escape alone while a turn is generating`。）
- [x] B-04 选择态下按可打印字符 → 选择态解除，该字符出现在输入框。（`default` 分支返回 `{ kind: 'leave', consume: false }`，不 `preventDefault`。）
- [x] B-05 选择态下按 `Enter`（在助手格上）→ 只退出，草稿不变、不发送。（`reuse` 分支在 `frameAtSlot` 取不到帧时只 `setPhase('idle')`。）
- [x] B-06 切换会话 → 选择态与面板立即消失，光标归零。（**本轮补齐**：composer 链路**没有**按会话加 `key`，React 会复用同一个 overlay 实例，`slot`/`phase` 于是会带进下一个会话——那里第 N 格是**另一条消息**，残留高亮就指错了对象。本 slot 唯一拿得到的会话信号就是标准属性 `useChat`（按会话变化），故 hook 标识一变即重置；重置放在 **render 期间**而非 passive effect，因为按键监听读的是 `stateRef`，用 effect 会留下一帧"按键仍作用于上一会话"的窗口。单测：`drops the walk when the session under it changes`，已验证去掉修复即失败。）
- [x] B-07 选择态下流式输出继续 → 高亮不丢、不被强行拽到底部。（高亮是 `slot` 派生的，与帧数变化解耦；`frames.length` 唯一的副作用是**收缩时夹取**，不会在增长时移动光标——`leaves the cursor alone when the history does not shrink` 钉住"长度不变则不动"。滚动只在步进时主动发起，不做自动跟随。）
- [x] B-08 中文输入法组合中按 `Esc`/`↑`/`↓` → 不被拦截。（`facts.isComposing` 在闸门最前，早于任何手势判定。）
- [x] B-09 设置关闭 `historyJump` 后，所有快捷键回到宿主原义（`Esc` 空白、`Ctrl+Shift+H` 无反应）。（代码侧 `!env.enabled` 即返回 `undefined`、不消费按键；`Shift`/`Alt` 也会让两个 chord 判定失败。**浏览器实测已通过**：经 `settings.update('at-file', { historyJump: false })` 写入持久设置 → 刷新 → 重开会话 → 按 `Esc`+`↑`，`data-atlas-roaming` 保持 `null`。）
- [x] B-10 未加载历史里的某条消息，通过 F2 上翻找到并取回，文本正确。（**行为一侧已完整**：越过最旧**已加载**帧时调用 `loadThrough(oldest.seq)`，且**本轮进一步改成"翻到就继续走"**——用户要求"到达尽头可以再向上跳转，同时更新消息总数及当前消息序号"，于是翻页成功后按新增帧数平移游标继续前进，只有**翻不出新帧**时才判定为真尽头并显示"更早的历史尚未加载"。见 §A.7.4。**端到端已实测**（本轮补齐）：验收通道新增 `history-walk-long` fixture（40 轮 / 80 条计数消息，`snapshots/web/history-walk-long/session.v3.jsonl`），首屏按 `PAGE_MESSAGES = 50` 只装最新 **24** 轮（turn 17..40），**第 25 按**是第一个越窗按键、落回 turn 16——B-10 逐按走完 40 轮并与 fixture 原文逐字比对（`expect(seen).toEqual(expected)`，40/40），第 41 按才报"更早的历史尚未加载"。单测覆盖了"翻不出新帧 → 报尽头"、"翻页被拒 → 报尽头"、"无 loader → 直接降级"三条分支。）

### C. 工程

- [x] C-01 `pnpm run check` 绿（typecheck + test + build + verify:publish），覆盖率 100%。（实测：**40 files / 974 passed + 1 skipped**（第二十一轮读数，见 §A.20），`[verify-publish-surface] ok`；`FrameCursor.tsx`、`roam-store.ts`、`styles.ts`、`HistoryPalette.tsx`、`history-frames.ts`、`history-keys.ts` 各项指标均 100%。）
- [x] C-02 ~~`package.json` 增加 `@deepseek-ai/dsh-client-ui-chat` 的 optional peer + devDependency~~ —— **改为不引入该依赖**。落地时发现 `SessionStandardProps` 本就是**空的**、由各 UI 适配器自行 merge（ui-chat 已在运行时把 `useChat` 合进 props），因此本插件用 `declare module '@deepseek-ai/dsh-client-ui-slots'` 从**消费方**补声明即可通过类型检查，无需依赖该包、也无需 `link:`。见 `src/client/history-keys.ts` 的说明。这样 `package.json` 的依赖面不变，外部安装不需要多装一个包。
- [x] C-03 客户端 bundle 仍然**单文件**，样式走 `styles.ts` 字符串。（`lib/client.js` 单文件，无 CSS 产物；`verify:publish` 亦校验通过。）
- [x] C-04 文案进 `src/client/locales.ts` 的 `atlas` 命名空间，zh/en 键集一致。（`history.*` 12 个键 + `nav` 共 13 个，zh/en 两侧实测同集、无差集。）

---

## 9. 落地影响面（预估）

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `src/client/HistoryFrames.ts` | 帧索引构建（`useChat` → `HistoryFrame[]`），纯函数便于单测 |
| 新增 | `src/client/FrameCursor.tsx` | F2 选择态：外层高亮 + 逐格高亮 + 滚动落位 |
| 新增 | `src/client/HistoryPalette.tsx` | F1 面板 UI + 过滤 + 取回 |
| 新增 | `src/client/history-keys.ts` | 按键判定（组合键、IME、菜单/模态让位） |
| 改 | `src/client/index.ts` | 注册两个 overlay 条目 + 注入 `useChat` 派生 face + 设置写动词 |
| 改 | `src/client/styles.ts` | 外层/内层高亮、面板样式（保持单文件） |
| 改 | `src/client/locales.ts` | 新文案 |
| 改 | `src/contract.ts` / `src/settings.ts` / `src/index.ts` / `src/client/SettingsSection.tsx` | 三个设置字段（六处规则）；**第八轮新增第四个** `historyJumpSmartFollow`（A-19 第 3 条），仍走六处 |
| 改 | `src/client/FrameCursor.tsx` / `src/client/history-keys.ts` | **第八轮**：撤掉"选择态修饰键降级"（A-18）、两套帧集合与游标分离（A-19 第 1/2 条）、智能跟随接线（A-19 第 3 条） |
| 改 | `package.json` | optional peer + devDependency：ui-chat |
| 改 | `AGENTS.md` | 把本需求的 DOM 契约与 `useChat` 事实写进"Contracts with the harness" |

**不需要改的**：Host 半边任何文件、任何 wire 端点、`cordis.patch.yml`、`build.mjs`。

> **第八轮给这条"不需要改的"划出一道口子**：`historyJumpSmartFollow` 需要一个新的**位置信号源**
> —— 右侧标尺栏（`TurnNavigator`，`ui-chat/src/client/chat/TurnNavigator.tsx:83 TurnNavigatorRail`）
> 的点击落点与聊天区滚动位置。若该信号在客户端不可得，就必须新增一条 wire 或读取宿主投影；
> **在动手之前先查证它是否已随 `snapshot` 可得**，不要预设要改 Host。
>
> ✅ **2026-04-10 已查证：口子不需要开，更不需要改 Host。** 结论与依据：
> 1. 标尺栏点击走 `onNavigate(item)` → `navigateToTurn`（`ChatView.tsx:722`），它**滚动的是聊天记录本身**，
>    **并不存在**一个独立的"标尺栏位置"状态。所以"用户手动滚动"和"点标尺栏"到达客户端时
>    是**同一个 `scroll` 事件**——一个信号源就够，不需要两条 wire。
> 2. 位置本身也能从现有 DOM 读出：聊天区滚动容器是 `[data-conversation-scroll]`
>    （`scrollerOf(from)`，`ChatView.tsx:23-25`），每一帧的行是 `[data-chat-anchor-key]`
>    ——**正是本插件滚动时已经在用的那个属性**。
> 3. 因此实现只有一个 `document` 捕获阶段的 `scroll` 监听（客户端），Host 半边只多了
>    `historyJumpSmartFollow` 这一个持久化字段（六处规则）。**没有新 wire、没有新端点、没有读宿主投影。**
>
> **同一轮里被写下又被删掉的一段代码，记录在此以免重复**：第一版实现为"不要把自己的滚动
> 当成用户的移动"加了一个 `selfScrollRef` 一次性标记。**变异测试证明它是死代码**——把该判断
> 恒置为假，96 条用例一条都不变。原因是两条路径都从同一批 DOM 行算位置：漫游把某帧滚到阅读线，
> 跟随又选离阅读线最近的那一行，**仍是同一帧**，所以重定位是幂等的。它也没能覆盖那个看起来
> 需要它的场景：`behavior: 'smooth'` 的滚动会连发很多事件，中途最近的往往是**中间某一帧**，
> 而按"目标帧键"记的标记**一个都匹配不上**。教训：**变异不掉的判断就不要留在代码里**
> （本仓库要求逐文件 100% 分支覆盖，留一个测不到的分支只能靠 `/* v8 ignore */` 遮过去，那是掩盖而不是实现）。

---

## 10. 已拍板（2026-09-28 复核）

| 编号 | 问题 | 裁决 |
| --- | --- | --- |
| D-01 | F1 面板列什么 | **每行 = 一条用户消息**（含 `steering` 插话），下方带该 turn 的助手回答摘要；过滤同时匹配两段 |
| D-02 | 重用语义 | **覆盖草稿**；且**通过「向下」可回到草稿**——`↓` 从最后一条历史消息继续向下即回到「当前聊天框」（= 用户正在输入的草稿，可为空） |
| D-03 | 同一 turn 内多条 `steering` | **各成一格**并标「插话」（它们是独立的用户输入，复用价值独立） |
| D-04 | 是否做 rewind（取回并截断） | **本期不做**（`ISessions.fork` 是按 seq 分叉**新会话**，语义不同）。列为 v2 |
| D-05 | 快捷键 | **两者都要**：`Esc` 进入选择态后 `↑`/`↓` 逐格回溯；**同时** `Ctrl/Cmd+↑` 与 `Ctrl/Cmd+↓` 在输入框内直接逐格回溯（等价手势，无需先按 Esc） |
| D-06 | 「整条消息」是否含引用摘要行 | **不含**。只取 `content` 里的文本块；引用在正文里本来就是 `@label` 形态 |
| D-07 | 帧粒度 | **每条用户消息一格**（`user` 与 `steering` 同等成格），助手/工具/思考块不成格 |

### 10.1 快捷键口径的查证结果（重要）

用户记忆里的「Cursor 用 `Ctrl+↑`/`Ctrl+↓` 逐条回溯」与 Cursor 官方文档**不一致**，查证如下：

| 来源 | 结论 |
| --- | --- |
| Cursor 官方快捷键表（`cursor.com/docs/reference/keyboard-shortcuts`，Chat 段） | 输入框只有 `Return` / `Cmd Return` / `Cmd Shift Backspace` / `Tab` / `Shift Tab` 等；**没有 `Ctrl+↑`/`Ctrl+↓` 的聊天绑定**。表里明确写着 `Escape` = **Unfocus field** |
| Cursor CLI（`cursor.com/docs/cli/using`） | 「Previous messages can be accessed using **arrow up** (ArrowUp) where you can cycle through them」——**裸 `↑` 循环历史** |
| Cursor FR 文档 | 同上；`Escape` pour retirer le focus du champ |

**所以 Cursor 的真实口径是「`Esc` 失焦 + `↑` 循环上一条」**，与本文档 §4.1 的状态机一致；
`Ctrl+↑`/`Ctrl+↓` 是 Cursor **编辑器**（非 chat）的历史/光标键，属用户记忆串台。

按 D-05「两者都要」，本插件**两套都实现**，但它们不是同一个东西：

- `Esc` → 选择态 → `↑`/`↓`：漫游手势，带**整区高亮 + 逐格高亮 + 自动滚动落位**（F2 完整形态）。
- `Ctrl/Cmd+↑` / `Ctrl/Cmd+↓`：**快捷回溯**，在输入框里直接回溯上一条/下一条，**不进入选择态**
  （仍然覆盖草稿并回到草稿，语义同 D-02 的循环）。这满足「用户记忆里那条键」的手感，
  同时不牺牲 F2 的可见性。

> 实现上第二条是第一条的「无 UI 变体」：共用同一个游标与同一个写回函数，
> 只是不渲染高亮、不接管方向键（见 §9 `history-keys.ts` 的 `resolveStep`）。

### 10.2 本机查证（已验证，非推测）

| 事实 | 验证方式 |
| --- | --- |
| `data-chat-anchor-key` / `data-chat-flow-key` / `data-chat-flow-kind` / `data-chat-turn` 四个属性真实存在 | 读 `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx:129-132` |
| `[data-conversation-scroll]` / `[data-composer-seat]` 真实存在 | 读 `ui-conversation/.../skeleton/ConversationContent.tsx:260,267` |
| `useChat` 是 session 级标准 hook | `ui-chat/.../contract/slots.ts:170-174`（`SessionStandardProps.useChat`） |
| `UserMessageNode` = `{ kind:'user', seq, time, content: readonly ContentBlock[], source }`；`SteeringMessageNode` 同形且 `kind:'steering'` | `ui-conversation/.../contract/records.ts:41-48, 87-96` |
| 文本块是 `{ type:'text', text:string }` | `llm/llm/lib/types/types.d.ts:46-49` |
| `location` 是 `{kind:'session'} \| {kind:'turn',turn} \| {kind:'step',…} \| {kind:'unresolved'}` | `ui-conversation/.../contract/conversation.ts:103-107` |
| **`apps/web/dist` 是旧构建**：其中**搜不到** `data-chat-anchor-key`、`data-conversation-scroll`、`data-chat-flow-kind` | 实测 grep `apps/web/dist/**/*.js`，三者皆无命中 |

> 最后一条**证实了 §2.1 的 `⚠ 待实测` 风险**：`dist` 这份产物不含这些属性。
> 因此**降级路径不是可选项而是必做项**：帧索引与判定本就不依赖任何 `data-*`（见 §5.1），
> DOM 查询只用于「滚动落位」，查不到就退化为「只更新高亮与草稿、不滚动」，
> 而**不是**让整个功能失效。这也意味着验收时若线上 3080 那份确实缺属性，
> A-02 的「滚入可视区」一半可能观察不到——这是环境事实，不是实现缺陷。


---

## 附录 A.4 浏览器验收通道的排查（本轮实测；A.4.1 已更正 A.4 的结论）

### A.4 第一版结论（**已证伪，保留作为教训**）

本轮先由「钩 `__ModuleLoader__.load` 只记录到 1 次注册」得出
「应用批次是 `script-preload`，永不执行」的结论，并据此写下「本脚手架不可达」。
**这个结论是错的，原因见 A.4.1。** 保留在此，是因为它示范了一个真实的测量陷阱。

读数正确的部分（仍然成立）：

| 断言 | 证据 |
| --- | --- |
| 宿主侧 atlas **完全正常激活** | `fiber.store` 六键齐全：`agents/typert/settings/atFile/atMention/atlas` |
| 客户端图里 **atlas 行存在且健康** | `clientModules.table` 56 项含该包，`clientPath` 指向真实 `lib/client.js`，六个 `inject` 齐全 |
| bundle **确实被取回** | 批量 URL 含 `@sidequest-007/dsh-atlas/client.js`，HTTP **200** |

错误的部分：由「只注册 1 次」推出「没执行」。

### A.4.1 更正：应用批次**确实被执行**（决定性读数）

`script-preload` 渲染成 `<link rel="preload" as="script">`
（`packages/host/webserver/src/injections.ts:62-63`）这一点属实，
但**预加载之后仍有一个按需 `import` 步骤真正执行它**：
`boot-client.ts:47-52` 对 `manifest.plugins` 的每一行调用
`loader.create({ name })`，而 `loader.internal = modules`，
于是每行都会走 `ClientModuleSystem.import(row)`。

**实测（钩 `__ModuleLoader__.create` 返回体的 `import`）：
`import` 被调用 56 次，包含 `@sidequest-007/dsh-atlas`，且无任何异常。**

### A.4.2 测量陷阱（导致第一版误判的根因）

第一版钩子打错了位置：

```ts
facade.load = wrapper      // ← 太晚；system.ts:109 之后会重新赋值 target.load
```

`ClientModuleSystem` 在切到 `live` 时会**重新赋值** `target.load`
（`system.ts:109`: `target.load = (registration) => this.register(registration)`），
把先前挂上的包装覆盖掉，于是钩子静默失效、只留下引导包的 1 次记录。

> **教训**：钩平台内部函数时，要钩**最终会被调用的那个引用**
> （这里是 `create()` 返回的系统对象），而不是 facade 上早先暴露的同名方法；
> 否则会得到一个"看起来很像真因"的假读数。

### A.4.3 当前的真实状态

插件**已执行、无报错**，但**没有任何副作用**：`document` 里
`data-atlas-*` 属性 0 个、atlas 的 `<style>` 0 个。而 `apply()` 的第一步就是
`adoptStyles()`，所以 **`apply` 没有跑到底**（实测：把 `apply` 包一层，
它**一次都没被进入**）；同时 `assertEntriesActive`（`boot-client.ts:63`）
**没有拒绝启动**，说明该 entry 不被判定为 failed。

### A.4.4 本轮已**逐项排除**的假设（都有实测，不要再重跑）

| 假设 | 排除方式与结果 |
| --- | --- |
| bundle 未导出 `apply` | 在 node 里按 `captured.factory(require)` 真执行 `lib/client.js`：`KEYS = ["apply","inject"]`，`typeof apply === "function"` ✓ |
| `unwrapExports` 把导出吃成 `undefined` | 实测 `__esModule: true`、**无** `default`；代入 `cordis-plugin-loader/lib/index.js:584-589` 得 `{apply, inject}` ✓ |
| `dsh.client.inject` 里写的包不存在 | 六个包**全部存在**且都有 `dsh.client`，声明名与包名逐一相符 ✓ |
| 六个包不是客户端图的行 | 全部是正常行（`dsh-client-connection` 无上游依赖）✓ |
| 客户端服务缺失（`sessions`/`connection`） | `ui-session` 声明并 `provide('sessions')`（`ui-session/src/client/index.ts:499`）；`connection/src/client/index.ts:308` `provide('connection')` ✓ |
| `apply` 抛异常 | 包裹 `apply` 后 trace 为空、`console.error` 调用数 **0**、页面上 `[pageerror]` **0** ✓ |
| 工具钩子位置错误导致假读数 | 两次不同钩法（facade `load` / `create` 返回体）读数互相矛盾 → 说明**两种钩法都没钩到 boot 路径**，此前基于钩子的结论一律不可信 |

> 注意最后一行：`bootClient` 用的是 `ctx.loader.internal.import(name)`
> （`cordis-plugin-loader/lib/index.js:218`），走的是 `ClientModuleSystem.import`
> **本身**，而不是页面全局 facade 上可被包装的那层。所以本节的
> 「`apply` 未被进入」是**可靠**读数（它来自包装模块导出对象，与走哪条路径无关），
> 而历史上的「注册 0/1/56 次」都**不可靠**。

### A.4.5 下一步（尚未做）

> **后续：§A.4.3/A.4.4/A.4.5 的这一串推断已被证伪，见 §A.5。**
> 真实的根因不在装载，而在生成闸门读错了信号（`partial`）。A.4.5 设想的
> "读 fiber 状态"**没有做，也不需要做**——entry 一直是 `ACTIVE`。

需要看**客户端 cordis Loader 里 atlas entry 的 fiber 状态**（是 `PENDING`
还是已 `ACTIVE` 但 `apply` 被跳过）。建议做法：不钩 facade，而是
在 `bootClient` 之后从 `ctx.loader.entries()` 里取该 entry，
打印 `entry.fiber.state` 与 `Object.keys(fiber.inject)` 的未满足项。
`docs` 与 `apps/web/tests/history-jump.e2e.ts` 里的断言**在定位清楚前不得放宽**。

---

### A.5 真正的根因：生成闸门读错了信号（A-01～A-04 全部由此而来）

**A.4 那一串"装载契约"的推断是错的，而且是错在方法论上**：它从"DOM 里没有
`data-atlas*` 属性"这一**观测**推出"`apply()` 没跑完"这一**机制**，中间跳过了
唯一能证伪它的一步——把闸门的实际判断**打印出来**。真实情况是 entry 一直
`ACTIVE`、`apply()` 一直跑到底、监听器一直装着，只是**每一次按键都被闸门挡掉**。

决定性读数（同一条按键、修复前后同页对比）：

```
{"key":"Escape","enabled":true,"menuOpen":false,"modalOpen":false,
 "generating":true,"foreignEditor":false,"frames":1}     ← 修复前，被挡
SIG: {"partial":true,"sessionRunning":false}             ← 两个信号不一致
AFTER ESC: {"roaming":"true"}                            ← 修复后
AFTER UP:  {"frameKey":"13:input-message3fb820c3-…"}
```

`generating` 来自 Chat 快照的 `partial`。这个字段**看起来**天然就是"是否在生成"
（它是流式助手步骤），但它**不是**：一步被中途取消（abort）后，该步在 Chat 投影里
仍然保留 `status: 'running'`，于是 `partial` 在会话已经安静下来之后**仍然非 null**。
症状因此极具迷惑性——**输入框已经不显示 Stop 按钮了**（宿主自己认为没在跑），
而本功能的每个快捷键都永久失效。凡取消过一次工具调用的会话都会这样，
不是偶发，是**该会话的历史手势全死**。

修法：改读 `useSession(s => s.running)`——这是 shell 自己的答案，也正是
`InputBar` 用来决定要不要显示 Stop 的那个标志。回归单测：
`leaves Escape alone while a turn is generating`；**已实测把信号改回 `false`
即恰好这一个用例失败**，说明它确实在钉住这条契约。

#### A.5.1 同时修掉的一处"清单写了但没做"

A-01 的原文是"输入框失焦，聊天区出现外层高亮"。高亮有了，**失焦从来没有**——
`case 'enter'` 里只 `setSlot`/`setPhase`，没有任何 `blur`。因为插件的监听器挂在
`document` 捕获阶段，手势**不依赖**焦点在哪，所以这个遗漏既不报错也不影响其它用例，
只有把清单原文逐字对照代码才看得出来。补 `blurComposer()` 后 A-01 才名副其实。

#### A.5.2 三个"看起来像产品缺陷、实际是测试自己错"的用例

这三条值得单独记，因为**每一个都会把排查引向错误的方向**：

1. **fixture 只有一条真实用户消息，不是五条**。原用的
   `snapshots/acp/cancel-tool-calls` 里另一条 `user/message` 事件的
   `source.kind` 是 `plugin`（系统提示快照），Chat 投影把它正确归类为注入的
   `context` 而**不是用户写的话**，所以面板显示"1 帧"**本来就是对的**。
   用 `"role":"user"` 正则在 JSONL 上数会数到工具结果里的载荷，于是虚高到 5。
   教训：**断言帧数之前先确认真实用户轮数**；`source.kind === 'user'` 才是口径。
2. **A-06 的过滤词取自 fixture，而真实用户轮可以完全没有 text 块**。该窗口的
   四条用户消息 `text` 长度都是 0（工具驱动的轮次），于是 needle 是空串、
   过滤后 0 行、`Enter` 无处可回填——面板当然不关。改成**从已渲染的行取词**，
   这也更贴近"用户看到什么就搜什么"。
3. **B-09 按序号重放目录树点击**，但树是 `Ungrouped` → **工作区** → 会话三层，
   会话行的标签是**消息派生的标题**而不是 seed id，所以 `.nth(1)` 点中的是工作区。
   改为"逐层展开直到 composer 真的可用"——那才是"会话已打开"的充要条件
   （没有会话时页面是工作区选择器，composer **存在但 0×0**，`waitFor` 会假通过）。

另有两处**工具链**教训：`expect.poll` 只能在测试体内用，放进 `beforeAll` 会抛
`expect.poll() must be called inside a test`（已改为 `page.waitForFunction`）；
以及**早前一次 PowerShell 文本往返把 `FrameCursor.tsx` 里的破折号与箭头写坏了**
（`—`→`鈥?`、`↑`→`鈫慲`），本次已逐个修回。**结论：绝不要在含非 ASCII 的文件上
用 `Get-Content -Raw` + `-replace` + `Set-Content`；用 `edit` 工具做精确替换。**

#### A.5.3 验收结果

- 浏览器验收通道 `apps/web/tests/history-jump.e2e.ts`：**当轮 6/6 通过**
  （A-01/A-02/A-03、A-04/A-07、A-04b、A-06、A-08、B-09）。（当轮读数；最新见 §8 C-01。）
- `pnpm run check`：**当轮读数** 36 文件、755 通过 + 4 跳过，`verify-publish-surface` ok
  （当轮读数；最新见 §8 C-01）。
- 仍未在**用户自己的 3080 GUI** 上实测：那需要重启 `dsh web`（当前进程早于
  所有构建）。§A.3 记录的 token 约束未变。
- 仍未实测的只剩 **B-10 的分页路径**：`loadThrough` 需要真实多页历史，
  seed fixture 是单页的。（**第二十轮已补齐**：见 §A.19 与 §8 的 B-10。）

---

### A.6 用户实测反馈的两处修复

§A.5 的通道全绿之后，用户在**自己的 GUI** 上试用，报了两个问题。两条都是
"绿色通道看不见"的缺陷，值得单独记。

#### A.6.1 "无法回答当前已输入的草稿"——写入与聚焦的顺序

**症状**：`Esc` → `↑` → `Enter` 重用一条历史消息后，输入框里**看得见**那条文本，
光标似乎也在，但**接着打字一个字都进不去**，必须先手动点一下输入框。

**根因是顺序，不是焦点**。`reuse()` 原先先 `setDraft(next)`、后 `focusComposer()`。
而宿主的 `setDraft` 语义是"**整段替换，光标落在末尾**"——这个"落在末尾"只在
**编辑器已经有焦点时**才成立。先写后聚焦，等于往一个没有焦点的 Lexical 里写：
文本上了屏，Lexical 内部的 selection 却是空的，于是后续每个按键都被丢掉。

**为什么单测没抓到**：jsdom 规格里那个 `div[contenteditable]` 是手搭的，
`focus()` 一调 `document.activeElement` 就变，断言"焦点回来了"是**真的**，
但它**不代表能打字**。这正是本功能最贵的一课：**"看起来就绪"和"真的可用"是两件事**，
而只有后者是用户要的。同样地，"`setDraft` 收到了正确文本"（A-07）也完全掩盖了这个缺陷——
文本确实是对的，只是用不了。

**排查过程中的关键读数**（浏览器内实测）：

```
POST-REUSE DOM: {"activeIsEditable":true,"selRangeCount":1,
                 "selAnchorInEditable":true,"selAnchorNode":"#text"}
DRAFT AFTER TYPING: (与重用后完全一致 —— 一个字都没进去)
```

即：DOM 焦点对、DOM selection 在编辑器内、**打字依然无效**。这一步把方向从
"焦点没回来"纠正到"Lexical 内部状态没同步"。

**试过但没用的做法**（记录下来省得再走一遍）：在 `focus()` 之后**合成**
`mousedown`/`mouseup`/`click`。无效——Lexical 只认**可信**输入，`dispatchEvent`
出来的事件它不据以认领 root。实测对照很干净：合成点击后打字仍然无效，
而**真实**点击（Playwright 的 `page.mouse.click`，产生可信事件）立刻就能打字。
**结论：不要用合成事件假装用户手势，那只会让修复看起来成立。**

**真正的修法**：把顺序反过来——`focusComposer()` 先，`setDraft(next)` 后。
对齐证据来自插件自己的另一条路径：**快捷 chord（`Ctrl+↑`）从来不 blur**，
所以它**从来没有这个 bug**（实测：`Ctrl+↑` 重用后直接打字，`QUICK-TYPED`
正常插入）。把 `Esc` 路径改成同样的顺序后，`Esc` 路径也正常了
（实测 `TYPING WORKED: true`）。

浏览器回归用例 `A-04b`：重用之后**不点击**直接打字，断言新文本**出现**。
这条断言是必须的——任何"草稿内容正确"型的断言都抓不到本缺陷。

#### A.6.2 读数条溢出聊天框

**症状**（用户截图）：漫游时浮出的读数条把 `文件提及` 标签 + 消息全文一起横着排，
长消息把它**撑出聊天框**宽度。

**三个原因，都是实现问题**：

1. **标签用错了 key**。那条读的是 `t('nav')`，而 `'nav'` 是 **dock 的分组标签**
   （"文件提及 / File mentions"），与"历史漫游"毫无关系。改为新 key
   `history.roamLabel`。
2. **只有 `max-width` 没有 `width`**。flex 容器仍按**内容**撑开，于是长预览越过上限。
   补 `width: fit-content` + `min-width: 0`（后者才是允许文本子项收缩的那一条），
   外层再加 `padding: 0 16px` 保证窄屏也不贴边。
3. **字号写死**。`font-size: 12px` 与聊天框无关；改为 `font: inherit` 继承聊天列的
   字体，再用 `font-size: 0.85em` 相对缩小。

排版也按用户要求**简化**：现在是 `[历史] 第 x/y 条 │ 预览`，
预览 `max-width: 16em` 且 `text-overflow: ellipsis`，**位置与条数**是必须可读的部分
（`flex: none`），预览先让位。顺序也调了——先给位置再给内容，与"第 x/y 条"
这个用户点名要的主信息一致。

**顺带记一个工具链坑**：改 `styles.ts` 时在注释里写了**反引号**（`` `width` ``），
而整个 CSS 是一个模板字符串，反引号**提前把它闭合了**，构建报
`Expected ";" but found "width"`。CSS 注释里不要用反引号。

---

### A.7 第二轮实测：三个缺陷（用户 2026-10-02 反馈）

用户在两张截图上提了三件事，全部**先复现、再修、再回归**。三件事都不是新需求，
是 §4 已定契约的实现没有做到。

#### A.7.1 Ctrl+↑ / Ctrl+↓ 失效（三个缺陷里最严重的一个）

**症状**：快捷键完全没反应——不报错、不写草稿、什么都不发生。

**根因（写入与聚焦的顺序）**：`reuse()` 先 `setDraft(next)`、后 `focusComposer()`。
而官方 `InputActions.setDraft(text)` 的语义是**整份替换草稿、并把光标放到末尾**——
这个"放光标"只在编辑器**已经持有焦点**时才生效。于是顺序反了以后：
文本确实写进去了、`document.activeElement` 确实是输入框、DOM selection 也确实在框内，
**但下一次按键被静默丢弃**。用户看到的就是"快捷键没反应"。

**修复**：`focusComposer()` 提到 `setDraft()` **之前**。

**为什么 Escape 路径独有此病**：快速快捷键（Ctrl+↑/↓）**从不失焦**，所以它一直没有这个
缺陷；Escape 会 `blurComposer()` 把焦点交出去，回来时不重新聚焦就中招。这也解释了
用户"Ctrl 上和下怎么无效了"的直觉——是同一个写入顺序，不是两个功能混淆。

**关于"你是不是把两个功能混淆了"**：核对后**没有混淆**。`resolveIntent` 里
快捷键分支在 phase 分流**之前**（`history-keys.ts` 的快速步进分支），`roaming` 分支
再读一次 `state.phase`，两条路径互不干扰。真正的缺陷是**共用了一条 no-op 守卫**，
把"移动到 slot 0"误判成"动不了"：

```
const returningToDraft = next === 0 && state.slot !== 0
if (next === state.slot && !returningToDraft) { event.preventDefault(); return }
```

slot 0 同时是"草稿位"和"往回一步之后我所在的位置"，所以回草稿的那一次按键被吞掉，
**用户的原文再也拿不回来**（实测：`RESET-ME` 按两次 Ctrl+↓ 之后仍然回不来）。

#### A.7.2 草稿的"自己人"判定（A.7.1 的连带修复）

**症状**：Ctrl+↓ 回到草稿位时，回来的**不是用户自己写的字**，而是**上一轮漫游留下来的
消息**。浏览器实测拿到的是 `Create the relative path policy-neutral.txt…`——
这段文字本测试**从未输入过**。

**根因**：暂存只在 `ownDraftRef.current === undefined` 时写入，于是"上一轮漫游已经存过"
就永远不会被**用户后来真正打的字**替换。而漫游写入和用户打字走的是**同一条草稿通道**，
光看值分不出是谁写的。

**修复**：加 `lastWriteRef`，记录**本插件最后一次写进去的内容**。`reuse()` 里若发现
当前草稿**不等于**本插件上次写的值，说明这是**用户自己打的**（或上一轮漫游遗留的），
就把旧暂存丢掉、改存当前值。

**关键的 `undefined` 那一半**：漫游结束后 `lastWriteRef` 会被清空，于是**下一轮**
第一次 `reuse` 看到的是"有值、但没记录写入者"。把这种情形当成"已经存过了"正是
上述缺陷的成因——所以判据是 `current !== lastWriteRef.current`，而**不是**
`lastWriteRef.current !== undefined && current !== lastWriteRef.current`。
这一行写错过一次，实测仍复现原缺陷。

**回归用例**：`history-cursor.spec.tsx` 的
"gives back a draft typed AFTER an earlier walk, not the earlier walk's stash" 与
"keeps the first stash across a walk that reuses several frames"。
后者必须让 stub **回显**插件的写入（真实 `setDraft` 就是这么做的），
否则 `lastWriteRef` 的"这是我写的"分支根本走不到。

#### A.7.3 读数条超出聊天框

**症状**（用户截图，红色箭头指向"历史"两个字）：读数条比聊天框**宽**、并且**偏左**。

**根因**：宽度早就对了，**错的是偏移**。`.dsh_atlas_roamBar` 用
`inset-inline: 0` + `justify-content: center` **相对视口**居中，而聊天框只在
**自己的列**里居中。1440px 窗口实测：

```
修复前  cardLeft 511  cardRight 1439  barLeft 376  barRight 1304  overflowLeft 135
修复后  cardLeft 511  cardRight 1439  barLeft 511  barRight 1439  overflowLeft   0
```

**修复**：读数条改为**贴着聊天框量**。新增一个 effect，
用 `document.querySelector('[data-composer-card]')` 的 `getBoundingClientRect()`
把 `--dsh-atlas-roam-left` / `--dsh-atlas-roam-width` 两个自定义属性写在
`documentElement` 上，`.dsh_atlas_roamBar` 读它们；同时拿掉
`inset-inline: 0`、`justify-content: center` 和居中用的 `margin: 0 auto`。

三个必须保留的细节：

1. **`rect.width <= 0` 时不发布**。工作区选择器到聊天视图之间，卡片存在但尚未布局，
   发布 0 宽会把读数条**闪成一条线**；此时保留上一次测量。
2. **监听 `resize` 重新测量**。侧栏开合会让卡片移动却不触发重新挂载。
3. **卸载时清掉两个属性**。自定义属性会**继承**，留着的旧值会把下一个浮层放到
   上一次的几何位置。

**回归用例**：`A-09`（浏览器实测）、"anchors the readout to the composer card instead of
the viewport"、"re-measures the card on resize and clears the box when the walk leaves"、
"keeps the last measurement while the card is not laid out"。
第一条刻意**同时**断言 `left` 和 `width`——只断言宽度的用例在**坏掉的构建上也会通过**，
因为坏的从来不是宽度。

#### A.7.4 到尽头可以继续向上翻（用户第三条要求）

**要求原文**："esc 后的 up 键，要允许到达当前聊天页面尽头时，可以再向上跳转，
同时更新消息总数及当前消息序号"。

**实现**：`case 'step'` 里，当一次向上步进**动不了**、且方向为旧、且有 `loadThrough`
可用时，拿**最旧一帧的 `seq`** 调 `loadThrough(seq)` 翻页。`.then` 里**重新读**
`stateRef.current.frames.length`（闭包里的 `state.frames` 是翻页**之前**的窗口）：

- **没有长出新帧**（`grown <= before`）→ 这是**真尽头**，`setEdgeReached(true)` 说明原因。
- **长出了新帧** → 跳数按 `grown - before` 平移，**漫游继续往前走**，
  而不是停下来等第二次按键。

**"同时更新总数与序号"是自动成立的**：帧列表由 Chat 快照**实时派生**
（`useHistoryFrames` → `buildFrames`），翻页换掉快照之后总数和序号一起更新。
反过来，若在旧窗口上停住不动，就会看到**总数涨了、序号没动**——那才像计数器坏了。
这也是把"继续走"而不是"停下等第二按"作为默认行为的原因。

**崩溃与失败**：`.catch` 把翻页失败也当=尽头（用户必须被告知，而不是静默停住）。
拒绝的 promise 被吞掉，不会冒成 unhandled rejection（有专门用例）。

**实测证据**：四帧窗口下，向上在 1、2、3 处各移动一次，第 4 次是边缘 no-op；
**四次**向下回到 `OWN-DRAFT-MARK`（`isOwn: true`），三次会停在帧上。
读数条同步给出 `1 / 4`——**总数与序号都是活的**。

**未验证的部分（如实记录）**：当前 fixture 只有 3–4 帧，
`loadThrough` **没有真正翻出过新帧**，所以 A.7.4 的"长出新帧之后继续走"这一支
只有 jsdom 覆盖，**没有端到端实证**。需要真实多页历史才能关掉（= B-10）。

#### A.7.5 用例侧的两个坑（本轮踩到，记下来）

1. **`describe` 内共享一个 jsdom document**。`beforeEach` 原来只清
   `document.body.innerHTML` 并摘掉 `data-atlas-roaming`，而本浮层把状态写在**三处**：
   body、`documentElement` 的属性、以及卡片几何的两个自定义属性。
   清理不全导致**上一个用例的残留**把无关用例读成回归
   （实测：残留的 `data-atlas-roaming` 让 B-03 用例"失败"，
   残留的 `u2` 锚点行让滚动计数从 1 变 2）。现已把三处一起清。
2. **翻页是异步的，断言必须放行 microtask**。`setEdgeReached` 在 `.then` 里决定，
   同步断言等于把**异步之前**的行为钉死。这类用例要么 `await act(...)`，
   要么断言用户可见的最终结果。

浏览器侧同类的坑还有一条：`describe` 内**共享同一个 page**，
后一个用例不能假设草稿内容或漫游深度——两个重用用例现在共用一个
`resetToCleanDraft()`，先退出漫游再清空草稿。

#### A.7.6 本轮回归结果

- `pnpm run check`：**36 files / 763 passed + 4 skipped**，构建与
  `verify:publish` 均通过。
- `FrameCursor.tsx` 覆盖率 **100 / 100 / 100 / 100**。
- 浏览器验收通道 `history-jump.e2e.ts`：**8/8，连续 3 次稳定通过**，
  含新增的 `A-04c`（Ctrl+↓ 回到用户自己的草稿）与 `A-09`（读数条贴合聊天框）。

---

### A.8 第三轮实测：三条反馈（用户 2026-10-02 第二轮）

用户这一轮给了三条，逐条记录结论与**证据**，包括一条**没有复现**的。

#### A.8.1 反馈一：Ctrl+↑/↓ 已能取到"用户刚输入的草稿"——**用户确认验收无误**

无需改动。这条是 A.7 里 `ownDraftRef` + `lastWriteRef` 那一组修复的直接结果：
快捷键路径不再只看"上一次写入"，而是先判断"当前草稿是否还是本插件写的"，
不是就说明用户自己改过，于是**用户的文本**才是草稿槽要交还的东西。

#### A.8.2 反馈二：读数条改为**动态停靠在聊天框上方**，与 `/goal` 同层且互不遮挡

**结论：已实现，且是一次"删除"而非"新增"。**

用户的原话是"如 `/goal` 一样动态显示在聊天框的上面，但不顶掉其他动态界面，相互不干扰可见性"。
`/goal`、`/todo` 用的是框架的 **`conversation.input.dock`** 槽位
（声明见 `ui-conversation/src/client/apply.ts`，类型见 `contract/slots.ts`），
而该槽位的容器 `ConversationRoot.module.css` 里是
`display:flex; flex-direction:column; gap:6px` 的**纵向栈**，
并且按 `ConversationContent.tsx` 的顺序渲染在 `inputBar` **之上**。
也就是说：

- **"在聊天框上方"**：由槽位自身的顺序保证；
- **"互不干扰"**：由**纵向栈 + 6px 间距**结构性保证——
  三者是同一 flex 容器的兄弟节点，**物理上不可能重叠**，
  不存在 z-index，也不需要测量任何几何。

于是本轮把读数条**搬进该槽位**（`id: 'atlas-history-readout'`, `order: 30`），
随之**删掉**为浮层而存在的一整套东西，而不是把它们留在原地：

| 删除项 | 原用途 |
| --- | --- |
| `.dsh_atlas_roamBar` 的 `position: fixed` | 浮层没有可继承宽度的祖先，只能自己定位 |
| `--dsh-atlas-roam-left` / `--dsh-atlas-roam-width` | 从聊天卡片 `getBoundingClientRect()` 抄来的左缘与宽度 |
| `bottom: 96px` | 手工把浮层"抬到"聊天卡片上方 |
| 测量用的 `useEffect`（`measure` + `resize` 监听） | 每次订阅都要**强制同步布局**换一个 token 根本改不了的值 |
| 三条围绕卡片几何的 jsdom 用例 | 钉的是已退休的实现 |

> 这一条值得强调：浮层方案里"贴着聊天卡片"是靠**测量 + 自定义属性**凑出来的，
> 而停靠方案里它是**布局的自然结果**。后者不但代码更少，
> 也让 A.7 里"读数条溢出聊天框"那一类缺陷**从根上不再可能**。

**踩到的坑：dock 行的宽度必须写两半，不是一半。**
搬进 dock 后第一次实测**仍然溢出**（读数条 `left=308`，而聊天卡片 `left=511`）。
在浏览器里把祖先链逐层量出来才看清：

| 层级 | 实测 |
| --- | --- |
| `.dsh_atlas_roamBar` | `left=308 right=1642 width=1334` |
| 槽位的包装元素 | `display: contents`（不产生盒子，所以必须由**行自己**定宽） |
| `.composerStack` | `left=280 right=1670 **width=1390**` |
| 聊天卡片 | `left=511 right=1439 **width=928**` |

**`.composerStack` 比聊天卡片宽得多**（1390 vs 928）：整列跟的是会话**栏宽**，
而输入卡片自己被 `--dsh-composer-card-max-width` 限宽后**居中**。
所以 dock 行的宽度契约是**两条**，缺一条就错：

```css
width: calc(100% - 2*clearance - 3*inset);          /* 从列里内缩 */
max-width: calc(card-max-width - 4*inset);          /* 再卡到卡片 */
```

框架自己的 `TodoPanel.module.css` 与 `GoalBar.module.css` **两条都写**。
第一版只搬了 `width`，于是行宽 1334px，比卡片两侧各溢出约 200px——
正是用户当初报的"溢出聊天框"。补上 `max-width` 后读数条落进卡片范围内，
端到端用例以**卡片左右边界**为断言对象，实测通过。

> 教训写在这里：停靠**不等于**自动对齐。槽位保证的是"不重叠、有间距"，
> 宽度对齐仍然依赖调用方复用框架的宽度契约；只看"它是同层兄弟"就宣布对齐，
> 会被真实排版当场否掉。

**两半如何共享状态。** 手势与读数是两个槽位组件 = 两棵 React 树，
props 与 context 都传不过去，所以新增 `src/client/roam-store.ts`：
一个 `createSnapshotStore` 风格的极小 store，在 `apply()` 里**创建一次**，
注入给两半。它按**值**比较（而非按引用），因为浮层的发布动作发生在**每次渲染**——
按引用通知会让读数条为每个流式 token 重渲染一次。

#### A.8.3 反馈三：第一次 Ctrl+↑ 有时卡顿——**未能在受控通道复现；已测量、已排除，并撤掉了一个"想当然"的优化**

用户回答的卡顿口径是"首次按下明显卡住（>500ms 或短暂无响应）"。为此做了**两级测量**：

1. **jsdom 侧直接量 `buildFrames` 的成本**（当时最可疑的对象）：

   | turns / nodes | ms |
   | --- | --- |
   | 50 / 100 | 0.43 |
   | 200 / 400 | 1.07 |
   | 500 / 1000 | 2.47 |
   | 1000 / 2000 | 5.15 |
   | 2000 / 4000 | 10.45 |

2. **真实浏览器通道里量按键本身**（补丁 `scrollIntoView` 与 `requestAnimationFrame` 计数，
   连做 4 次 Escape/↑ 往返）：`timings [18, 63, 26, 30]`、`scrolls [0,0,0] raf 8`、`errors []`。
   即**首次 18ms**，四次里最慢 63ms，`scrollIntoView` 0ms。

**结论：`buildFrames` 与按键处理器都被排除，>500ms 的卡顿在受控通道里没有出现。**
因此**本轮不宣称修好了这个卡顿**——没有证据。用户侧那一瞬的卡顿，
更可能来自首次按键之前浏览器尚未完成的排版/字体/首次高亮绘制，
或整机当时的负载；这些都不在插件代码路径上。

3. **一个被证伪并被撤掉的优化**：本轮先写了"按 store 身份缓存 frames"的实现，
   写完才发现 `useHistoryFrames` 里**本来就是** `useMemo(..., [order, nodes, mode])`，
   新缓存与它**完全等价**——实测 walk 次数不变。更重要的是，
   框架侧 `chat-snapshot-builder.ts` 用 `sameReferences` 保住数组身份，
   但同文件另一处对真实变更返回 `true`，**内容真变时数组身份一定会换**，
   所以身份缓存对"真正变了的"场景**帮不上任何忙**。
   该实现已**撤回**，并把这段结论作为注释留在 `useHistoryFrames` 上方，
   避免以后有人再走一遍这条路。

**顺带修掉的三处真实浪费**（都不足以解释卡顿，但确属无谓开销）：

- 命中高亮的 `useEffect` 依赖从 `frames` 改为 `frames.length`——
  `frames` 每个流式 token 换一次身份，而重查锚点行与 token 无关；
- 几何测量 effect 整体删除（见 A.8.2）；
- 一处依赖数组的排版错误 `}  }, [a, b])` 修正为 `}, [a, b])`。

#### A.8.4 本轮新增的一个**真 bug**（由新用例抓出来）

读数条在没有注入 store 时必须**什么都不渲染**而不是抛错——
dock 是聊天框的常驻部分，这里崩掉会**连累输入框**。
为此写的用例当场失败，根因是 `useSyncExternalStore` 的 `getSnapshot`
在无 store 分支里**每次调用都新建一个对象**，React 认为快照一直在变，
以 "getSnapshot should be cached" 中止。
已改为返回**同一个冻结实例**。这条记在这里，因为它是"为一个兼容分支写用例"的
直接回报：不写这个用例，这段代码会以"看起来没问题"的状态进主干。

#### A.8.5 本轮回归结果

- `pnpm run check`：**36 files / 771 passed + 1 skipped**，typecheck、
  构建、`verify:publish` 全绿。
- 覆盖率：`FrameCursor.tsx`、`roam-store.ts`、`styles.ts` 均
  **100 / 100 / 100 / 100**。
- 用例总数：`tests/history-cursor.spec.tsx` **67 passed**
  （新增 dock 停靠、互不遮挡、空闲不占行、无 store 不崩、store 按值通知与退订等）。
- 浏览器验收通道 `history-jump.e2e.ts`：**8/8**，
  其中 `A-09` 已从"贴合卡片几何（已退休的实现）"改写为
  `A-09/A.8`——以**真实排版**断言读数条在输入框之上、在卡片水平范围内、
  且与同层其他 dock 行**零重叠**。修复后连续 **8 次**运行全绿。
- 两个临时探针（jsdom 的 `zz-probe-frames.spec.ts`、浏览器侧的
  `zz-probe-perf.e2e.ts`、以及为定位宽度问题临时写的 `zz-measure-width.e2e.ts`）
  **已全部删除**，不留在仓库里。

> 顺带记一条流程教训：定位宽度问题时**先看构建是否真的成功**。
> 本轮有一次"改了 CSS 却毫无变化"——因为 `styles.ts` 的模板字符串被
> 注释里的反引号截断，`pnpm run build` **报错退出**，而浏览器通道仍然
> 加载**上一次的旧 bundle**，于是看到的是旧行为。这已经是同一个坑的**第四次**
> 踩中（见 A.7 与本轮 `styles.ts` 上方注释），结论：**在 `styles.ts` 的
> CSS 注释里永远不要写反引号**，且改完 CSS 必须确认构建输出里出现了
> 新的 `lib/client.js` 尺寸行。

### A.9 第四轮实测：两条需求（用户 2026-10-02 第三轮）

本轮用户提了两件事，事前一并说清："**请将这个及之前的没有记录的需求记录到唯一需求文档**"——
所以这一节既是修复记录，也是把"之前只在对话里说过、文档没有"的两条**补记为需求**。

#### A.9.1 需求补记一：读数条样式对齐 `/goal` 的官方样式

- **用户原话**："如图不错，背景色等样式是否可对齐 `/goal` 的官方样式？"
- **需求口径（正式条目，见 A-11）**：读数条的**外观**必须与框架自己的 dock 卡片
  （`/goal` 的 `GoalBar`、`/todo` 的 `TodoPanel`）**同族**——不是"看着像"，
  而是**同一套 CSS 变量与同一组几何数值**。

**实现：搬配方，不发明配方。** 框架的 dock 卡片是**两层盒子**，这一点是本轮
最关键的发现（A.8.2 只说"停靠"，没说"尺寸怎么来的"）：

| 层 | 类 | 职责 | 关键数值 |
| --- | --- | --- | --- |
| 外层**垫片** | `GoalBar.module.css` 的 `.dock` | 让出 dock 的内缩，自身**没有** max-width | `width: calc(100% - 2*侧边留白 - 4*dock内缩)`、`margin: 0 auto` |
| 内层**可见卡片** | 同文件 `.bar` | 真正的卡片 | `height: 36px`、`padding: 4px 5px 4px 12px`、`gap: 10px`、`border: 0.5px solid var(--dsw-alias-border-l1)`、`border-radius: 12px`、`background: var(--dsw-specific-tip)`、`max-width: calc(var(--dsh-composer-card-max-width) - 4*dock内缩)` |

于是 `styles.ts` 里 `.dsh_atlas_roamBar` 变成**外层垫片**、
`.dsh_atlas_roamBarInner` 变成**可见卡片**；字号族也照搬
（标题 13px/24px/500 + `--dsw-alias-label-primary`，正文
13px/20px + `--dsw-alias-label-primary-dimmed`，边角说明 12px +
`--dsw-alias-label-caption`）。**旧的自造表面（999px 胶囊、`--dsw-alias-bg-elevated`、
投影、`0.85em` 字号）整段删除**——留着它就是"两套视觉语言"，下次改主题必然走样。

三个值得留下的实测结论：

1. **`.composerStack` 是 1390px，卡片只有 928px。** 栈跟的是**会话栏**，
   卡片是**居中且被 max-width 压住**的。所以"停靠"不等于"自动对齐"：
   外层必须整体铺满（否则背景条会短一截），内层必须自己带 max-width
   （否则卡片会比 `/goal` 宽出一道边）。**两层缺一不可**——只写外层就会重演
   A.8.2 的"看着差不多但其实宽了"。
2. **`0.5px` 发丝线在浏览器里报 `1px`。** Chromium 按当前 DPR 序列化
   `border-width`，`/goal`、`/todo` 同样报 `1px`（框架里没有任何覆盖；
   `GoalBar.module.css:29`、`TodoPanel.module.css:22` 都写 `0.5px`）。
   所以浏览器通道断言的是"**是发丝线而不是粗边**"（`0 < width <= 1`，
   与 DPR 无关），**不是**去断言那个字面值——断言字面值会得到一条
   与环境绑定、换机器就红的用例。
3. **对齐要拿真卡片比，不要抄常量。** 浏览器用例
   `A-09/A.8` 现在按 `[data-goal-bar] > :first-child` 取**框架真实的**目标卡片，
   逐项比对 `height / radius / borderWidth / background`；会话里没有 goal 时
   该比对跳过。抄常量只能证明"我抄对了"，比真卡片才能证明"**没走样**"。

#### A.9.2 需求补记二：`↑` 到当前分页最早一条时，**自动翻页**到上一页

- **用户原话**："**ESC 模式下，up 箭头到达当前分页最早一条消息时，就无法继续了？
  期待是可以按 up 键，会翻页到上一页**，现在只能我手动点击（页面最右侧的标尺栏）
  来手动翻页或跳转，请优化为可随 up 键而自动翻页。"
- **需求口径（正式条目，见 A-12）**：漫游中在**已加载窗口的最旧一条**再按 `↑`，
  必须**自动向上翻一页历史并继续漫游**，用户不需要去点页面右侧的标尺栏；
  只有当**确认没有更早历史**时，才允许停下并显示"已到已加载历史的最旧一条"。

**这条其实上一轮就"实现"过，但它是坏的——而且是本轮才证明的。**
上一轮（A.7.4）已经写了翻页分支，但**判定"这一页到底有没有翻到东西"的地方读错了
数据**，于是**每次都在撒谎**：

```js
// 旧代码（错的）：在 promise 的 .then() 里数帧
void loadThroughRef.current(oldest.seq).then(() => {
  const grown = stateRef.current.frames.length   // ← 读到的还是"翻页前"的窗口
  if (grown <= before) { setEdgeReached(true); return }   // ← 于是永远走这里
  setSlot(current => stepSlot(current + (grown - before), -1, grown))
})
```

**根因是一条竞态，而且是"promise 会赢"的那一种**：`loadThrough` 在 Host 收下这一页
时就 resolve 了，而**新的帧列表要等下一次 React 渲染才会到达组件**。`stateRef`
是在**渲染期间**被赋值的，所以 `.then()` 里读到的永远是**翻页前**的帧数——`grown`
恒等于 `before`，`grown <= before` **恒真**，每次按 `↑` 都报"已到最旧"。用户看到的
"无法继续了"正是这个：**页面其实翻到了，只是插件不承认**，游标被冻在原地
（读数条的总数却涨了，于是又变成"序号和总数对不上"）。

**修法：把判定从"promise 结算时"推迟到"帧真的变了时"。**

- 按 `↑` 时只**登记**这一次翻页请求（`setPendingPage({ before: count })`），
  记下翻页**前**的窗口大小；
- 一个 `useEffect` 在帧列表变化后结算它：真涨了就把游标推进
  （`stepSlot(current + (grown - before), -1, grown)`），没涨才是**真的**到了尽头
  并显示提示；`loadThrough` 抛错同样按"到了尽头"处理（本分支既有规则：
  失败必须让用户听见，不能静默停住）。
- 请求登记用的是 **state 而不是 ref**，理由很隐蔽但必须记下来：
  **页面什么都没翻到时 `frames.length` 不变**，若 effect 只以长度为依赖，
  它就**不会再跑一次**，"到了尽头"的提示也永远不会出现。所以触发条件是
  **"请求本身"**，长度在结算时现读。

**用一句话概括这条教训**：`frames.length <= before` 这种"看有没有变"的判断，
**必须在变化可见之后再读**；在异步回调里读一个"下次渲染才更新"的值，
得到的不是"旧值"而是"**永远为真的条件**"。

**关于 `Home` 键的一处刻意不改**：`Home` 是**跳转**（"带我到现有的最上面"），
不是**步进**，所以它在最旧一条就停住、不触发翻页；已有用例
（`pages on Home to the oldest, and does not page when there is no history`）
把这条钉住了。本轮一度顺手让它也翻页，**该用例立刻变红**——于是改回，
并在代码里写明这是**决定**而非遗漏。区分标准很清楚：
`↑` 到尽头是"再往前"，`Home` 到尽头是"到了"。

#### A.9.3 本轮修掉的一个**真 bug**，以及它是怎么被抓到的

- **抓法**：给翻页分支写了一条覆盖"**这一页真的翻到了**"这条臂的新用例
  （`continues the walk into a page that actually arrives, and keeps counting`）。
  A.8 的记录里就有一条结论——"**只覆盖一条臂的用例，另一条臂等于没被证明**"——
  而上一轮的翻页用例**只覆盖了"翻不到"那条臂**（loader 直接 `Promise.resolve()`），
  所以这个 bug 整整存活了一轮。
- **反向验证**：把修复 `git stash` 掉再跑该用例，它**以用户描述的症状失败**
  （`1 / 2`、游标停在 `second question`、附上假的"已到最旧"提示）；
  恢复修复后变绿。**用例确实钉住了这个 bug，而不是描述了一个巧合。**
- **本轮同时修掉的测试自身缺陷**：三条既有用例原来断言"一次微任务之后就有提示"，
  那是**按住旧实现的时间假设**写的。现在结算时机变了（等帧变化），
  断言也跟着改成等 effect 跑完——**改的是用例的等待方式，不是它的结论**。

#### A.9.4 本轮回归结果

- `pnpm run check`：**36 files / 773 passed + 1 skipped**，typecheck、
  构建（`lib\client.js` 833.6kb）、`verify:publish` 全绿。
- 覆盖率：`FrameCursor.tsx`、`roam-store.ts`、`styles.ts`、`history-frames.ts`、
  `history-keys.ts` 均 **100 / 100 / 100 / 100**。
- `tests/history-cursor.spec.tsx`：**69 passed**
  （新增"翻页真的到达并继续计数"、"读数条套用框架 dock 卡片配方"等）。
- 浏览器验收通道 `history-jump.e2e.ts`：**9/9**，新增
  `A-10/A.9`——在**真实浏览器**里一路按 `↑` 直到游标停住，再按一次，
  断言提示出现、游标**不跳**、再按 `↓` 提示消失。这是修好之后
  "自动翻页 + 到尽头提示"两条行为的**端到端证据**。
- 临时探针已全部删除，仓库里不留。

> 又一条流程教训（与 A.8.5 那条同类）：**浏览器通道渲染的是英文 locale**
> （`newEnglishPage`），断言产品中文文案会**必红**。本轮先按中文文案断言，
> 探针却显示提示**明明在屏幕上**——说明当时红的是**用例**而不是产品。
> 看到"探针说有、断言说没有"时，先怀疑断言读的是不是同一个东西
> （语言、时机、还是另一个元素）。

---

### A.10 第五轮实测：读数条 `0 / 0` 与 Ctrl+↑ 无反应（用户 2026-10-02 第三轮反馈）

用户原话（附两张截图）：

> 1. ESC模式如图 当前会话 为何没有历史消息 ，时间标尺 如图 有那么多刻度
> 2. ctrl up 也无法调出 历史消息呢？

两句是**同一个 bug 的两个症状**，都归到 §4 已定契约没做到，不是新需求。
经追问确认：出问题的是**用户此刻正在对话的这个会话**（不是某个历史会话）。

#### A.10.1 根因：两套数据口径（"已加载窗口" vs "整份日志"）

这是本轮唯一真正的根因，也是最容易被忽略的一处**作用域错配**：

| 读数来源 | 数据作用域 |
| --- | --- |
| 漫游帧列表（`buildFrames`） | `useChat(s => s.order)` / `s.nodes` = **仅已加载的分页窗口** |
| 页面右侧刻度尺（`TurnNavigator`） | `mergeTurnRailItems(navigation.items(), turnOutline)` = 窗口 **+ 整份日志投影** |

`turnOutline` 是 `packages/session/session-turn-outline` 的投影，
其源码注释写明它存在的理由就是

> the whole-log turn outline the chat rail renders **for turns outside a client's paged event window**

也就是说：**标尺天然按整份日志画刻度，而漫游只看得见窗口**。
一个会话只要"**窗口里一条 `kind: 'user'` 节点都没有**"，漫游的帧数就是 **0**：

- 读数条显示 `第 0 / 0 条`——用户截图的原文；
- `↑` / `Ctrl+↑` 都**没东西可走**，所以"无法调出历史消息"。

会话为什么会处于这种状态？典型两种，用户这次命中的是后者：
1. 会话很长，客户端头部从未翻进来；
2. **会话是从某条消息跳进来的**（跳转本身会把窗口定位到 `seq` 附近），
   于是窗口里全是助手节点、没有用户节点。

**为什么整整一轮没被发现**：浏览器通道的基准夹具
`snapshots/web/permission-policy-context/session.v3.jsonl` 是
**4 条 user 帧 / 4 个 `turn/start`**——窗口本来就装着整个会话，
`turnOutline` 一条都补不上，所以**那条通道在结构上无法复现这个 bug**。
仓库里没有任何夹具长到能暴露"窗口小于整份日志"。

#### A.10.2 修复：把 `turnOutline` 并进帧列表（不新增任何宿主/协议改动）

用户口径（本轮追问后确认）：**"全部纳入，按标尺刻度走"**——
即未加载的轮次**也必须成为可漫游的一格**，总数与标尺刻度一致；
代价是这些格子只带投影里的**预览**（`PROMPT_PREVIEW_LIMIT = 50`），不是原文。

**取数路径**（本轮的第二个关键发现）：`useProjection` **拿不到**——
它声明在 `ChatViewInjected`（`ui-chat/src/client/contract/slots.ts:132`）上，
只有 `conversation.view` 这一个 slot 会收到；本插件的 overlay 拿不到它。
但插件**已经**为 `loadThrough` 持有 session face，而

```
SessionFace = ISession & ObservableSnapshot<SessionSnapshot>
ISession          → readonly projections: ProjectionsFace      (session.ts:67)
ProjectionsFace   → faceOf(key: string): ObservableSnapshot    (session.ts:52)
```

**同一个 face 就能取到 `turnOutline`**，于是本轮：
**不新增 wire endpoint、不新增 slot、不动宿主行为、不改 `cordis.patch.yml`**。

合并策略有两条是**必须**的，都不是可选优化：

- **按 `turn` 排序合并，而不是前插**：窗口可能**从会话中间开始**，
  未加载的轮次因此**不一定都比窗口老**（前插会把第 5 轮排到第 1 轮前面）。
- **窗口已持有的轮次以窗口为准**：投影只有截断预览，
  若让投影帧覆盖已加载帧，一次"取回"会把**原文降级成截断文本**。

#### A.10.3 取回未加载帧：先翻页，再写草稿

"全部纳入"带来一个新问题：未加载帧的 `text` 是**截断预览**，
直接 `reuse()` 会把半句话写进输入框。所以 `Enter` 落在这类帧上时改为：

1. 记下该帧的 **`turn`**（不是 `key`——投影帧的 key 是合成的 `turn:2`，
   而同一轮加载后的帧用的是**节点 id**，两种拼法永远对不上；
   也不能用索引——翻页会插入帧，游标以下的索引全部位移）；
2. 向 `loadThrough(seq)` 请求该轮；
3. 帧列表变化后结算：找到**同一轮且 `unloaded === false`** 的帧，写**它的**原文；
4. 翻页也没带来该轮（压缩、会话切换）→ **什么都不写**——
   宁可不动，也不拿截断预览冒充用户的消息。

#### A.10.4 反向验证（本轮最重要的证据）

把修复 `git stash` 掉重跑，**5 条用例以用户描述的症状失败**：

| 用例 | 无修复时的实际值 |
| --- | --- |
| `counts the turns the loaded window does not hold, so the walk is not empty` | `历史第 0 / 0 条当前草稿` |
| `lets the quick chord summon a message the window has not loaded` | 草稿为空 |
| `keeps the loaded window authoritative for a turn the outline also names` | `0 / 1`（应为 `0 / 2`） |
| `drops a malformed outline entry rather than counting a frame it cannot page` | `0 / 0`（应为 `0 / 2`） |
| `pages a turn in before reusing it, so a preview never becomes the draft` | 直接写入截断预览 |

其中第一条的失败值 `历史第 0 / 0 条当前草稿` **与用户截图的文字逐字相同**——
这是本轮"复现→修复→反向验证"闭环里最硬的一条读数。

#### A.10.5 浏览器通道的诚实边界（不要误读为已覆盖）

本轮给浏览器通道加了 `A-13`，它断言的是**不变量**（总数 ≥ 标尺刻度数、
且总数 > 0），**并已在注释里写明它钉不住这次合并**：
夹具就是"窗口 = 整份日志"，投影补不上任何一条。
**实测确认**：把修复 stash 掉再跑，浏览器通道**依然 10/10 全绿**——
所以本次 bug 的**真正防线是 jsdom 的 5 条用例**，不是浏览器用例。
要在这条通道里复现空窗口，需要一个**长于单页的夹具**，目前没有。

> 教训升级版（A.8.5 / A.9.4 的同类第三条）：上一轮学到"只覆盖一条臂的用例，
> 另一条臂等于没被证明"；这一轮暴露出**更隐蔽的一种**——夹具本身太小，
> 于是**两条臂看起来都覆盖了，实际都落在同一条臂上**。
> 新增用例时必须问一句：**这个夹具真的能进入我要测的那条分支吗？**

#### A.10.6 本轮回归结果

- `pnpm run check`：**36 files / 791 passed + 1 skipped**，typecheck、
  构建（`lib\client.js` 837.3kb）、`verify:publish` 全绿。
- `tests/history-cursor.spec.tsx`：**78 passed**（+9）；
  `tests/history-frames.spec.ts`：**48 passed**（+10）。
- 浏览器验收通道 `history-jump.e2e.ts`：**10/10**（新增 `A-13`）。
- 覆盖率：新增分支（`pendingReuse` 的三条出口、`readOutlineTurns` 的窄化）
  均有直接对应用例，无 `v8 ignore` 新增。
- 临时探针已删除，仓库不留。

### A.11 第六轮实测：三条反馈（用户 2026-10-02 第四轮）

用户原话（三条一次给出）：

1. "进入ESC模式后，按ctrl + up或down 为何还是识别为 up 或 down？"
2. "即便不进入ESC模式，ctrl up 或down 是否起作用 在不同的会话中 不同。例如
   @Wheel Done复刻 by Space Bunny @继续TripleIME开发 完全不起作用，但ESC是对的"
3. "ESC模式 历史消息 希望实现 按键可在消息列表尽头循环到另一头的历史消息，例如：
   从历史第一条消息到了 最后一条之后，再按Ctrl up 就会回到 草稿（如果有的话）
   或者 历史第一条消息（如果没有草稿的话），请记录到唯一需求文档"

建档为 **A-15 / A-16 / A-17**（§8 A 清单）。第 3 条是**新需求**，前两条是**缺陷**。
下面三条根因都**读源码定位**，不是推测；每条都先给出**用户看到的现象**与
**代码里的那一行**的对应关系。

#### A.11.1 A-15：选择态下 `Ctrl+↑` 被整条丢弃（`history-keys.ts` 的行序问题）

`resolveIntent` 的**分支顺序**是这次的根因，逐行读出来的次序如下：

| 行 | 代码 | 作用 |
| --- | --- | --- |
| 173 | `const command = isCommandOnly(facts)` | `(metaKey \|\| ctrlKey) && !altKey && !shiftKey` |
| 176 | `if (env.foreignEditor) return undefined` | 外来输入框让位 |
| 179 | `if (command && facts.key.toLowerCase() === 'h')` | 面板快捷键 |
| 183-185 | `if (command && (facts.key === 'ArrowUp' \|\| facts.key === 'ArrowDown'))` | **快速 chord**，返回 `page: false` 的 `step` |
| 187-199 | `if (phase === 'idle')` | 空闲态：菜单/生成中让位；`Esc` → `enter`；否则 `undefined` |
| 207-222 | `if (phase === 'roaming')` | **选择态**，见下 |

选择态那一段的**第一行**（`:208`）是：

```ts
if (facts.ctrlKey || facts.metaKey || facts.altKey) return undefined
```

它在 `switch` **之前**，于是选择态下按 `Ctrl+↑` 的结局是：

- **`183` 行的快速 chord 确实会被走到，并且会先返回** —— 但前提是 `command` 为真，
  即 `(metaKey || ctrlKey) && !altKey && !shiftKey`。所以 `Ctrl+↑` 在选择态下**走的正是
  `183` 行**，而不是被 `208` 行丢掉；`208` 行只在**带 `Alt` 或 `Shift`** 时才轮到。
- 两条路径的**净效果相同**（都退化成"上溯一格"），但**原因不同**，这一点很关键：
  见下面 A.11.1.1 —— 真正让用户"觉得识别错了"的，是 `183` 行**返回的是 chord 语义**
  （`kind: 'step'` 且会走 `reuse` 写草稿），而**不是**选择态本该有的漫游语义。
- 结果：`intent === undefined` → `FrameCursor` 的 handler **直接 return**，既不
  `preventDefault`，也不做任何事。

**为什么用户读成"还是识别为 up 或 down"**：两个读法都指向同一个 bug。
`Ctrl+↑` 被丢弃时**没有任何反应**（用户看到的其实是"没反应"）；
而用户之所以怀疑"被当成 up/down"，是因为选择态下**裸 `↑` 是好的**——
同一个手势加不加 `Ctrl` 表现不同，最自然的解释就是"`Ctrl` 被吃掉了、当成裸方向键"。
**无论哪种读法，修法一致：选择态下把修饰键降级为裸方向键。**

修法（不改按键表，只补一条）：
- `roaming` 分支里，`Ctrl/Cmd/Alt + ↑/↓/PageUp/PageDown/Home/End` 与**同名的裸键同义**；
- 也就是说 `208` 行的"修饰键一律让位"要收窄为**只对非导航键生效**
  （可打印字符、`Tab`、`Enter` 等仍按原义让给输入框）。

#### A.11.1.1 为什么"识别为 up/down"这个描述其实是**准确的**（关键）

用户的原话是"为何还是**识别为** up 或 down"—— 这句话是**准确的**，只是原因比"没反应"更微妙：

- 选择态下按 `Ctrl+↑`，命中的是 `183` 行的 chord 分支，返回的 intent 与裸 `↑`
  **看起来一样**（都是 `kind: 'step'`、`direction: -1`、`page: false`）；
- 于是 `FrameCursor` 的 `case 'step'` 走的是**同一条**代码，`stepSlot` 一样、读数条一样；
- **差别只在"要不要 `reuse` 写草稿"**：选择态下漫游**不应该**写草稿（用户还在浏览，
  按 `Enter` 才提交），而 chord 分支的语义是"直接取回"。用户看到选择态的游标在动、
  但**行为与裸 `↑` 完全一致**，所以自然会问"那 `Ctrl` 到底起没起作用？"

**这解释了用户为什么用"识别为 up 或 down"而不是"没反应"来描述。**
修法因此不是"补一条 if"，而是**让选择态明确地、有区别地响应 `Ctrl`**：
选择态下 `Ctrl+↑` 应与裸 `↑` **逐帧等价**（这是用户要的"在两条历史之间跳"），
而 **idle 态**下 `Ctrl+↑` 才承担"直接写回草稿 + 环绕"的 chord 语义（A-17 的环绕正是写在
这一态上）。两态的差异必须**显式且被测试钉住**，而不是靠分支顺序的巧合。

> ⚠️ **上面这段是第六轮的结论，已被第八轮推翻。** 用户随后明确要求：选择态下 `Ctrl+↑/↓`
> **不应**跑方向键语义，而应跑"快速复用"。即**选择态与 idle 态的 chord 同义**，两态的区别
> 只在帧集合（A-19 第 1 条：chord 只走用户主动发起的帧）与游标归属上。以 **A-18 / §A.12.1**
> 为准；本节保留原文，用于记录"同一现象、两次相反解读"这件事本身。

#### A.11.2 A-16：不同会话表现不同 —— `frames` 为空时 chord 静默失败

先**排除**几个看起来很像的原因（都读过源码，不是猜的）：

| 假设 | 结论 |
| --- | --- |
| 别的插件抢先 `preventDefault` | ❌ 宿主 6 处 `document` keydown **全是冒泡阶段**（`Modal` / `Menu` / `SettingsRoot` / `ContextMeter` / `stat-dialog` / `ImageLightbox`），本插件是**捕获**，先到手 |
| `isForeignEditor` 误判输入框 | ❌ 输入框是 `[data-composer-input]`，一个 **contenteditable div**（`view-binding.ts` / `InputBar.tsx`），`tagName` 是 `DIV`，不是 `INPUT`/`TEXTAREA`/`SELECT` |
| 输入框 keymap 吞掉方向键 | ❌ `keymap.ts:79-86` 只在 `arbitrate(...) !== 'pass'` 时消费，而 `controller.ts:224-226` 在**菜单未开时返回 `'pass'`** |

真正的差异是**帧列表的长度**。链条：

1. `frames` 来自 `buildFrames(order, getNode, mode, outline)`；
2. `frameAtSlot(next, count)` 在 **`count === 0`** 时返回 `undefined`；
3. 落到 chord 分支的兜底 `restoreOwnDraft()`（`:426`），而它读的是
   `ownDraftRef.current` —— 这次漫游**从未覆盖过草稿**，所以它是 `undefined`；
4. `:430-433` 于是只调 `focusComposer()` 然后 **`return`**：
   **不写草稿、不报错、不给任何提示。**

也就是说：**帧为 0 时 `Ctrl+↑` 是一个静默空操作**，而 `Esc` 走的是 `enter` 分支，
**不读 `frames`**，所以照常进入选择态 —— 这正是用户描述的
"完全不起作用，但ESC是对的"。

那两个会话为什么帧为 0：它们是**长会话**（`@Wheel Done复刻 by Space Bunny`、
`@继续TripleIME开发`），窗口（`snapshot.nodes`）里已经没有 `kind === 'user'` 的节点。
A-13/A-14 的投影合并本应补上这些帧，但**只要投影那一路也拿不到**（`turnOutline` 尚未
投影、或该会话的投影未挂载），`count` 就是 0 —— 于是 A-14 修好的那条路在这里重新断了。
**这也解释了"会话不同表现不同"**：短会话窗口里有用户节点 → 有帧 → chord 正常。

修法（两条各自独立，都要做）：
1. **让空帧不再静默**：chord 在 `count === 0` 时给可见反馈（复用 A-12 的读数条语言，
   而不是什么都不做）；
2. **让 chord 与 `Esc`+`↑` 共用取帧路径**：`Esc` 能用而 chord 不能用，本身就说明两者
   的帧来源没对齐；选定"投影缺失时 chord 也去问一次 `loadThrough`"或"明确提示不可用"，
   并把该不变量钉进测试。

#### A.11.3 A-17：首尾循环（新需求，必须实现）

用户口径逐字拆解：

| 场景 | 期望 |
| --- | --- |
| 走到**最旧**一条后再按 `Ctrl/Cmd+↑` | 回到**草稿位**（写回用户自己的草稿） |
| 在**草稿位**再按 `Ctrl/Cmd+↓` | 绕回**最旧一条**（两端的环绕互为镜像） |

> 用户原话里"草稿为空则回到历史第一条消息"这一句，实现时按**槽位模型**落地：环绕的落点就是**槽位 0**，
> 与草稿是否为空无关——草稿为空时那里就是一个空草稿。用户看到的正是"按键可以一直循环下去"这一行为，
> 需求本意已满足（见 §A.11.5 第 3 条与 §A.11.3 末尾对 `End` 的说明）。

这是**跨端环绕**，与现有 `stepSlot` 的"夹取"直接冲突：

```ts
const next = current - direction
if (next < 0) return 0
if (next > frameCount) return frameCount
return next
```

必须改成**取模环绕**（`(next + frameCount + 1) % (frameCount + 1)`，槽位总数是
`frameCount + 1`，因为**槽 0 是草稿**）。

**与既有契约的冲突必须显式处理**（这是本节最容易被写错的地方）：

- **A-12 / A-05 不能被循环顶掉**：`↑` 在**已加载窗口**最旧一条上，**仍要先尝试翻页**，
  循环是"确认没有更早历史之后"的**下一拍**。若把循环写成"到边界立刻跳另一端"，
  用户就**永远无法**翻到更早的历史 —— 这是比原 bug 更严重的回归。
- **`Home` / `End` 仍是边界跳转**（不循环）：它们是"跳到端点"，不是"步进"。
- **`End` 的语义冲突已自行消解**（本节第一版曾把它列为待统一项）：那一版按"草稿为空则回到最新一条"
  推断 `End` 要分叉成两种落点。实现确认**槽位模型里不存在这个分叉** —— 环绕的落点是**槽位 0，即草稿位**，
  与草稿是否为空无关（为空时那里就是空草稿，按键表里 `End` 本来就写作"当前聊天框"）。
  因此 `End` 保持**边界跳转**语义不变，按键表与单测**都无需改动**。
  这条值得留下：**一个"看起来需要统一"的冲突，可能只是因为把实现层的槽位当成了内容层的消息**。
- 循环**只在选择态**生效；idle 的快速 chord 落到草稿位后不再自动绕回（避免连按 `Ctrl+↑`
  无限打转、把草稿反复覆盖）。**注意**：这条限制的是"到达草稿位之后的下一按"，不是"禁止循环"——
  从 composer 起按 `Ctrl+↑` 仍会一路环绕（`wraps the quick chord as well as the roaming walk` 已覆盖）。

#### A.11.4 本轮的验收用例（已落地）

- A-15：`treats Ctrl+Up exactly like ArrowUp while roaming`、`treats Ctrl+Down exactly like
  ArrowDown while roaming`（同序列两种按法，读数条**字符串全等**，且 chord 不再写回草稿）、
  `walks on the chord with no modifier inside the walk, Escape included`（`Meta`/`Alt` 同样只算
  "噪声"）、`still keeps the chord non-navigational keys out of the walk`（`Ctrl+A` 不被吞）。
- A-16：`does not walk silently when there is no history at all`（帧为 0 时 chord 必须**可见**）、
  `reports the empty walk when roaming too, rather than freezing`；并把既有
  `walks a session with no history without crashing` 的断言从"当前草稿"改为 `history.empty`。
- A-17：`wraps from the oldest message round to the draft slot`、`wraps back to the oldest
  message from the draft slot`、`wraps the quick chord as well as the roaming walk`、
  `does not wrap a paged move inside one gesture`（`PageUp` 夹取）；A-12 的回归保护由既有
  `pages history back when the walk runs off the oldest loaded frame` 承担。

#### A.11.5 实现期实测：三条诊断各自被证据修正了一次

这一轮的三个 bug 都出现了"**第一版诊断只对了一半**"的情况，值得记下来，因为它们都是
"看起来已经修好"的典型：

1. **A-16 的修复位置比修复本身更重要**。空帧分支写在了 `next === state.slot` 守卫**之后**——
   而帧为 0 时槽位只有 0，`next` 恒等于 `state.slot`，守卫**永远先返回**，那段广播
   **一行都没执行过**。表现为"代码写了、测试仍然失败"。**教训：新增的兜底分支必须确认它
   排在所有会提前 `return` 的守卫之前**，否则它只是注释。
2. **A-16 的"可见反馈"不只是加一句话**。读数条整体由 `phase === 'roaming'` 把关，
   所以从 composer 按 chord 时**根本没有渲染位**。仅把文案塞进 `preview` 仍然什么都看不到；
   必须同时**进入选择态**才谈得上"可见"。且文案要**替换**而非叠加位置行——原来的
   `第 0 / 0 条 当前草稿` 正是用户误判"按键坏了"的原因。
3. **A-17 的环绕方向与直觉相反**。槽位是 `0 = 草稿`、`N = 最旧`，故"从草稿 `↓`"环绕到的是
   **最旧一条**而不是最新一条（与"从最旧 `↑` 环绕到草稿"对称）。第一版用例按直觉断言
   "回到最新一条"，被实现如实纠正。这一条已写进用例注释，避免下次再按直觉改回去。
4. **环绕必须先于它检测边界**。`atEdge` 若直接写成 `clampSlot(...) === state.slot`，
   在**草稿端**（槽 0 向下）也成立，于是"最旧端翻页"的逻辑会在错误的按键上触发；现已改为
   显式比较并加 `state.slot > 0`。
5. **`pageTriedRef` 是环绕能落地的前提**。带 loader 时同一槽位连按两次是"先翻页、后环绕"
   两拍，必须记住"这一端已经请求过翻页"；否则要么永远重复请求同一页（永远到不了环绕），
   要么在无 loader 时立刻环绕而**顶掉 A-12**。该 ref 在任何实际移动后清零，因此二次到访仍会翻页。

另有两条**既有用例**因为它们固定的是旧语义而必须改写（这不是迁就实现，而是需求变更）：
`keeps walking back through older messages` 与 `stops at the oldest loaded frame when the
client has no jump loader` 原来断言"到最旧一条后按键无反应"，现按 A-17 改为断言"环绕到草稿"；
`does not re-write on every extra quick-chord press at the oldest frame` 改为断言**复用内容
不重复**（环绕到草稿位后写回的是用户自己的草稿，不算重复复用）；`clamps the cursor when the
history shrinks under it` 改用 `Home` 到达最旧一条，避免连按 `↑` 被环绕带走。

关于**测试夹具**的一条老教训在这一轮再次生效：`mountPair()` 默认**不带 `loadThrough`**，
而"边界先翻页"与"边界直接环绕"**在同一个按键上是两条不同分支**。因此
`keeps the highlight on the oldest frame when roaming past the top` 与
`says so when the walk is parked at the oldest loaded frame` 必须**显式挂一个 loader**，
否则它们测到的是环绕分支，却以为自己测的是"到边界不动"。**夹具不够具体，两条臂会落到同一条上。**

#### A.11.6 第六轮 bug 的测试覆盖：单元 / 集成 / 端到端三条道

用户第七轮的问题是"最近的 bug 反馈都补充了单元测试和集成测试了么"。审计结论：**三条 bug
的单元测试当时就已齐全**（A-15 三条在 `history-keys.spec.ts`，A-16 / A-17 共十一条在
`history-cursor.spec.ts`，见 §A.11.4），**缺的是端到端这一条道**——三条全都没有浏览器级证据。
本轮补齐，端到端由 `apps/web/tests/history-jump.e2e.ts` 的第二个 `describe`
承担（连同新的多页夹具 `snapshots/web/history-walk`）。

**为什么要新造夹具**：这条道原有的每一个夹具都只有 **4 轮 = 一页**，而在"整个会话已加载完"
的窗口上走，**永远走不出已加载边界**——而 A-17 恰恰就是"走到边界那一下该怎么办"的规则，
A-15 的症状也只有在游标真正逐格移动时才出现。新夹具 24 轮，是这条道能验证这三条的前提。
证据：同一个 `↑` 序列在旧夹具上停在 `4 / 4`，在新夹具上走满 24 格后环绕到 `0 / 24`。

**三条各自拿到了什么**（诚实口径，不夸大）：

- **A-15**（`A-15: while roaming, Ctrl+Arrow moves like a bare Arrow and never hijacks the draft`）：
  浏览器只能验证**行为**——漫游态下 chord 与裸方向键走出同一序列，且**不写回草稿**。
  "修饰键被降级"这个**语义**决定在 `resolveIntent` 里，仍然只能由纯函数单测证明。
- **A-17**（`A-17: the walk crosses every frame, then wraps round to the draft slot`）：
  走满 **24 格**（`expect(keys.length).toBe(24)`）后环绕到草稿位，读数条出现 `Current draft`，
  再按 `↓` 回到历史。这是三条里端到端证据最强的一条。
- **A-16**（`A-16: the chord is never a silent no-op — it recalls a message or says why not`）：
  **零帧这一臂在浏览器道里造不出来**——A-13/A-14 把会话级 `turnOutline` 折进来，正是为了让
  "窗口里没有用户节点的会话"也能出帧（这就是"`0 / 0`"那个 bug 被修掉的性质）。所以零帧臂
  **仍然钉在 jsdom**（`does not walk silently when there is no history at all`、
  `reports the empty walk when roaming too, rather than freezing`）；浏览器道证明的是**较弱
  但真实**的契约：从 composer 按 chord **永远不会是静默空操作**——要么取回一条消息，要么
  读数条给出 `Oldest loaded` / `Current draft` 的可见答复。

**为 A-16 / A-17 改写既有用例的地方**（不是迁就实现，是需求变更后旧用例固定了旧语义）：
A-10/A.9、A-13、A-04b、A-04c 都写死了"**按一次就动**"。A-17 生效后这句话不再成立——边界上
的第一拍按设计**被翻页花掉**，只有紧随其后的一拍才移动。这四条改为"**按到断言的效果出现
为止，只在始终不出现时失败**"，因此它们不再依赖**前一条用例把游标留在哪个槽位**。
顺带记一条本轮的教训：A-13 与 A-04b 都是**单独跑必过、整套跑偶发失败**，根因正是这个
跨用例的状态继承——**一条从前一条用例继承状态的探测，测的是前一条用例**。

**端到端实测**（`D:\deepseek-harness`，`DSH_SNAPSHOT=replay npx vitest run --config
vitest.web.config.ts apps/web/tests/history-jump.e2e.ts`）：**13 个用例全绿，连跑 4 次全绿**
（此前 10 条为既有，3 条为新增）。夹具与用例已在 harness 检出中以提交 `5a28323dea` 落地，
不再只存在于工作区。

---

### A.12 第八轮实测：三条旧验收通过后的两点新口径（用户 2026-10-03 第五轮）

用户先把三条**已实现的**验收逐条确认通过：

> 1. 验收通过
> 2. 验收通过
> 3. 验收通过

紧接着提出两点，建档为 **A-18 / A-19**（§8 A 清单）。第一条（a）是**口径反转**——它推翻了
A-15 的结论；第二条（b）是**新需求**，含一个新增持久化设置。**两条都必须先改文档再改代码**，
因为 a 与 A-15 在同一处代码上给出相反结论，谁先谁后不能靠记忆。

#### A.12.1 A-18：选择态下 chord 不是"降级"，而是"另一套语义"（推翻 A-15）

用户原话：

> 进入ESC模式后 ctrl up和down 为何还是起的 ESC模式的up 和down的功能？

这句话在字面上**与 A-15 的原话几乎相同**（"进入ESC模式后，按ctrl + up或down 为何还是识别为
up 或 down？"），但**诉求相反**，这一点是本轮最容易搞错的地方：

| 轮次 | 用户问的是 | 期望 |
| --- | --- | --- |
| 第六轮（A-15） | "为何还是识别为 up 或 down" | 认为选择态下 chord **应当等于**裸方向键 |
| 第八轮（A-18） | "为何还是起的 ESC模式的 up 和 down 的功能" | 认为选择态下 chord **不应**跑方向键语义，应跑**快速复用** |

两句话都在问"为什么 chord 表现成方向键"，但 A-15 把这个现象当作**修正目标**（把 chord 收窄回
导航键），A-18 把它当作**缺陷**（chord 丢了自己的语义）。**第八轮的口径为准**：两条功能各自
保留自己的语义，互不侵占。因此 A-15 落地时加的那条"选择态把修饰键降级为裸方向键"的闸门要
**撤掉**，选择态的 `Ctrl/Cmd+↑/↓` 回到 chord 分支（`page: false` 的 `step`，走 `reuse` 写回草稿）。

这里有一条**值得单独记下的教训**：A-15 当时的诊断本身没错（读源码确认 chord 分支排在
`phase === 'idle'` 之前，选择态下也命中该分支），错的是**从"用户描述了现象"推断出"用户要修掉
这个现象"**。用户描述的是"它表现成了 A"，而用户想要的可能是"它应该表现成 B"——**现象描述不是
诉求**。A-15 的验收条目据本轮回写（改口径，不是删条目）。

#### A.12.2 A-19：两条功能的帧集合、游标归属与"智能跟随"

用户原话（一段话里含三件独立的事）：

> ctrl up 或down 是在用户发起的历史消息（但不包括系统主动发起的 轮次，因为用户并没有主动
> 发消息）之间循环，以方便用户复用之前的消息，因此循环时要预先过滤掉 系统发起的消息；
> 而 ESC模式主要是为了跳转到任何类型的历史消息（包括系统主动发起的），以方便用户查看该历史
> 消息附近前后的记录；同时，无论用户手动移动了什么不同的页面，两个功能都是按自己内部的
> 当前位置来处理；除非在设置里面设置了智能跟随（也就是内部的当前位置会随着用户对页面的
> 滚动或点击右侧标尺栏直接到达后的当前位置来智能判定内部的当前位置是什么）

拆成三条，各自可验收：

**1. 帧集合不同（快速 chord 只走"用户主动发起"的帧）**

这一条把 §2 的"帧"定义又收窄了一层，且**与 A-13 的合并逻辑直接相关**：

| 功能 | 帧集合 | 理由（用户给的原话） |
| --- | --- | --- |
| 快速 chord（`Ctrl+↑/↓`） | **仅** `source.kind === 'user'` 的帧 | "在用户发起的历史消息之间循环，以方便用户复用之前的消息" |
| 选择态漫游（`Esc` 后 `↑/↓`） | **全部**帧（含系统/插件发起） | "跳转到任何类型的历史消息，以方便用户查看该历史消息附近前后的记录" |

要点：**过滤必须发生在循环之前**（"循环时要预先过滤掉"），即先算出该功能的帧集合，再在该集合
上环绕。若先环绕再过滤，会出现"跳到一格、发现它被过滤掉、再跳"的抖动，且环绕的**周期**会算错
（`frameCount` 必须是**过滤后**的长度，否则 A-17 的首尾循环会在被过滤的帧上停一拍）。
注意 `@`/`/` 注入的上下文（`source.kind === 'plugin'`）同理不属于"用户主动发起"。

**2. 游标各自独立（"两个功能都是按自己内部的当前位置来处理"）**

- 两条功能**各有自己的游标**，互不覆盖。
- "用户手动滚动了页面"**不改变**任一功能的内部位置。
- "点了右侧标尺栏（`TurnNavigator`）跳到某处"**同样不改变**任一功能的内部位置。
- 因此：用户滚动到会话中段之后按 `Ctrl+↑`，取回的仍是**该功能自己游标的上一条**，而**不是**
  "屏幕上当前可见处"的上一条。

**3. "智能跟随"设置（唯一例外）**

- 设置里开启后，内部位置才**随用户的滚动 / 标尺栏跳转**同步判定。
- 默认**关闭**（默认口径就是第 2 条的"各自独立"）。
- 这是一个**新增的持久化设置字段** → 必须走 §7.1 的**六处规则**（`src/contract.ts` 的接口
  **和** update 联合、`src/settings.ts` 的 schemastery、`src/index.ts` 的 Host update 分支、
  `src/client/index.ts` 的写动词、`SettingsSection.tsx` 的设置行），漏一处就**静默失效**。
- 需要一个新的**滚动/跳转位置信号源**：`TurnNavigator` 的点击（标尺栏）与聊天区的滚动位置，
  都要能回传"用户当前看到哪一轮"。开启跟随 = 把两个功能的游标**吸附**到这个位置；关闭 = 不读。
- 边界：跟随**只在用户主动移动视口时**判定，不得因为本插件自己调用 `scrollIntoView`
  而反过来改写游标（否则漫游会自我追逐、停不下来）。

#### A.12.3 与既有条目的一致性核对（本轮回写的地方）

- **A-15 改写**：由"修饰键降级"改为"两条功能各自保留语义"。诊断结论（chord 分支的位置）
  保留，作为 A-18 的实现依据。
- **A-16 不受影响**，且被 A-19 第 1 条**互相印证**：长会话里 chord 不起作用，正是因为分页后
  窗口内没有用户节点、用户帧为 0。区别在于 A-16 的修法是"无帧时必须给可见反馈"，
  A-19 第 1 条进一步规定"chord 的域本来就只是用户帧"。
- **A-17 的环绕族**要分两份：`stepSlot` 的 `size` 必须按**各自的**帧集合长度算，不能共用。
- **A-13/A-14 的 `turnOutline` 合并**仍然必要（选择态要看全部帧），但**不能**直接喂给 chord。

---

### A.13 第九轮实测：A-18/A-19 验收通过后的五点新口径（用户 2026-04-10）

A-18/A-19 三条实现完成后，用户提出五点，逐条建档为 **A-20 ~ A-24**（§8 A 清单）。
本节的原始诉求逐字保留，实现与验收结论回写到各条目。

#### A.13.1 A-20：漫游到系统发起的帧时，提示栏必须标注"系统"及其文字

用户原话：

> "ESC模式下 如果跳转到 系统发起非用户发起的消息 ，在提示栏也要显示标注为系统及其文字，
> 不要像现在一样是空白"

**问题定性**：这是 A-19 第 1 条的**直接副作用**，属于回归。A-19 给 `HistoryFrame` 加了
`authoredByUser` 以支持 chord 的过滤，但**漫游提示栏（`RoamView`）没有跟着用它**：漫游走到
一个系统发起的帧时，`RoamView.preview` 取的是 `frame.text`，而系统帧的文本来自
`system/message` 事件——它的 `prompt` 在投影里是空串（`session-turn-outline/src/projection.ts:110`
只在 `source.kind === 'user'` 时记 prompt），于是提示栏显示一个**空格子**。

**关键区分（必须写进实现注释）**：`authoredByUser === undefined` 的含义是"**没有 source 可读**"
（未加载的帧、或该 build 不带 source），**不是**"非用户发起"。因此：
- `authoredByUser === false` → 确定是系统/插件发起 → 标注"系统"
- `authoredByUser === undefined` → 未知 → **不要**标注"系统"，按原有文案走

**验收**：
1. 漫游走到系统发起的帧，提示栏显示"系统"标记 + **该轮次的文字**（不能是空白）。
2. `authoredByUser === undefined` 的帧**不**被标注成"系统"（防误标）。
3. 系统发起的帧仍可被漫游到达（A-19 第 1 条的反面：漫游保留全部帧）。
4. chord 仍然**跳过**系统帧（A-19 第 1 条不被本条破坏）。

#### A.13.2 A-21：chord 去掉首尾循环；并在刷新/新消息后重置内部位置

用户原话：

> "Ctrl up 和 down 去掉 首尾循环；且刷新页面或用户 发起新消息后 都将内部位置重置，
> 以确保用户复用文本的起点始终是当下的初始位置（草稿位置）"

两件事：

**（1）去掉 chord 的首尾循环。** 这与 **A-17** 直接冲突，**以本条为准**：A-17 的"到头绕到另一头"
仍然适用于**漫游**（`↑`/`↓`），但 **chord 走到头就停住并说明**，不再绕回。理由是用途不同：
漫游是"逛"，绕圈符合直觉；chord 是"复用"，绕回会把用户送到一个离当前位置最远的消息上，
与"取回上一条"的意图相反。

**（2）内部位置在两种时机重置**：
- **刷新页面**（组件重新挂载）→ 回到草稿位。
- **用户发起新消息**后 → 回到草稿位。

第 2 点的口径是"**复用文本的起点始终是当下的初始位置（草稿位置）**"——用户发完一条消息，
下一条 chord 应当从最新的那条历史开始，而不是接着上次游标的残留位置。

**注意与 A-12/A-17 分页的交互**：chord 走到头时仍然要先**花掉一次按键去分页**
（`pageTriedRef` 的既有契约），只有"分页也试过了"才停下说话。否则长会话里 chord 会在
分页前就报"到头"，把 A-12 又改坏。

**验收**：
1. chord 走到最旧帧后，再按**不绕回**最新帧，而是给出"到头"的可见反馈。
2. 漫游仍未受影响 —— `↑`/`↓` 到两头**照旧环绕**（A-17 对漫游继续有效）。
3. 刷新页面后按 chord，第一次就落在**最新**的用户帧。
4. 用户发一条新消息后按 chord，第一次同样落在**最新**的用户帧（不是残留位置）。

#### A.13.3 A-22：设置里删掉"也可直接用 Ctrl+↑/↓"这类文案

用户原话：

> "设置里 '也可直接用Ctrl+1/1。' 的文字去掉，因为不符合最新两个功能都是独立的快捷键的原则"

A-18/A-19 之后两条功能是**独立语义**，文案里再写"也可直接用 Ctrl+↑/↓"会让用户以为
它们等价。**所有暗示两者等价的文案一并删掉**，不只是这一句。

**验收**：设置面板中不再出现任何"等价/也可以"式描述两条快捷键关系的文案（中英两套 locale 都要清）。

#### A.13.4 A-23：设置里两条功能的设置必须分组，不能混在一起

用户原话：

> "设置里 两个功能的设置应该分开，如果两个功能都有设置的话；不要混在一起，用户容易弄混淆"

**现状问题**：现有设置行（历史跳转开关、粒度 `historyJumpFrames`、复用模式
`historyJumpReuseMode`、智能跟随 `historyJumpSmartFollow`）**平铺在同一张卡片里**，
但它们的归属不同：
- **ESC 漫游**：开关本身。
- **Ctrl+↑/↓ 快速复用**：复用模式（`replace`/`append`）。
- **粒度** `historyJumpFrames`：**两者共用**（它是"一格是什么"的定义）。
- **智能跟随**：**两者共用**（它是"位置从哪来"的定义）。

因此分组口径是**三组**，不是两组：「共用」「ESC 漫游」「Ctrl+↑/↓ 快速复用」。
共用的两项要显式说明"对两者都生效"，否则用户仍会猜。

**验收**：设置面板里能看到清晰的分组标题，每条设置归属明确；共用项标注"两者都生效"。

#### A.13.5 A-24：智能跟随打开后容易卡死——查日志或补有效日志

用户原话：

> "智能跟随打开后 ，容易卡死 ，请查日志或补充有效日志"

**这是本轮唯一的疑似缺陷，优先级最高，且尚未定位。** 处理顺序：
1. **先看有没有日志**：读 DSH 的运行日志（不是猜），确认是崩溃、ANR、还是纯性能。
2. **没有日志就补日志**：在智能跟随的滚动回调里加**有界**的诊断点（节流后的计数、耗时），
   **并先自我审查性能**——这条路径的可疑点非常明确：
   - `scroll` 是**高频**事件，捕获阶段监听 + 每次 `querySelectorAll` + 每行
     `getBoundingClientRect()` 会**强制同步布局**（layout thrash）。一屏行数 × 每个滚动帧
     = 每帧几十次布局，长会话下足以卡死。
   - 回调里直接 `setSlot`/`setQuickSlot`：滚动过程中连续 setState 会触发连续重渲染。
3. **定位后的正确做法**（预判，待实测确认）：**节流到 `requestAnimationFrame`**
   （每个动画帧最多算一次），并让位置计算**只读一次**布局。

**验收**：
1. 能说明卡死的**机制**（不是"好像好了"）。
2. 开启智能跟随、长会话里连续滚动**不再卡死**。
3. 补上的日志**有界**（不会自己变成新的性能问题），且默认不刷屏。

#### A.13.6 与既有条目的一致性核对（本轮回写的地方）

- **A-17 的环绕族被 A-21 拆开**：漫游继续环绕，chord 不再环绕。§4.2 的"到两头环绕"一行
  必须改成分别描述，不能只写"环绕"。
- **A-19 第 1 条与 A-20 是同一处的两面**：过滤（chord）与标注（漫游）。A-20 的"系统"标记
  正是 A-19 过滤掉的那些帧在漫游侧该有的显示。
- **A-19 第 3 条与 A-24 是同一处**：智能跟随的实现就是 A-24 要查的那段代码。A-24 定位出的
  性能问题若属实，会**回写** A-19 第 3 条的实现说明。
- **§7.1 设置表要重排**（A-23）：按"共用 / ESC 漫游 / 快速复用"三组。
- **§4.2 表格的"选择态 | Ctrl/Cmd+↑ Ctrl/Cmd+↓"一行**在 A-21 之后还要补一句"走到头不环绕"。

### A.14 第十轮实测：漫游到未加载帧时页面不动（A-26）（**已实施并通过验收**）

用户原话：

> "ESC模式下 当前位置移动到 下一条 系统消息时，为何页面没有跟着变化，没有就像
> 移动到下一条 用户消息会页面跟着变化一样？请核对"

**这不是"系统消息"特有的分支，而是"未加载帧"的问题**，系统消息只是最容易踩到它的那一类。
根因在**帧的 key**：仅存在于 outline（会话总览投影）里的帧，其 key 是合成的 `turn:N`
（`src/client/history-frames.ts`），而**没有任何一个消息行带这个 key**——真正的行带的是节点 id。
于是 `scrollFrameIntoView` 的 `querySelector` 查不到元素，滚动**无声地什么都没做**，而提示栏
已经显示"走到了第 N 条"。用户看到的正是"游标动了、页面没动"。

**为什么偏偏是系统消息**：投影只在**人类消息**上记录 `prompt`（A-20 的同一处根因），所以
系统发起的回合 `prompt` 为空——它既是 outline 里最可能只剩一条投影的帧，也是唯一
"预览为空、什么都看不到"的帧。两个症状同源。

**口径（用户选"都做"，并追加两条限定）**：

1. **把这一帧翻页进来，再滚动到它真正的行**。等页面落地后才滚动，因为那时才有行可滚。
   请求按**回合号**（turn）而不是节点 key 记账——翻页会插入帧，同一回合的已加载帧用的是
   节点 id，两种写法永远对不上（与 A-13 的理由相同）。
2. **仍然滚不动时要说出来**，不能继续静默。**但提示的范围要窄**：已加载帧找不到行是
   **正常情况**（虚拟列表、行还没画出来），每次都提示就变成噪音。可上报的只有两种：
   - 帧是**因为没有行才被翻页**的，翻完了**仍然没有行**；
   - 压根**没有翻页能力**（此构建没提供加载入口），这类帧无法显示。

   提示**只在提示栏出现**（用户选定），不做行闪烁。

**顺带修掉一个截断缺陷（新用例暴露）**：chord 直接沿游标复用、不走漫游那一步的翻页
（这正是 A-26 之后它成为**唯一**能落到 outline 帧上的手势的原因），而它对未加载帧
**无条件**调用 `reuse`——于是把投影的**有界预览**写进了输入框，用户拿到一条被截断的消息。
A-13 的守卫现在同样覆盖 chord。**这条不是用户报的，是实现期自查**，其价值在于说明：
A-26 的翻页把 A-13 的延后路径从常规路径上挤走了，于是它原来隐藏的那条分支才浮出来。

**实现要点**：

- `scrollFrameIntoView` 由返回 `void` 改为返回**是否找到了行**——降级路径（此构建没有锚点属性）
  必须能被上层区分出来，否则"降级"和"坏掉"长得一模一样。
- `RoamView` 新增 `offscreen`，**与 `edge` 分开**：`edge` 说"历史到头了"，`offscreen` 说
  "这一条在、但这个构建没有锚点可滚"。把后者报成前者，等于在历史没到头时告诉用户到头了。
- store 的按值比较**补上了 `tag`**（此前漏了）：两条帧可以计数与预览都相同而只有来源不同，
  系统回合的预览为空，于是从一条这样的帧走到另一条时，提示栏会留着上一条的来源标记。

**验收**：
1. 漫游到只存在于 outline 的帧（含系统发起的回合）时，**页面会跟着变化**——先翻页、再滚动。
2. 翻页后仍无行可滚，或此构建无翻页能力时，**提示栏说明原因**，不再静默。
3. chord 落到 outline 帧时**不得把截断预览写进输入框**。

回归单测：`pages an unloaded frame in, then scrolls to the row the page reveals (A-26)`、
`says so when the paged-in frame still has no row to show (A-26)`、
`defers the chord onto an outline frame, then writes the loaded text (A-13 + A-26)`、
`says so when the chord cannot page an outline frame in (A-13 + A-16)`。

---

### A.15 第十一轮：文件夹选择界面的键盘化（四项口径全做）（**已实施**；列表一侧的键位与验收已被 §A.18 修订）

用户原话：

> "默认展示当前工作区目录树，和 @ 的菜单界面一样，支持折叠和返回上级目录"
> "焦点在一个可编辑的路径输入框，路径文本全选"
> "编辑后 Enter 打开该文件夹；Esc 等于取消按钮"
> "↑/↓ 在目录树条目间移动；Enter 选中该文件夹"

领域不同（这一轮改的是**选择文件夹对话框**，不是会话历史游标），但要求同源：都是
"把纯鼠标界面变成能全程用键盘走完的界面"。分析文档见
`Specs/选择文件夹界面-键盘操作方案分析.md`（511 行，含现状实测、交互分析、键位表、
搜索性能实测、预设候选方案的取舍）。

#### A.15.1 现状（实测，不是推测）

对话框此前**一个键盘手势都没有**：没有任何 `onKeyDown`，焦点无处可去，`Tab` 能走到
对话框外的页面元素上，唯一的关闭方式是点遮罩或按钮。它与 `@` 菜单的差距不在功能而在
**入口**：`@` 菜单有折叠、有"上一级"、有盘符，而对话框只有一层列表。

#### A.15.2 键位表（用户拍板，口径 A）

| 键 | 路径行（初始焦点） | 列表 |
| --- | --- | --- |
| `↑` / `↓` | 离开路径行进入列表（**焦点一起走**） | 在当前层内移动高亮，**两端环绕** |
| `Enter` | **换层**：走到输入框里那条路径 | **走进**高亮的文件夹 |
| `Ctrl+Enter` | **采纳并关闭**（全对话框统一） | 同左 |
| `Esc` | 逐级退出：新建表单 → 编辑态 → 筛选词 → 关闭对话框 | 同左 |
| `Tab` / `Shift+Tab` | 在对话框内循环，**不逃到页面** | 同左 |
| `Backspace` | 文本编辑 | 有筛选词时删一个字符，否则**返回上级** |
| `Home` / `End` | 行首/行尾（文本语义） | 首行/末行 |
| 可打印字符 | 编辑路径 | **筛选当前层**（纯内存，无 I/O） |

**为什么把"采纳"单独给 `Ctrl+Enter`**：用户自己的分析指出，如果 `Enter` 在路径行是
"采纳"、在列表里是"进入"，同一个键就有三种含义，学不会。于是**采纳只有一条路径**
（`Ctrl+Enter`，加上"选择"按钮），`Enter` 在对话框里**永远只表示"往里走"**。

> **已被 A.18 修订（第十八轮）**：`Enter` 不再"永远只表示往里走"。A.18 让**分组行**（有子文件夹
> 的行、以及分组的头部行）用 `Enter` **原地展开/折叠**，**叶子行**用 `Enter` **采纳并关闭**；
> `Ctrl+Enter` 收窄为"采纳**分组**（它自己代表的那个文件夹）"。A.15.2 想消灭的"一个键多种含义"
> 因此换了形式回来：判定依据从"高亮在哪一行"变成"**这一行有没有子文件夹**"，所以行上的标记
> （`›` 折叠 / `⌄` 展开）必须如实预告"这是不是一个分组"。见 A.18。

#### A.15.3 默认位置：当前工作区所在盘的根

用户问过"默认工作区改为显示硬盘盘符、且默认在 C 盘，是否更好表达区外文件夹的概念"。
**实测否决了 C 盘**：本机工作区账本 `~/.dsh/storages/workspace.json`（版本 2，20 个工作区）
的盘符直方图是 `{"E:": 20}`——**100% 在 E:，C: 上一个都没有**。所以默认落在
**当前工作区所在盘的根**，盘符列表由该层的 `drives` 给出。

> **已被 A.18 取代（第十八轮）**：默认层改为**工作区所在文件夹的父目录**——先 `dirname(cwd)`，
> 够不着就逐级上退，全被拒才退到工作区自身；Windows 与 POSIX 用**同一架梯子**。"盘根"不再是
> 默认层（盘符行仍在盘根层出现）。理由是用户要看的恰好是"和工作区**平级**的那些文件夹"，
> 从盘根出发得多走一层才看得见它们。见 A.18.6。

**盘符根不是特例**：一个盘符根同时有自己的子目录，所以盘符是**该层里的一组**，
而不是**替换**该层的内容（早期的实现让它替换，结果是默认位置只看得见盘符、
看不见工作区所在盘自己的目录——已修）。盘符根没有 `parent`，这就是盘符"顶替"的东西。

#### A.15.4 预设候选文件夹

用户在分析期问"是否预设一些区外常去的文件夹"。数据源是**工作区账本**，不是
`~/.dsh/sessions/--<编码 cwd>--` 目录名——后者**是有损的**（25 个名字里认不全路径）。

新增 Host 方法 `atFile/recentFolders`，按"多可能被需要"分档排序：
`sibling`（同级）→ `parent`（上级）→ `child`（下级）→ `family`（**共享名字记号**）→
`recent`（最近打开）。`family` 档是实测逼出来的：`E:\Eason\Rust\DSH` 下有 39 个子目录，
其中只有 5 个是注册过的工作区——**34 个从未打开**，包括明显同族的 `dsh-at-file`、
`dsh-device-mirror`、`dsh-agent-presets`、`browser-use`。

**它有意不看 `allowsExternal`**：它只报用户**已经打开过**的文件夹，不是一次新的发现。

#### A.15.5 当前层关键词过滤（并**否决**整盘搜索）

键入可打印字符即在**当前层**筛选，**纯内存**：这一层已经在手上，不产生任何 I/O。
**筛选是"收缩"而不是"替换"**：上级、盘符、预设都是"跳到别处"，与关键词无关，因此
一起消失；该层里匹配的目录留下。

> **已被 A.18 修订（第十八轮）**：过滤仍然是"收缩"，但不再是"当前层纯内存"这一条：
> ① **预设组参与过滤**（输入有 needle 时「常用区外文件夹」分组被强制展开，并按 needle 过滤，
> 不再"与关键词无关地一起消失"）；② 编辑栏的**增量输入**会触发一次带防抖、可中止的
> `atFile/browse`（为了知道"输入的哪一段是最长有效目录"以及每个条目有没有子文件夹），
> **列表内的可打印字符过滤（`filter`）仍然是纯内存、不发 I/O**。见 A.18.5 与 A.18.6。

**整盘搜索被否决，依据是本轮实测**（`fd 10.4.2`）：

| 范围 | 耗时 |
| --- | --- |
| 工作区内目录 | 12 命中 / **32 ms** |
| `E:\Eason\Rust\DSH` 深度 2 | 120 命中 / 1719 ms |
| `E:\` 深度 2 | 73 ms |
| `E:\` 深度 3 | 36642 ms，**0 命中** |
| `E:\` 深度 4（默认忽略规则） | 28851 ms / 1 命中 |
| `E:\` 不限深度 | **>600000 ms，从未跑完** |

**系统级搜索也帮不上忙**：`WSearch` 在跑（Running/Automatic），但
`CrawlScopeManager\...\WorkingSetRules\*` 里每一条 URL 都是 `file:///C:\...`；用 ADO
`Search.CollatorDSO` 查 `'%atlas%'` 1070 ms 返回的**只有 C: 的命中**，
`WHERE System.ItemPathDisplay LIKE 'E:%'` 的结果是 **E: 命中 0 条**。
`es.exe` / `Everything` / `locate` / `plocate` / `mdfind` 本机**都不存在**。

所以"能想到的整盘搜索"在这台机器上要么慢到不可用、要么根本看不到用户的项目。
本轮的答案是**预设候选 + 当前层过滤 + 盘符浏览**三件套替代整盘搜索。

#### A.15.6 实现要点

- 焦点搬家是**功能性**的，不是装饰：`↑/↓` 离开路径行时必须把 DOM 焦点也移到列表，
  否则一个仍聚焦的文本输入框会**吞掉列表用来筛选的可打印键**（实现期实测：不搬焦点时
  筛选完全不触发，字符被输进了路径行）。
- **每一行都"走进"，没有一行"采纳"**。早期实现有一个"✓ 使用当前文件夹"的首行
  （采纳语义），它让"高亮在哪一行"决定了同一个键的含义——正是 A.15.2 要消灭的三义性；
  而且它使一次 `↓` + `Enter` 直接**采纳**而不是进入，是个陷阱。已删除。

> **已被 A.18 取代（第十八轮）**：A.18 里**叶子行**确实"采纳"了——但判据是**这一行没有子文件夹**
> （行上无箭头），不是"高亮落在第几行"。分组行依旧只"往里"，只有 `Ctrl+Enter` 能把分组自己落盘。
> 焦点交回编辑栏、拒绝是理由而不是异常这两条**沿用不变**；数据源从 `atFile/list` 换成
> `atFile/browse`（新增的 `hasChildren` 才是"是不是分组"的答案）。见 A.18.4。
- 焦点交接回输入框**试两次**（微任务 + 一帧）：对话框何时卸载是外壳的事，时机不由我们定；
  不交接的话焦点会落在 `body` 上，用户得先点一下才能继续打字——键盘流程的最后一步，
  也是最容易丢的一步。
- 拒绝是**理由**而不是异常：区外 / 已消失 / 不是目录，对话框用文字说明，而不是给一个空层
  （沿用 `FolderTab` 的 `error: 'outside'` 约定）。
- 数据源换成 `atFile/list`（而不是 `uiWorkspace.listDirectory`）：只有前者返回
  `drives`/`parent`/`error`，而产品的 `DirectoryListing` **没有** `drives`。

#### A.15.7 验收

1. 打开对话框后**不碰鼠标**即可走完：`↓` 进列表 → `↑/↓` 选 → `Enter` 进入 →
   `Ctrl+Enter` 采纳并关闭，焦点回到输入框。
2. 默认位置是**当前工作区所在盘的根**，且该层**同时**显示盘符与这个盘自己的目录。
3. 路径行**全选**，`Enter` 换层、`Ctrl+Enter` 采纳，二者不混。

> **已被 A.18 修订（第十八轮）**：路径行这一条**保持不变**（仍然全选、`Enter` 换层、
> `Ctrl+Enter` 采纳当前层，且是"`Ctrl+Enter` 唯一场景"的一个显式例外）；**列表**一侧改为
> "分组行 `Enter` 展开、叶子行 `Enter` 采纳"。新的验收见 A.18.9。
4. `Esc` 逐级退出，`Tab` 不逃出对话框。
5. 键入字符筛选当前层，**不产生 I/O**；无匹配时说明"没有匹配的文件夹"。
6. 预设候选含同级/上级/同族工作区，并按上述分档排序。

回归单测：`tests/folder-picker.spec.tsx`（51 条）与 `tests/recent-folders.spec.ts`（19 条）。

**一条测试环境的诚实记录**：行上的 `onPointerOver` 高亮**无法**用派发事件断言——
jsdom 没有 `PointerEvent`，React 在导入期就检测到并因此不派发合成指针事件（实测：在行上
和根容器上派发 `pointerover` 都不动，而直接调用 React 挂在节点上的那个 prop 会动）。
所以该用例**直接调用 React 附加的 prop**，并在注释里写明原因：断言派发等于在测 jsdom。

---

### A.16 第十二轮：再次点击同一对象 → 打开所属文件夹并选中它（**已实施，真机验收通过**）

用户原话：

> "任何同一对象，无论文件还是文件夹还是别的，只要点击一次之后，再次点击，都请
> 打开所属文件夹且当前选项放在该对象身上，分析技术可行后，补充到唯一需求文档"

用户随消息附上的两个引用就是两个样本：`@.github/workflows/release.yml`（**文件**）与
`@E:/Eason/Rust/DSH`（**文件夹**）。分析文档见
`Specs/再次点击同一对象-打开所属文件夹并选中-方案分析.md`。

**手势本身**：第一次点击 = 打开该对象（现行行为）；第二次点击**同一对象** = 打开它**所属的
文件夹**，并把选中项放在**它身上**。这是文件管理器里被验证过几十年的手势，价值在
**保留上下文**：第一次看内容，第二次看它在哪、和谁在一起，用户不必知道路径。
**判定的是"同一个对象"，不是"同一个位置"。**

#### A.16.1 可行性结论：可行，且机制已在框架里

| 需求的一半 | 机制 | 现状 |
| --- | --- | --- |
| 打开**所属文件夹** | `sidebarRight.openResource(address)` | 已有，本插件在用 |
| **选中项**放在该对象身上 | `openResource(address, { params })` → `tab.navigation.params` | **已有，本插件尚未用** |
| 「再次点击」的识别 | 客户端记住上次打开的对象 | 需新增（小） |
| workspace 内文件的情形 | 现走产品 `files` 树，而那棵树**无法指定选中行** | **唯一真缺口**（见 A.16.4） |

**两条决定性证据**（都读自 harness 源码）：

1. **`params` 是一等通道，且由类型拥有者声明**。
   `ui-sidebar-right/.../service.ts:122` 的 `SidebarRightOpenResourceOptions.params`
   注释写明"delivered as `navigation.params`"；`contract/params.ts:22` 的
   `SidebarRightResourceParamsMap` 是**空接口 + merge-extensible**，注释明确"filled by
   the package that owns that type"。`folder` 类型是**本插件自己注册的**，所以本插件有权
   给它声明参数（`select`）。
2. **重复打开同一地址，确实会把新参数送达**。这是最易出错处，`service.ts:361-368` 的
   `commit()` **无条件**调用 `tabDomain.navigate(sessionId, tabId, { address, params })`，
   即使它 settle 到的是**已存在的那个 tab**；`tab-domain.ts:130` 还会
   `revision + 1`。所以既**不会开出第二个 tab**，新意图也**不会被丢掉**。

#### A.16.2 「再次点击」不能靠双击事件

`ReferenceLinks.tsx:202` 现在有 `if (event.detail > 1) return false`——**双击的第二下被
主动丢弃**，这正是"再次点击没有任何反应"的直接原因。但需求**不该**用双击实现：
`detail` 由浏览器按 OS 时限（通常 500 ms）合成，用户慢慢点两次就**不触发**，且该值
**不可靠也不可测**。用户要的是"点过之后**再点**"，**没有时限**。

**所以判定由本插件自己记账**（记住上次打开对象的规范身份，复用既有 `referenceKey` 口径）。
但 `detail > 1` 的分支**仍需处理**，否则快双击的第二下依旧被吞——推荐形态：`detail > 1` 时
**不再无条件 return**，而是先查账，"还是刚那个对象"则执行第二次语义，否则照旧忽略
（以保护拖选文本）。**快双击该不该生效需用户拍板**（见 A.16.5）。

**用户已拍板（`m02489`）：「A.16.2: 不应该靠快速双击」**——实现**不得**依赖 `detail` 的合成与
OS 时限，判定只由本插件自己的账本决定，因此**快点和慢点必须一视同仁地生效**；`detail` 不再是
闸门，`detail > 1` 只作"这一下可能已经记过账"的提示，是否执行第二次语义**只看账本**。

#### A.16.3 选中项走 `params`，**不走**地址查询串

把选中项塞进 URL（`folderAddress(path) + '?select=x'`）看起来更省事，实测**三条理由否决**：

1. **路由用 picomatch 匹配完整地址**（`tab-registry.ts:206-215`）。实测查询串
   **目前碰巧仍匹配** `dsh-resource://folder/**`（`**` 吞掉一切），但**这是巧合不是契约**：
   一旦模式收紧，匹配会**静默失败**，症状正是"点击不再有任何反应"。
2. **`folderPathOf` 会把查询串解码进路径**（`reference-links.ts:202-211` 对每一段都
   `decodeURIComponent` 再拼回），查询串没有独立解析步骤，会变成一个不存在的目录名；
   要修就得污染这个现在很干净的函数。
3. **`params` 就是为此存在的**：类型化、有 `revision`、由框架负责投递，再手搓字符串协议
   是重复实现且丢掉类型检查。

#### A.16.4 唯一真缺口：workspace 内的文件

上述机制对**文件夹**、以及**能自己决定选中行的 tab**（本插件的 `folder` 类型）都成立。
唯一不成立的是 **workspace 内的文件**：它走产品的 `openTab('files')`，而
`ui-sidebar-files` 是**声明不了参数**的 PAGE（`patterns` 为 `undefined`），也**没有
reveal/select API**——现有注释（`index.ts:902-908`）已写明"cannot be told WHICH folder to
select"。出路：

| 方案 | 评价 |
| --- | --- |
| A. workspace 内文件也改用插件的 `folder` tab | 语义统一，但用户失去熟悉的文件树，**体验倒退** |
| B. **仅第二次点击时**改用插件的 `folder` tab | ✅ 第一次仍是产品文件树，语义与体验都保住 |
| C. 请框架给 `ui-sidebar-files` 加参数 | 长期正解，但改 `deepseek-harness`，超出本插件范围，**本轮不做** |

**推荐 B**，需确认"第二次点击换 tab"是否可接受（可能让 tab 栏多一个条目）。
**用户已赞同（`m02489`）**：workspace 内文件第二次点击改用插件的 `folder` tab（即方案 B）。

#### A.16.5 待用户拍板的五点

1. **快双击**（`detail > 1`）该不该生效？还是只让"慢慢点两次"生效？
2. **workspace 内文件**第二次点击**换成插件的 folder tab** 是否可接受（A.16.4 方案 B）？
3. **对文件夹本身**，"所属文件夹"= 它的**父目录**（点两次 `@E:/Eason/Rust/DSH` 打开
   `E:/Eason/Rust` 并选中 `DSH`）——这是最自然的读法，需确认。
4. **provider 条目**（`@skill:` / `@plugin:` / `@atlas:git`）是否包含在"还是别的"里？
   建议只对有路径的算。
5. **对象已失效**（`exists === false`）时：建议**仍然打开所属文件夹**（文件没了、文件夹
   还在），比静默更好。

**答复**（用户 `m02489` 原话：「A.16.5 ：1. 不应该靠快速双击 其他都赞同」）：

1. 快双击 ⇒ **不应该靠快速双击**：判定不看 `detail`、不看时限，快慢点击一视同仁。
2. **workspace 内文件**第二次点击换成插件的 `folder` tab ⇒ **赞同**（A.16.4 方案 B）。
3. **文件夹本身**的「所属文件夹」＝它的**父目录** ⇒ **赞同**。
4. **provider 条目**（`@skill:` / `@plugin:` / `@atlas:git`）不纳入 ⇒ **赞同**，只对有路径的对象算。
5. **对象已失效**时仍打开所属文件夹 ⇒ **赞同**。

#### A.16.6 实施面（不含 harness 改动，**已落地**）

- `reference-links.ts` 新增 `FolderSelectionParams`（`{ select?: string }`）、`owningFolderOf(path)`
  →`{ dir, select }`（目录一律归一成正斜杠：它既要与索引的键比较，又要经 `folderAddress` 变地址）
  与 `selectionOf(params)`（从 `unknown` 里防御式取 `select`）。
- `index.ts` 记账上次点击的对象：`lastClick = Map<SessionId, string>`，键复用 `referenceKey` 口径，
  **只对 `kind === 'file' | 'folder'`**（与 A.16.5 第 4 条一致），**per session**；第二次点击改开
  **所属文件夹**并带 `params.select`。
- **账本是翻转式的**：命中同一对象 ⇒ 记账被清除，于是**第三次点击回到第一次语义**（打开对象本身），
  之后再次点击又是"所属文件夹"。理由：手势成对出现，用户不会被困在第二种语义里；且只有"有 action
  可执行"的点击才记账，惰性引用（`plugin:`）不推进序列。
- 账本必须放在 face/闭包层而非渲染层：chip 的 `onOver` 会调用 `actionFor` 却**不执行**返回的 action，
  所以判定与记账都由 bridge 注入面持有（派生的 dock 行与聊天 chip 是**同一个对象**，共用一份账）。
- 所属目录的解析（`resolveOwningDir`）：绝对目录直通；索引里有条目 ⇒ 顶层对象取**它自己的父目录**
  （这正是索引条目的用途）；索引里没有 ⇒ 相对目录**保持相对**（Host 的 `atFile.list` 按会话 cwd 解析），
  但 `dir === ''`（顶层名）**不能**直接用 `''`——`''` 在 Host 侧是它的 browse root（会话可越界时是
  **文件系统顶层**），不等于 workspace，所以由索引反推出 workspace 根（`workspaceRootFromIndex`）。
- `openOwningFolder` **不做存在性检查**（A.16.5 第 5 条）：引用已失效时第一次点击被拒、第二次照旧打开
  它曾经所在的目录；无 Sidebar 或抛错时退回第一次语义，绝不把点击吞掉。
- `FolderTab.tsx` 读 `tab.navigation.params`，给命中行加 `.dsh_atlas_folderRowSelected`
  （`data-atlas-selected` + `aria-current="true"`），并**只滚一个滚动祖先**到可见（不用
  `scrollIntoView`——它会连带滚动所有可滚祖先，A.18 已吃过这个亏）。
- `ReferenceLinks.tsx`：`detail > 1` 不再无条件 return，先查账，"还是刚那个对象"则执行第二次语义，
  否则照旧忽略（以保护拖选文本）。第一次点击落在选区里的拖选结束仍被忽略。
- **不需要**新 Host 接口、新 slot、新服务、新资源类型。

**测试面**：`tests/reference-links.spec.tsx`（`owningFolderOf` / `selectionOf` / 5 个账本用例，
含"第三次回第一语义"与"落在选区里仍放行"）、`tests/folder-tab.spec.tsx`（命中标记与"只滚一个祖先"）、
`tests/apply.client.spec.tsx`（第二次点击的三条集成路由：文件带 `select`、文件夹开**父目录**、
引用已失效仍开目录）。新用例都做过**变异验证**（改坏实现后确实变红）。

#### A.16.6.1 真机验收（10/10，两次）与顺带修掉的截断缺陷

**验收环境**：宿主 Windows 上真实浏览器里的 GUI（`http://127.0.0.1:3080`），探针
`E:\Eason\Rust\DSH\.atlas-a16.mjs`（零依赖 CDP，只做手势与只读断言，**从不提交提示词**）。手势从
输入框下方的 dock 行发起：聊天里的 chip 要先发出消息才存在，`folder` 页签自己的行是导航而非打开，
dock 行是唯一能在真机上复现这个手势的表面。

**两次都是 10/10**：

- **决定性那次**（`ATLAS_FILTER=_adb_check`，报告 `E:\Eason\Rust\DSH\.a16-adb4.json`）对象是
  `E:/Eason/Rust/CLTools/_adb_check.py`——选它正因为它**被 200 项截断挡在页外**：`/tmp/rawlist.mjs`
  实测 `rawCount=200`、`dirsInRaw=10`、`filesInRaw=190`，`indexOf('_adb_check.py') = -1`。
- **默认过滤那次**（报告 `E:\Eason\Rust\DSH\.a16-def2.json`）顺带覆盖**文件夹**对象：
  `@/dsh-atlas`（目录）打开其**父目录** `E:/Eason/Rust/DSH` 并选中 `dsh-atlas/`，同样 10/10。

十条断言：① bundle 确是本轮构建；② 起点没有被选中的行；③ 该坐标上确实是目标 dock 行；
④ 第一次点击不留下选中；⑤ 第二次仍点在同一行；⑥ 打开的是**所属文件夹**；⑦ 选中的正是**该对象
本身**；⑧ 选中既有可见样式、又有 `aria-current`；⑨ 选中行确实带选中样式；⑩ 打开的文件夹**不是
对象自己**。默认过滤那次还额外证实了 A.16.5 第 3 条（文件夹 → 父目录）。

**顺带修掉的截断缺陷（新用例暴露，非用户报障）**：`src/files.ts` 的 `readDirectory` 把
`if (entries.length >= limit) { truncated = true; break }` 放在 `entries.sort(...)` **之前**，而
CIFS/NTFS 的 `opendir` 顺序**不是**名字序——`E:\Eason\Rust\CLTools`（2093 项 = 63 目录 + 2030 文件）
只取到 10 个目录 + 190 个乱序文件，目标对象**根本不在页里**，于是没有任何一行被标记（现象：第二次
点击确实打开了正确的文件夹，但"选中"看不见）。修法是**不靠运气也不靠滚动**：`atFile/list` 新增
`include` 参数，Host 侧用 `pinEntry` 把目标项 `stat` 出来并**钉在首页最前面**（`pinned: true`），
既有的 `entry.name === selected` 标记逻辑随即命中。空串 `''` 是"不钉任何东西"的哨兵（不用
`acceptsUndefined`：harness 的 `packages/typert/protocol/src/types.ts:245-246` 里缺失字段只有显式声明
`T | undefined` 才解码成 `undefined`）；取消信号参数由框架**注入在业务参数之后**
（`types.ts:287-292`），所以 Host 签名顺序是 `(agent, path, include, signal)`。真机证据：
`folderRows=201`（200 + 1 钉住行）、`marked=[{name:'_adb_check.py', y:79}]`（`y=79` 即页首，
说明钉住而不是滚动）。`pinEntry` 另有三条单测：被截掉的名字钉在首位；不存在的名字与 `''`、`'.'`、
`'..'`、含分隔符的名字（`'sub/kept.txt'`、`'sub\kept.txt'`）都**不钉任何东西**，而真存在的
`'deeper'` 钉成 `{name:'deeper', kind:'dir', pinned:true}`；中止信号那条**必须先挑一个证明不在首页的
名字**，否则会走"已在页中"的提前返回、根本到不了 `stat`（这正是它第一版假绿的原因）。

#### A.16.7 验收通过后：`folderOpen` 固定为「仅侧边栏」并隐藏设置卡（用户 `m02489`）

用户原话（`m02489`）：

> "A.16  如验收通过，就可将之前的   同时打开文件夹的设置（默认是不同时打开）   设置为不同时打开且 隐藏"

这里指的**就是本插件唯一的文件夹打开设置** `settings.folderOpen`——界面中文标签「点击文件夹时」
（`src/client/locales.ts:30`），描述「被引用的文件夹用侧边栏、本地（资源管理器）还是两者一起打开」，
三个选项「侧边栏 + 本地打开（默认）」/「仅侧边栏」/「仅本地打开」（`src/client/locales.ts:32-34`）。
它的**默认值此前是 `both`**，即"同时打开"（侧边栏与本地资源管理器**同时**打开）；用户要的终态是
**不同时打开**：**固定为 `sidebar`（仅侧边栏）**，并把这张设置卡片**从设置界面隐藏**。经确认用户
选定的固定值就是「仅侧边栏」，理由：A.16 的第二次点击本来就落在本插件的侧边栏文件夹页签上，
`sidebar` 与它同构，且不会再弹本地资源管理器。

落地口径：

1. **行为固定**：点击文件夹引用只走侧边栏，不再调用本地打开器；`folderOpen` 的存储值不参与决策。
2. **设置卡隐藏**：`src/client/SettingsSection.tsx` 里这张卡片（标题 + 描述 + 三个 `<option>`
   的 `<select className="dsh_atFile_folderOpenSelect">`）整体移除，界面上不再出现该设置。
3. **持久字段保留**：`folderOpen` 仍是持久字段、线缆 schema 不动（见 `AGENTS.md` 的"新增持久字段
   要碰六处"），但**其值不再影响行为**——即使存储里还是 `both` 或 `native`，点击文件夹也只开侧边栏。
4. **顺序**：A.16 在真机验收通过**之后**才做这一步（用户措辞："如验收通过，就可……"）。

#### A.16.8 实施记录（**已落地**，提交 `445dbd0`，纯客户端）

- `src/client/index.ts` 的文件夹分支不再读 `folderOpen`：先取 `resolveSidebarRight(ctx)`，拿到就按既有
  三分支路由（绝对地址 → `openResource(folderAddress(path))`；相对地址且侧边栏有 `openTab` →
  `openTab('files')`；否则退回 `openResource`），并置 `opened = true`；**只有**侧边栏不存在或抛错
  时才调 `openFolder(link.path)`（抛错仍 `console.error('[dsh-atlas] sidebar folder open failed:', error)`）。
- **为什么本地打开器没有被删干净**：`tests/apply.client.spec.tsx:943` 的既有用例「still opens a
  folder in a profile that mounts NO Sidebar at all」断言 `booted.openPath` 收到 `{path:'/ws/src'}`，
  并注明这是**已文档化的需求**——`@` 在没有 Sidebar 的 profile 里也必须能用。用户口径是
  「**不同时**打开」而不是「永远不开」；删掉兜底会让那种 profile 里的点击彻底失效。正常 profile 下
  侧边栏就是唯一出口。
- `src/client/SettingsSection.tsx`：整张 `label.dsh_atFile_card.dsh_atFile_cardSelect`（标题、描述、
  含三个 `<option>` 的 `select.dsh_atFile_folderOpenSelect`）删除，原地留 JSX 注释；随之删除局部
  `const folderOpen = settings?.folderOpen ?? 'both'`。**该 class 仍被两个历史设置 select 复用**
  （`historyJumpFrames`、`historyJumpReuseMode`），所以 class 与 CSS 都不能删。
- `src/client/locales.ts`：A.16.7 里列出的 5 个中文键（`settings.folderOpen`「点击文件夹时」、
  `settings.folderOpenDesc`、`.both`「侧边栏 + 本地打开（默认）」、`.sidebar`「仅侧边栏」、
  `.native`「仅本地打开」）与对应 5 个英文键一并删除（无任何测试引用）。
- **持久字段与线缆一律不动**（落地口径第 3 条）：`src/contract.ts:260` 的 `readonly folderOpen?:
  FolderOpenTarget`、`:307` 的 update union、`:501` 的
  `folderOpen: z.enum(['both','sidebar','native']).default('both')`、`:528` 的 update schema、
  `src/settings.ts:71`、`src/index.ts:257-258` 的 `else if (update.field === 'folderOpen')`，以及注入面
  上的 `setFolderOpen` 动词**全部保留**（值不再影响行为）。
- **测试面**：`tests/section.spec.tsx` 里「writes the folder-open choice through the injected verb」
  改写为「no longer offers the folder-open setting at all (A-16.7)」（页面文本不含该文案、
  `select.dsh_atFile_folderOpenSelect` 只剩 2 个即两条历史 select、`setFolderOpen` 不被调用），
  另两条历史 select 用例的下标与 disabled 断言随之调整；`tests/apply.client.spec.tsx` 四条集成用例
  改写为"**无论存储值是什么**都只在侧边栏打开"（其中一条仍写 `setFolderOpen('native')` 钉住"值不参与
  决策"），"工作区外绝对地址"那条不再断言本地打开。
- **变异验证**：把 `if (!opened) openFolder(link.path)` 改成恒真后，`tests/apply.client.spec.tsx`
  **恰好 3 条转红**（`opens a directory row in the sidebar and NOT locally (A-16.7)`、
  `opens a folder in the sidebar alone, whatever the stored setting says`、
  `asks the sidebar for an out-of-workspace folder by absolute address`，`3 failed | 74 passed`），
  证明这三条真的在守这个行为。
- `pnpm run check` 全绿：`Test Files 40 passed (40)`、`Tests 965 passed | 1 skipped (966)`、
  `verify:publish ok — 65 files`。发布到 guest 后两个 bundle `cmp` 一致，
  `grep -c 点击文件夹时 lib/client.js` = **0**（旧设置卡文案确实不在发布的 bundle 里），
  A.16 的 `data-atlas-pinned` 仍在（`pinned_rows=1`），两个服务 `active active`。
- **真机验证"设置卡已隐藏"**：探针 `E:\Eason\Rust\DSH\.a167.mjs`（零依赖 CDP，**6/6 通过**，报告
  `E:\Eason\Rust\DSH\.a167-find4.json`）从侧边栏底部 aria-label 为「设置」的控件进入设置页，在导航里
  点「文件提及」（`label: () => t('nav')`，`src/client/locales.ts:14`），断言：本插件设置页**确实挂上了**
  （`select.dsh_atFile_folderOpenSelect` 恰为 2 个，选项是两条历史设置的「每条用户消息（默认，含插话）/
  每轮对话（只取该轮第一条）」与「覆盖草稿（默认）/追加到草稿之后」）；**整页文本里不存在**任何文件夹
  打开文案（中文 `点击文件夹时`/`侧边栏 + 本地打开`/`仅本地打开`/`仅侧边栏` 与英文
  `When you click a folder`/`Sidebar + local`/`Sidebar only`/`Local only` 两组都查）；**0/2 个 select
  带文件夹打开选项**。**环境教训**：设置控件的坐标点击会被别的插件的浮层吞掉——诊断打出的
  `document.elementFromPoint(140,649)` 返回的是 `SPAN.omamusic-readout`（文本 `0:00 / 0:00`，
  OmaMusic 的浮标压在设置按钮上），所以探针最终用 DOM 点击兜底（`how:'dom-click'`）；这套 GUI 里
  坐标点击不可信，落地前必须查 `elementFromPoint`。

---

### A.17 第十三轮：Linux 端复现与五处缺陷的修复（**已提交并验证**）

用户原话（`/goal`）：

> 在 Omarchy VM（guest）里建立可运行的 DSH 环境，端到端复现并修复 dsh-atlas 文件夹选择
> 对话框在 Linux 上的缺陷：(1) guest 安装 Node 运行时并通过 git bundle 同步仓库跑起来；
> (2) 复现"看不到可选项"与"@ 之后搜不到"；(3) 修复已证实的 Linux 缺陷——`crumbsOf`
> 丢失根 `/`、默认浏览层在 POSIX 上落到工作区本身、索引失败静默降级为空数组（无可见
> 错误）；(4) 每处补上能抓到该缺陷的回归单测（先确认对旧代码变红），(5) `pnpm run check`
> 全绿后提交，并把结论与口径同步进唯一需求文档 `docs/history-jump.md`。默认浏览根口径：
> 与 Windows 盘根语义对称，Linux 用 `/`（若实测证明 `$HOME` 更合理则记录理由后采用）。

本轮在上一轮已提交的三个缺陷之外，**新发现并修复了第四个**（A.17.4 ④）；同一轮在真实
Linux 浏览器里做端到端验证时又暴露出**第五个**（A.17.9）。

#### A.17.1 环境与路线：为什么不是"在 guest 里跑 vitest"

- guest：Omarchy VM（`Linux 7.2.4-arch1-2`），Node **v26.8.2**（mise shims），pnpm 10.30.3。
- 仓库同步：宿主 `git bundle create x.bundle <oldSHA>..HEAD` → guest
  `git fetch /tmp/x.bundle && git reset --hard FETCH_HEAD`。
- 插件安装位：`/home/omarchy/.dsh/profiles/web/node_modules/@sidequest-007/dsh-atlas/`
  （v1.0.9，**真实目录不是软链**）。
- **路线选择**：在 guest 内跑本仓 vitest 需要一整套 Linux `node_modules`——宿主
  `node_modules` 只有 `@esbuild/win32-x64`，而 20 个 `@deepseek-ai/*` 依赖全是
  `link:../deepseek-harness/...`（`E:\Eason\Rust\DSH\deepseek-harness` 是指向
  `D:\deepseek-harness` 的 **junction**，经 CIFS 到 guest 不可靠）。故改用**独立 Node
  探针**：把 `tests/browse-root.spec.ts` 改写成纯 ESM 脚本，直接加载**已发布的
  `lib/index.js`**（新旧两份），在真实 Linux 文件系统上调用真实 `list()` 缝。
- 探针落盘：宿主 `E:\Eason\Rust\DSH\.atlas-probe.mjs`、`E:\Eason\Rust\DSH\.atlas-old-lib.js`
  （取自 `git show d0ccb85~1:lib/index.js`，**必须用 cmd 重定向**——PowerShell 的 `>` 写
  UTF-16LE 会让体积翻倍）；guest `/tmp/verify/` 内为 `probe.mjs` + `atlas-new.js` +
  `atlas-old.js`，`node_modules` 软链到
  `/home/omarchy/.local/share/mise/installs/node/26.8.2/lib/node_modules/@deepseek-ai/dsh/node_modules`。
- 构建产物**没有 default export**：要 `import * as plugin` 再用
  `plugin.inject` / `plugin.apply` / `plugin.DEFAULT_IGNORE_FILES`。

#### A.17.2 决定性实测（缺陷 ②，真实 Linux，旧包 vs 新包）

探针调用 `runtime.list(agentWith('/home/omarchy/Projects'), '', signal)`：

| 读数 | 旧包（`d0ccb85~1`） | 新包（`d0ccb85`） |
| --- | --- | --- |
| `path` | `"/home/omarchy/Projects"`（工作区自身） | `"/"` |
| `parent` | — | `<undefined>` |
| `drives` | — | `[]` |
| `entries` | — | 20 项（`bin` `boot` `dev` `etc` `home` `lib` …） |
| 退出码 | **1**（断言失败） | 0 |

这同时证明三件事：默认层确实落到工作区（旧）、修复后到 `/`（新）、以及 **`drives` 在
POSIX 顶层是被收集但为空 `[]` 而非 absent**（缺陷 ④ 的 fixture 依据）。同一探针的
"具名相对路径"与"无工作区拒绝"两例在**新旧包上都通过**，说明下降（进入子目录）能力
没有被这次修改破坏。

#### A.17.3 沙箱闸门：`/` 只在宽松会话里可达（**原结论已订正，见下**）

`src/runtime.ts:211` 的越界闸门是
`if (!isUnder(cwd, absolute) && !allowsExternal(access, absolute))`。

- **原记录（事后证明只覆盖了宽松会话）**：guest 的会话投影
  （`/home/omarchy/.dsh/storages/session_projcache/sessions/*.json`）里有会话是
  `sandboxMode = "danger-full-access"`（`3da1bdb2-…` seq 183、`session-44b699d3-…` seq 1224、
  `session-c7af0f8f-…` seq 277，cwd 均 `/mnt/EShare/Eason/Rust/DSH`；另一个 326 字节的废弃会话是
  `workspace-write` seq 2），于是 `externalAccess` 给出 `canDiscover: true`，`/` 不会被拦。
- **订正（第五处修复 A.17.9 之后才拿到的完整口径）**：`sandbox-policy` 的默认模式是
  `read-only`（`D:\deepseek-harness\packages\sandbox\sandbox-policy\src\index.ts:113`），而 guest 的
  `~/.dsh/settings.yaml` 与 `~/.dsh/cordis.yml` 里**没有任何 sandbox 配置**
  （`grep -rn sandbox /home/omarchy/.dsh/settings.yaml /home/omarchy/.dsh/cordis.yml` 无命中），
  即**没有 override 的会话就是只读**。实测：正在跑 GUI 的那个会话（workspace `/mnt/EShare`）
  里打开选择器，`path` 落在 `/` 并立刻得到
  `error: "outside"` / `这个文件夹在工作区之外，当前会话不允许访问。`，列表里**一个目录行都没有**。
- 所以"闸门不会把修复作废"这句话**只在宽松会话里成立**；在只读会话里，默认层 `/` 恰好是被拒绝的
  那一层，"把默认层从工作区改成 `/`"这一处修复反而把用户原始症状
  「看不到可选项」原样搬到了打开瞬间。**教训："某类会话能通过"不等于"闸门不成立"，投影里的
  宽松会话不能当成全部会话。**

#### A.17.4 四处缺陷的修复与"对旧代码变红"证据

| # | 缺陷 | 根因位置 | 旧代码变红证据 | 本机可复现？ |
| --- | --- | --- | --- | --- |
| ① | `crumbsOf` 丢失 POSIX 根 `/` | `src/client/index.ts:191`（修复新增 `:209` 的 `crumbs.push({ name: '/', path: '/', hidden: false })`） | 删掉 `:209` → `tests/posix-browse.spec.tsx` **7 例变红** | ✅ |
| ② | 默认浏览层落到工作区 | `src/runtime.ts:205` + `:275-277 browseRoot`（第五处修复后迁到 `:209` + `:288-293`，见 A.17.9） | **只能在 Linux 拿**（见下） | ❌ |
| ③ | 索引失败静默降级为空数组 | `src/client/source.ts:1980/2019-2022/2051-2058` | 退回 `d0ccb85~1` → `tests/source.spec.ts` **1 例变红** | ✅ |
| ④ | POSIX 顶层 `drives: []` 被当成盘符列表 | `src/client/FolderPicker.tsx:451`、`src/client/FolderTab.tsx:131`、`:159` | 退回两个源文件 → **4 例变红** | ✅ |

- **①** 变红的 7 例：`puts the filesystem root first, as a crumb that goes back to '/'`、
  `names the root the way the path line spells it`、`offers every ancestor of a real workspace
  in order`、`reaches the root from a mount path the user actually has open`、`renders the root
  as the first crumb of every level below it`、`clicks back to the root from three levels down`、
  `shows no crumbs at the root itself`。典型断言：`expected [ 'home' ] to deeply equal [ '/', 'home' ]`、
  `expected last "vi.fn()" call to have been called with [ '/', Anything ]`。
- **② 是本轮唯一必须在 Linux 上证明的一处，原因是一个真陷阱**：
  `tests/browse-root.spec.ts:69` 是 `if (process.platform === 'win32') return`，Windows 上该例
  **空跑并且被 vitest 记为通过**（无断言即 pass）——所以我实测"把 `src/runtime.ts` 退回
  `d0ccb85~1` 后跑 `tests/browse-root.spec.ts`"，结果是 `Tests 4 passed (4)` 的**假绿**。
  Linux 侧的真证据就是 A.17.2 的读数。**推论（已写入口径 A.17.7-4）**：平台特例用例的
  early-return 会把"没跑"伪装成"通过"，Linux 专有行为必须在真实 Linux 上跑过一次。
- **③** 变红断言：`names the reason the workspace index failed instead of reporting no
  matches` → `AssertionError: expected { name: '文件', icon: 'file', …(3) } to match object { …(3) }`；
  同一次运行里 `tests/apply.client.spec.tsx` 的 51 例**保持全绿**——即分类分支
  （`@file:`/`@folder:`）刻意保持"大声抛错"没有被削弱（由 `:247`/`:254` 钉住）。
- **④** 变红的 4 例 = 3 个新增 + 1 个既有：`a POSIX root lists destinations, not a drive list >
  offers no drive affordance at a POSIX top level`（`expected [ '盘符' ] to deeply equal []`）、
  `… > shows no crumbs at the root itself`（同一断言，补上 fixture 后才变红）、
  `the folder tab > shows no other-drives section at a POSIX top level, where there are none`
  （`expected <ul …(2)></ul> to be null`）、
  `… > still calls a POSIX top level empty when it has neither drives nor children`
  （`expected undefined to be '空文件夹'`）。

#### A.17.5 第四个缺陷为何躲过了既有 13 例：fixture 盲点

`tests/posix-browse.spec.tsx` 的 `LEVELS` 每个 level 只有 `path/home/crumbs/truncated/entries`
四个字段，**从不写 `drives`**，于是 `drives === undefined` 恒成立，盘符 / 其他盘符两个分支在
POSIX 侧**永不进入**。修复把 `/` 的 fixture 补成 Host 真实形状 `drives: []`（依据 A.17.2 的
实测读数），才让旧谓词 `drives !== undefined` 变红。**教训：fixture 缺字段 = 分支不可达 = 假绿。**

#### A.17.6 类型层面的一个坑（值得记住）

`(listing?.drives?.length ?? 0) > 0` 读起来最自然，但 **TypeScript 无法从"派生布尔值"里窄化
`listing`**，`tsc --noEmit` 直接报 `TS18048`（`src/client/FolderPicker.tsx(452,93): error
TS18048: 'listing' is possibly 'undefined'.`、`src/client/FolderTab.tsx(133,12)` 同样两条）。
必须写成 `listing?.drives !== undefined && listing.drives.length > 0`——既保住窄化，又用
`length > 0` 而不是 `!== undefined`。

#### A.17.7 本轮确立的口径（回填唯一需求）

1. **默认浏览根（两级）**：会话**够得着**文件系统顶时就按 POSIX `/`，与 Windows 盘根语义对称
   （判据是 `cwd.startsWith('/')`，**不读 `process.platform`**）；会话够不着时退到工作区自身
   （`browseRoot` 拿 `list()` 同一道闸门问一次，见 A.17.9）。所以 `browse-root.spec.ts` 能在
   Windows 上用 POSIX **路径字符串**驱动（`browseRoot` 只看字符串形状），但那一例仍被 `:69` 的
   early-return 挡住（见 A.17.4 ②）。
2. **`drives` 是"清单"不是"标志"**：POSIX 顶层是**被收集但为空**（`[]`），不是 absent。任何
   "要不要给盘符入口 / 是不是根"的判断都**必须测 `length > 0`**。
3. **索引失败必须可见**：混合分支把失败原因做成 rows 第一行的 `⚠ ${reason}`（`mentionKind:
   'browse-note'`）；分类分支（`@file:`/`@folder:`）**刻意保持大声抛错**。
4. **平台特例用例不得"空跑通过"**：`if (process.platform === 'win32') return` 会被 vitest 记为
   pass。新写的平台特例一律改用**不依赖 `process.platform` 的路径字符串**驱动（缺陷 ④ 的用例
   即如此）；真正的 Linux 专有行为必须在真实 Linux 上跑过一次。
5. **未改动的相邻判定**（记录以免误改）：`src/runtime.ts:216` 的 `root` 与 `:221-226` 的
   `parent`（第五处修复后为 `:220` 与 `:225-230`）仍建立在 `drives === undefined` 上。POSIX 顶层
   `drives` 为 `[]` 而非 `undefined`，所以 `parent` 不会被错误地提供；`root` 另有
   `|| canonical === '/'` 兜底。

**仍未回答用户的开放问题**：Linux 默认层到底是 `/`、`$HOME`，还是"包含工作区的挂载根"？
第五处修复后的实测口径是**两级**：够得着文件系统顶就用 `/`（与 Windows 盘根对称，即用户原口径），
够不着就退到工作区自身——理由与实测见 A.17.9。若用户仍希望改成 `$HOME` 或"工作区所在的挂载根"，
只需改 `browseRoot` 一个函数（`src/runtime.ts:288-293`）。

#### A.17.8 提交与门禁

- `d0ccb85` `fix(linux): reach / from the picker and never hide a failed index`（缺陷 ①②③）
- `595cd8d` `fix(linux): stop offering drives where there are no drive letters`（缺陷 ④，5 文件 58+/6-）
- `pnpm run check` 全绿：`Test Files 39 passed (39)`、`Tests 917 passed | 1 skipped (918)`；
  `lib/` 一并提交（含重建的 `lib/client.js`）。
- 覆盖率：`vitest.config.ts:82-88` **没有** thresholds（只有 provider/exclude），全仓
  `All files 90.61% stmts / 86.5% branch`。本次改动的两个文件在改动前后**读数完全一致**
  （`FolderPicker.tsx` 96.35/91.32、`FolderTab.tsx` 93.61/82.35；未覆盖区间同为
  `FolderPicker.tsx:441-455` 与 `FolderTab.tsx:135`，即既有的 crumbs/drives 按钮 `onClick`），
  故**未引入新的未覆盖代码**，分支覆盖率反而各提升 0.04 / 0.35 个百分点。
- `0e6d8a3` `fix(linux): open the picker at a layer this session may browse`（缺陷 ⑤，4 文件
  65+/12-，含重建的 `lib/index.js` 与 `lib/types/runtime.d.ts`）。`pnpm run check` 全绿：
  `Test Files 39 passed (39)`、`Tests 918 passed | 1 skipped (919)`、`[verify-publish-surface] ok`。
- `dc9e8f2` `fix(picker): mount the folder chooser on the document body`（缺陷 ⑥，4 文件
  280+/206-，含重建的 `lib/client.js`；删除重复的 `tests/picker-layer.spec.tsx`）。
  `pnpm run check` 全绿：`Test Files 39 passed (39)`、`Tests 920 passed | 1 skipped (921)`、
  `lib/client.js 867.8kb` / `lib/index.js 649.4kb`、`[verify-publish-surface] ok — 65 files`。

> 本节标题里的"五处缺陷"是当时的口径；随后 A.17.10 又查出并修复了第六处（层叠/指针事件），
> 标题保留不改，以免破坏已有引用。

#### A.17.9 第五处缺陷：只读会话把选择器开在被拒的那一层（已修复并双向取证）

**症状（真实浏览器，插件仍是第五处修复之前的构建）**：在 guest 的实时会话（workspace
`/mnt/EShare`）里 `@folder:` → 点「选择文件夹…」，对话框打开在 `/`，列表只有 8 行 `常用` 预设，
`alerts: ["这个文件夹在工作区之外，当前会话不允许访问。"]`，**一个目录行都没有** ——
用户报的「看不到可选项」在只读会话里被原样复现。也就是说 A.17.3 订正的那条成立：闸门**确实**
会作废"默认层 = `/`"这个改动，当初只是把宽松会话的投影当成了全部。

**根因**：`browseRoot`（`d0ccb85` 起的单参版本）只按路径形状选 `/`，**从不问这个会话能不能浏览
`/`**；`list()` 随后照常执行 `src/runtime.ts:211` 的闸门，于是"打开的那一层"与"能走的那一层"
不一致 —— 打开瞬间就落在被拒绝的层（`error: "outside"`、`entries: []`），用户看到的就是"空"。

**修复**（`0e6d8a3`，只改 `src/runtime.ts` + 一条回归用例）：
- `browseRoot(cwd: string, access: ExternalAccess): string`（`:288-293`）：
  `const root = DRIVE_ROOT.test(externalPath(cwd)) || cwd.startsWith('/') ? '/' : '.'`；
  `if (root === '.') return root`；`const candidate = resolve(cwd, root)`；
  `return isUnder(cwd, candidate) || allowsExternal(access, candidate) ? root : '.'`
  —— **问的正是 `list()` 那道闸门**（同一对 `isUnder` / `allowsExternal`）。
- `list()`（`:208-209`）：`const access = this.externalAccessFor(agent)` 提到解析之前，空路径
  改为 `resolve(cwd, path === '' ? browseRoot(cwd, access) : path)`，闸门复用同一个 `access`。
- Windows 语义是**严格 no-op**：`cwd` 是盘根时 `resolve(cwd, '/')` 等于 `resolve(cwd, '.')`；
  `cwd` 不是盘根时旧代码本来就返回 `'.'`。所以这处修复只移动 POSIX 的窄会话。
- 空路径的 JSDoc 同步改成"这一层由 `browseRoot` 选成会话真能浏览的层"。

**"先对旧代码变红"的 Linux 证据**（独立 Node 探针，真实 Linux，Node `v26.8.2`；旧包 = 从
`/tmp/atlas-lib-backup/index.js.pre595cd8d` 取回的 `lib/index.js`）：

| 探针用例 `read-only session opens at the workspace, not at a refusal` | 旧包 | 第五处修复后 |
| --- | --- | --- |
| `path` | `"/"` | `"/tmp/dsh-atlas-narrow-6kKs1L/workspace"` |
| `error` | `"outside"` | `<none>` |
| `entryCount` | `0` | `1`（`["src"]`） |
| 退出码 | **1**（探针抛 `the session was refused the level it opened at: {…"path":"/","error":"outside","entryCount":0…}`） | 0 |

同一探针的宽松用例（`danger-full-access` 空路径）新旧都是 `path:"/"`、20 项、`drives: []`
⇒ **修复只移动窄会话，宽松会话逐字段无变化**。

**本机（Windows）只能证明不变量**：新用例
`falls back to the workspace when the session may not browse the filesystem root`
（`tests/browse-root.spec.ts`，`mount(ctx, 'read-only')` 经
`ctx.provide('sandboxPolicy', { resolve: () => ({ mode }) })` 注入只读）在 Windows 上**对旧的
`src/runtime.ts` 也是绿的**（`git stash push -- src/runtime.ts` 后仍 `5 passed`）——因为 Windows 上
`cwd` 本身就是盘根，`'/'` 与 `'.'` 解析到同一处。这正是 A.17.7-4 的又一个实例：能在 Windows 上
写的只有"窄会话必须落在可浏览层"这个**不变量**，真实回归证据只能在 Linux 取。

**真实浏览器复核（修复部署后）**：`@folder:` → 「选择文件夹…」→ `pathValue: "/mnt/EShare"`
（= 工作区所在的挂载根，即"够得着的最高层"）、`crumbs: / /mnt /mnt/EShare`、`alerts: []`、
`rowCount: 10`（`⬆ 上一级 ›` + 8 个 `常用` + `Eason ›`）；点 `Eason ›` 正常下钻到
`/mnt/EShare/Eason`（`alerts: []`，末行 `Rust ›`）。**"打开即空"的症状消失。**

**同一轮发现的残留行为（未改，口径待定，不是已证实的缺陷）**：窄会话里根面包屑 `/` **仍可点**，
点下去 `pathValue: "/"`、`alerts: ["这个文件夹在工作区之外，当前会话不允许访问。"]`、
`rowCount: 8`（只剩预设、零目录行）。两种解释都说得通：(a) 面包屑如实反映当前路径的层级，走到
被拒层并**明确说明原因**是可接受、甚至是有信息量的；(b) 既然 `browseRoot` 已经知道 `/` 够不着，
就不该再把它摆成一个可点的入口。要 (b) 就得在 `crumbs` 里剔除或置灰不可达层，**这会改动用户
可见的口径，故留给用户定夺**。

**自动化侧的附带测量（不是产品缺陷，但值得记住）**：CDP `Input.dispatchMouseEvent` 的坐标就是
**纯 CSS 像素**（与 `getBoundingClientRect` 同空间），`devicePixelRatio = 0.725` 与命中测试
**无关** —— 上一轮把坐标乘 `dpr`，点击落到上方约 0.275 屏高处完全不相干的另一行（实测点到
`GOAI_Root 常用 ›` 而不是 `Eason ›`，于是"下钻"的结果对不上号）。用
`document.elementsFromPoint` 量出的两处"行中心点不到"的确切原因：
- 最后一行 `Eason ›`（rect `y 878-916`）的中心 `y=897` 落在列表
  `ul.dsh_atlas_pickerList`（`y 532-879`）**之外**，被本插件的快捷键行
  `p.dsh_atlas_pickerKeys`（`y 879-911`）盖住 —— 10 行 × 38px = 380px 超过列表高度 347px，
  该行只露出 1px：**这是滚动列表的正常形态**，点它可见的部分（或先 `scrollIntoView`）即可。
- 根面包屑 `/`（rect `x 355-366`）中心 `(360,511)` 的最上层是
  `div.wSkVaW_widthHandle`（`x 355-395`、`y 76-1382`）—— **宿主 Web 外壳的侧栏宽度拖拽条，
  z 序在对话框之上**，于是对话框左侧约 40px 宽的一条竖带里的指针事件全被它吃掉（`mnt`
  面包屑中心 384 也在带内；`EShare`（402-450）不在带内，栈顶就是自己）。这是外壳（不是本插件）
  的层叠问题：**当时按"最小改动"只记录，随后查明抬高 z-index 修不掉，已改为 portal 到
  `<body>` 修复，见 A.17.10。**
- `dialog` 向上 6 层的 `zoom` 全是 `"1"`、`transform` 全 `"none"`、`pointerEvents` 全 `"auto"`
  ⇒ **不存在 CSS 缩放**，"行被缩放所以点不到"的假说被否掉。

- 改写/删除历史消息
- "取回并重发后自动截断后续"（= rewind，见 D-04）
- 自定义快捷键编辑器（只提供开关 + 粒度 + 复用模式三个设置）
- 移动端手势（无键盘即无此需求）

#### A.17.10 第六处缺陷：左侧一条 40px 竖带吃掉了对话框的指针事件（已修复并真机双向取证）

**症状（真实浏览器，A.17.9 的修复已部署之后）**：在 guest 的实时会话里打开选择器，
`@folder:` → 「选择文件夹…」→ 对话框显示 `pathValue: "/mnt/EShare"`、`crumbs: / /mnt /mnt/EShare`、
`alerts: []`、10 行 —— **眼睛看得到的东西全对，但最上面两级面包屑 `/` 和 `mnt` 点不动**：
`Eason ›` 之类的目录行正常下钻，唯独这条竖带里的元素点了没有任何反应。这就是用户报的
「看不到可选项」之外的另一半体验：不是没渲染，是渲染了但**指针事件被别的东西接走**。

**根因（实测，不是推测）**：`document.elementsFromPoint` 在面包屑中心点量出的最上层元素是
**宿主 Web 外壳的侧栏宽度拖拽条** `div.wSkVaW_widthHandle`
（`position: absolute`、`z-index: 8`、rect `x 355-395`、`y 76-1382`），它在对话框
`SECTION.dsh_atlas_picker` 之上 —— 对话框左侧约 40px 宽的一条竖带（`x 355-395`）里，
指针事件全被拖拽条吃掉。命中清单：根面包屑 `/`（rect `x 355-366`，中心 `(360,511)`）在带内；
`mnt` 面包屑中心 `384` 也在带内；`EShare`（`402-450`）不在带内，栈顶就是它自己
—— 与"只有最左边两级点不动"的现象逐点吻合。

**为什么抬高 z-index 修不掉（实验否掉，不是没试）**：`.dsh_atlas_pickerScrim` 的
`z-index` 从 `2147482600` 抬到 `2147483647`（`2147483647` 是有符号 32 位上限）后，
同一点的最上层**仍然**是 `div.wSkVaW_widthHandle`。原因不是数字大小，而是**层叠上下文**：
本插件拿到的挂载槽位本身处在一个被拖拽条所在上下文压过的层叠上下文里，
scrim 的 z-index 只在**它自己那个上下文内部**排序，抬到多大都出不去。顺带否掉的还有 CSS 缩放
假说：对话框向上 6 层的 `zoom` 全是 `"1"`、`transform` 全 `"none"`、`pointerEvents` 全 `"auto"`。

**修复（`dc9e8f2`，只改 `src/client/FolderPicker.tsx` + 两个测试文件）**：
`src/client/FolderPicker.tsx:31` 引入 `import { createPortal } from 'react-dom'`，
渲染返回值由裸的 `<div className="dsh_atlas_pickerScrim">` 改为
`createPortal(<div className="dsh_atlas_pickerScrim" role="presentation" onMouseDown={…}> … </div>, document.body)`。
portal 的**安全性是结构性的**，不是"看起来没事"：

- 外层点击关闭用的是 `event.target === event.currentTarget` 比较（不是"包含关系"），
  换父节点不影响判据；
- Tab 焦点陷阱查的是 `dialogRef.current.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])')`
  —— 查的是对话框元素自己，不是容器；
- `dialogRef` / `inputRef` / `listRef`、`onKeyDown`、`faces.current.list()` 的分页与
  `next.path` 处理都与挂载位置无关。

**"先对旧代码变红"的本机证据（这次不需要 Linux）**：`tests/folder-picker.spec.tsx` 新增
`describe('the folder chooser — the layer the dialog lives on')` 两例：
① `scrim.parentElement === document.body`，且 `slot.querySelector('.dsh_atlas_pickerScrim') === null`、
`slot.querySelector('.dsh_atlas_picker') === null`；② unmount 后 `document.body` 里
`[data-atlas-folder-picker]` 与 `.dsh_atlas_pickerScrim` 都为 `null`（portal 的节点随组件卸载一起消失）。
把 `src/client/FolderPicker.tsx` 用 `git stash push` 退回 portal 之前，这两例会红，原文：

- `expected <div><div …(2)>…(1)</div></div> to be <body><div></div></body>`（scrim 的父节点是挂载槽，不是 body）
- `expected <section …(5)>…(4)</section> to be null`（对话框仍留在槽位里）

这一轮 stash 后共 `8 failed`，其中包含这两例 ⇒ 用例**抓得住**这处缺陷。
（这两例是**本机**能红的，与 A.17.7-4 说的"平台相关的缺陷只能在 Linux 取证"不冲突：
"对话框挂在哪"是平台无关的结构，而"挂了之后能不能被点到"才是平台相关的。）

**测试侧必须一起改的挂载方式（否则 56 例全红）**：portal 之后对话框**不是**挂载容器的后代，
两个 jsdom 套件的查询面必须从"容器"改成"文档"：

- `tests/folder-picker.spec.tsx`：`mount()` 改为
  `const slot = document.createElement('div'); document.body.appendChild(slot); const root: Root = createRoot(slot)`，
  返回 `{ container: document.body, slot, root, … }`（`slot` 只用于断言"对话框不在槽里"）；
  加 `beforeEach(() => { document.body.innerHTML = '' })` —— portal 之后 body 就是被测 DOM，
  上一个用例没卸载干净的对话框会去回答下一个用例的查询；`press()` 改为先取
  `container.querySelector('.dsh_atlas_picker')`，**只在这个对话框内部**按到 `document.activeElement`，
  否则按到对话框本身（没有对话框时抛 `press(): no dialog on screen`）；两处自建挂载容器的用例
  同样改为建 `slot` + `createRoot(slot)` + 查询 `document.body`。
- `tests/posix-browse.spec.tsx`：同样加 `beforeEach` 清 body、建 `slot`、返回 `container: document.body`。
- 先前的独立文件 `tests/picker-layer.spec.tsx` **已删除**：它和上面的 describe 是同一件事的重复，
  留在仓库里只会有一天出现两份互相漂移的断言。

**门禁**：`pnpm run check` 全绿 —— `Test Files 39 passed (39)`、`Tests 920 passed | 1 skipped (921)`、
build `lib/client.js 867.8kb` / `lib/index.js 649.4kb`、
`verify:publish-surface ok — 65 files, no internal artifacts, ad-free bundle`。

**真实浏览器复核（真实 Linux，Chromium `153.0.0.0`，修复部署后）**：
- `scrimIsBodyChild: true`（对话框的 scrim 直接挂在 `document.body` 上）；
- 根面包屑 `/` 的 rect `{left: 355, top: 487, w: 11, h: 16}`，中心点 `(360, 495)`；
- 同一点的最上层元素由旧代码的 `DIV.wSkVaW_widthHandle`（`insideDialog: false`）变成
  **`BUTTON.dsh_atlas_pickerCrumb`（`insideDialog: true`）**，继续往下是
  `NAV.dsh_atlas_pickerCrumbs` → `HEADER.dsh_atlas_pickerHead` → `SECTION.dsh_atlas_picker`，
  全部 `insideDialog: true`；
- 用真实 CDP `Input.dispatchMouseEvent` 点这个点之后，picker 状态确实变了：
  `pathValue: "/"`、`crumbs: []`、`alerts: ["这个文件夹在工作区之外，当前会话不允许访问。"]`、
  `rowCount: 8` —— 旧代码在同一点点击后**状态完全不变**。这一对前后对比就是"修复生效"的取证；
- 顺带复核目录行仍可用：真实点击 `Projects 常用 ›`（点 `(619, 576)`，栈顶
  `SPAN.dsh_atlas_pickerName`，`insideDialog: true`）→ `pathValue: "/home/omarchy/Projects"`、
  `crumbs: / /home /omarchy /Projects`。

**部署与自动化侧的三条教训（口径，值得记住）**：
1. **重启 `dsh-web.service` 不会刷新已经打开的页面**：页面的内存里仍是旧 bundle，于是"点击不生效"
   这种结论可能**完全是对旧代码的测量**。本轮第一次跑探针就掉了进去（`scrimIsBodyChild: false`、
   栈顶仍是拖拽条、真实点击无任何变化 —— 整轮对修复毫无证据力）。探针必须自带
   `Network.setCacheDisabled(true)` + `Page.navigate` + "等到 composer 出现"，并加一道
   **新鲜度闸门**：scrim 不是 `document.body` 的子节点就直接 `exit 9`，不许往下走。
   部署侧 host/guest 的 `lib/client.js` sha256 一致（`e217e4e826f46d2767875a60f2fb9464c45d13b9869be3aa7231c7ee48b4ff32`）。
2. **CDP `Input.insertText` 只投给当前焦点元素**：先发过 `Escape` / `Ctrl+A` 之后焦点可能已经离开
   composer，插入落空、composer 仍为空 —— 而"composer 是空的"和"mention 菜单里没有那一行"
   在报告里长得一模一样。所以探针要先 `el.focus()`、断言 `document.activeElement` 在 composer 内，
   再插入并断言 `composerText()` 里有 `@folder`，否则 `exit 11`。同理，判空必须把
   `\s` 与 `\u200b` 一起去掉：空 contenteditable 的 `innerText` 是 `"\n"`，用 `=== ''` 判空会假失败
   （本轮就假失败过一轮，`exit 10`）。
3. **mention 是原子 chip，会被 draft 恢复**：上一次探针留在 composer 里的 `@folder:` 会在 reload 后
   恢复（实测恢复成 `@folder:@folder:@folder:`），再插一遍同样的文本只会追加、菜单停在子菜单
   （只见「返回类别」），于是"找不到那一行"又一次是探针自己的问题。清 composer 要"菜单先关、
   全选、删除"，并**验证真的空了**才继续。

**仍未改的残留（口径待定，不是已证实的缺陷）**：窄会话里根面包屑 `/` **依然可以点**，点下去
`pathValue: "/"` 并给出 `alerts: ["这个文件夹在工作区之外，当前会话不允许访问。"]`（`rowCount: 8`）。
两种解释都说得通：(a) 面包屑如实反映当前路径的层级，走到被拒层并**明确说明原因**是可接受、
甚至是有信息量的；(b) 既然 `browseRoot` 已经知道 `/` 够不着，就不该再把它摆成一个可点的入口。
要 (b) 就得在 `crumbs` 里剔除或置灰不可达层，**这会改动用户可见的口径，故仍留给用户定夺**。

---

### A.18 第十八轮：区外文件夹选择界面改为**两个分组的真目录树**（用户已拍板）

**用户原话**（附文件管理器截图两张）：

> "和当前工作区文件夹 平级的文件夹 如图1"
> "问题是 为何 选择文件夹界面显示的如图2 显示？"
> "目前需求是默认显示工作区区外的哪个根文件夹？"
>
> "更新需求如下：
> 1. 界面应该有两个分组；
> 1.1 常用的区外文件夹 应该单独分组且默认是折叠的（随在编辑栏的整体替换的输入或增量来过滤的同时且展开分组），这样用户更多的看到的是默认显示的文件夹下面的完整的子文件夹清单（和编辑栏的初始的当前文件夹对应;随在编辑栏的输入是否是文件夹而决定是否过滤）），不然会和 默认显示的文件夹下面的文件夹 混淆在一起；
> 1.2 常用区外文件夹分组下面是当前文件夹分组（默认展开，展开后默认是完整子文件夹）
> 2. 用户操作流程是：
> 2.1 要么在输入栏有有效路径对应的文件夹；决定了常用分组不展开，且当前文件夹分组显示的是输入栏的文件夹的子文件夹；
> 2.2 要么在输入栏增量输入时用户看到常用区外文件夹分组展开后的过滤结果以及当前文件夹（此时是输入栏里最长有效文件夹路径，因为增量输入的新的部分还不确定是不是一个文件夹）下的过滤结果；
> 2.3 用户通过 up 和 down 选想要的子文件夹 S；
> 2.4.a 如果选择的子文件夹 S 有子文件夹，那么会显示为折叠状态的分组 S；此时如果按 回车键，会展开分组 S，分组下显示所有子文件夹（包括隐藏文件夹，如果设置里选择了，默认是不显示隐藏文件夹）；但如果此时用户想要选择并落盘子文件夹 S，可通过鼠标选择 点击 选择文件夹界面的 选择 按钮，也可直接用 ctrl enter 来选择且落盘作为分组的子文件夹 S（这是 ctrl enter 唯一的使用场景；也就是分组默认用 enter 展开，要选择分组且落地只好用 ctrl enter）；
> 2.4.b 如果 S 不是分组，那么此时，回车表示选中且将该子文件夹 落地到聊天框（当然区外文件夹选择界面也提前关闭了）"
>
> "分析下这个需求是否自洽且和其他不冲突，如果答案都是肯定的 ，请补充到唯一需求文档，且补充到 /goal 后 实施"

图1 = 文件管理器停在 `/mnt`，列出的正是**工作区文件夹的平级目录**：`CShare`、`DomybC`、
`DShare`、`EnvD`、`EShare`、`host`、`RustD`、`RustE`、`windows-e`、`wine`。
图2 = 当时的对话框：`⬆ 上一级` 之后，`Projects` / `重金属` / `GOAI_Root` / `Game++` / `DSH` /
`Omarchy` / `ConquerMaster` / `SecurityTest` 每行都挂着"常用"标签，**然后才是当前层自己的 `Eason`**
——预设与当前层的子目录混在一条扁平列表里，这就是用户抱怨的"混淆"。

#### A.18.1 与既有口径的冲突（本轮诚实记录：**不是全肯定**）

分析得到 **3 处硬冲突 + 1 处结构歧义 + 1 处历史欠账 + 1 处未定口径**，所以先把口径摆到用户面前
拍板，而不是直接写文档：

| # | 冲突 | 与谁冲突 | 结论 |
| --- | --- | --- | --- |
| 1 | 叶子行 `Enter` = **采纳并关闭** | A.15.2 / A.15.6 / A.15.7-3："`Enter` 永远只表示往里走，采纳只有 `Ctrl+Enter`" | 用户拍板**按新需求改**（A.18.2） |
| 2 | 要知道子文件夹"有没有子文件夹" | A.15.5："筛选/列层纯内存，不产生任何 I/O"；`PickerEntry` 只有 `{name, path, hidden}` | 用户拍板**给 Host 加一次调用**（A.18.6） |
| 3 | 预设要参与过滤、被输入展开 | A.15.5："预设是跳到别处，与关键词无关，因此一起消失" | 用户拍板**改**（A.18.5） |
| 4 | "展开"是替换当前层还是原地插入子分组 | A.15 的"走进"= 替换当前层的根 | 用户拍板**原地展开的真树**（A.18.2） |
| 5 | A.15 用户原话就要求"支持折叠"，却从未实现 | A.15（`:1909`） | 本轮补上（历史欠账） |
| 6 | 默认停在哪个层（区外根） | A.15.3"工作区所在盘的根" / A.17.7、A.17.9"够得着 `/` 就用 `/`" | 用户拍板**工作区父目录、逐级上退**（A.18.6） |

全文检索 `折叠|分组|tree|aria-expanded`：**没有任何历史决定否决**把选择器做成树形——冲突只集中在
A.15.2 / A.15.3 / A.15.5 / A.15.6 / A.15.7-3 这几条具体口径上，它们各自已被上文标注为
"已被 A.18 修订/取代"。

#### A.18.2 用户拍板的四项口径（均为我给的推荐项）

1. **展开模型**：`S 原地展开成子分组：真目录树，兄弟行保留，可多层嵌套`。
2. **`Enter` 语义**：`分组/有内容 Enter=展开，叶子行 Enter=采纳并关闭`。
3. **子文件夹判定**：`给 Host 加一次调用：同时返回最长有效目录前缀 + 本层每个条目有无子目录`。
4. **默认层**：`工作区所在文件夹的父目录，取不到就逐级上退`。

**实施方声明（用户未反对，一并按口径执行）**：

- `role` 用 `tree` / `treeitem` + `aria-expanded` / `aria-level`（listbox 语义已不足以表达层级）。
- `⬆ 上一级` 与盘符**作为「当前文件夹」分组的头部行**，不另立第三个分组。
- 叶子行采纳后沿用 A.15.6 的**焦点交回编辑栏**（微任务 + 一帧）。
- **路径行的 `Ctrl+Enter` 保留 = 采纳当前层**。A.18 明确把它记为对"`Ctrl+Enter` 唯一场景"的
  **例外**，理由是 A.15.7-1 的纯键盘流程（`↓` → 选 → `Enter` → `Ctrl+Enter`）必须活着。

#### A.18.3 交互结构（两分组真树）

```
┌ 选择文件夹 ─────────────────────────────────────────────┐
│ [当前路径输入框 ✎]                        面包屑: / mnt │
│ ▸ 常用区外文件夹                    （折叠，默认）      │
│ ▾ 当前文件夹  /mnt                  （展开，默认）      │
│     ⬆ 上一级                                            │
│     ▸ CShare   ▸ DShare   ▸ RustE   ▸ wine   ...        │
│  （展开 RustE 之后：）                                  │
│     ▾ RustE                                             │
│         Eason   DSH   projects  …                       │
└─────────────────────────────────────────────────────────┘
```

- **两个顶层分组，顺序固定**：「常用区外文件夹」在上且**默认折叠**，「当前文件夹」在下且
  **默认展开**。这就是 1.1 / 1.2 的全部内容。
- **「当前文件夹」分组的头部行**代表当前被列的目录（label = 末段名，hint = 全路径）；
  它下面**首先是头部行**（`⬆ 上一级` / 盘符），**然后是这一层的完整子文件夹清单**
  （隐藏项是否出现由对话框里的"显示隐藏文件"开关决定，**展开嵌套分组不改变这条规则**）。
- **展开 = 原地插入**：展开 `RustE` 时它的子文件夹插在 `RustE` 行的正下方并**缩进 +1**，
  **兄弟行保留、可继续展开、可任意层嵌套**。这就是用户拍板的"真目录树"，也是 A.15 那种
  "走进 = 换掉整个根"被取代的地方。
- **`⬆ 上一级` / 盘符 / 面包屑仍然是"换根"**（清空展开集合、重新列一层），不是展开。
- 展开态的标记：折叠 `›`，展开 `⌄`，**叶子行没有箭头**——箭头就是"这一行是不是分组"的预告，
  也正因为有它，A.18.4 的 `Enter` 才可预判。
- **不做成两个 tab**：2.2 要求用户**同时**看到常用组与当前组的过滤结果，tab 会把其中一份藏起来。

#### A.18.4 键位（修订 A.15.2 的列表一侧）

| 键 | 路径行（初始焦点） | 列表 |
| --- | --- | --- |
| `↑` / `↓` | 离开路径行进入列表（焦点一起走） | 在**可见行**里移动高亮，两端**夹住**（到底/到顶再按不动，不环绕）；走出可显示区域时**同步翻页**（见 A.18.10） |
| `Enter` | **换层**：严格走到输入框里那条路径（不存在就给拒绝说明） | **分组行 → 原地展开/折叠**（箭头预告）；**叶子行 → 采纳并关闭** |
| `Ctrl+Enter` | **采纳当前层**（例外，见 A.18.2） | **采纳该行代表的文件夹**：叶子行 = 它自己；分组行（含折叠态）= 它自己；`⬆ 上一级` = 父目录；**两个分组头本身不代表任何文件夹**，它们采纳的是**当前层**（实现是 `hotRow.target ?? listing.path` 的回退，见 A.18.10） |
| `Esc` | 逐级退出：新建表单 → 编辑态 → 筛选词 → 关闭对话框 | 同左（**展开态不是 Esc 的一级**：展开不替换兄弟行，没有"返回"语义，退层请用 `⬆ 上一级`） |
| `Tab` / `Shift+Tab` | 在对话框内循环，**不逃到页面** | 同左 |
| `Backspace` | 文本编辑 | 有筛选词时删一个字符，否则**返回上级** |
| `Home` / `End` | 行首/行尾 | 首行/末行 |
| 可打印字符 | 编辑路径（触发 A.18.5 的实时列表） | 筛选（**纯内存**，同时强制展开常用组） |

`hasChildren` 未知时的诚实降级：`Enter` 先就地探测（`atFile/browse` 该行），有子文件夹则展开，
没有则采纳并关闭——比"猜"多一次很短的等待，但不会把 `Enter` 变成随机行为。

#### A.18.5 输入栏与过滤（2.1 / 2.2 的机制）

- **编辑栏可打印字符** → 进入编辑态，并**防抖 200 ms**（可中止）调用 `atFile/browse(输入原文)`；
  Host 返回的是"**最长有效目录前缀**"那一层（`path` = 实际列出的目录，`requested` = 输入原文，
  **只在两者不同时出现**）。客户端把输入原文里 `path` 之后的那一段算作 `needle`。
- **`needle === ''`（输入的就是一个存在的目录）→ 2.1**：「常用区外文件夹」**不展开**；
  「当前文件夹」以该目录为根，**显示完整子文件夹、不做过滤**（展开集合复位）。
- **`needle !== ''` → 2.2**：「常用区外文件夹」**强制展开**，两个分组**同时按 needle 过滤**
  （大小写不敏感的包含匹配；目录比 `name`，预设比 `name` 或 `path`）；命中后代的折叠组**临时展开**
  以露出命中（只影响显示，不改用户自己的展开集合）；与 needle 无关的"跳到别处"行
  （`⬆ 上一级`、盘符）隐藏——A.15.5 的"收缩而不是替换"**保留**，只是收缩对象现在包括预设。
- **列表内的可打印字符（`filter`）**走同一套过滤与"强制展开常用组"，但**不发 I/O**（纯内存）。
- **路径行的 `Enter` 仍然严格换层**：只接受输入里那条路径；不存在的路径照样给
  "这个文件夹不存在"。"最长有效前缀"**只服务输入时的实时列表**，绝不成为 `Enter` 的目标——
  否则一次 `Enter` 会静默落到一个用户没写的目录上。
- 每个展开的分组在**零命中**时组内显示"没有匹配的文件夹"；当前层确实没有子文件夹时显示
  "（没有子文件夹）"。`truncated` 提示沿用不变。

#### A.18.6 Host 面：新增 `atFile/browse`，并把默认层改成"父目录梯子"

- **`@Remote async browse(agent: Agent, path: string, signal: AbortSignal): Promise<BrowseListing>`**：
  前置判定（开关 / 会话有工作区 / 越权）与 `list` **完全一致**；然后把 `path` 解析成
  "**最长有效目录前缀**"：`path` 本身不是目录时沿 `dirname` 上溯到第一个存在的目录，
  遇到越权边界立即停止，仍找不到就返回原来的 `error`（`missing` / `notDirectory` / `outside`）；
  列该层（`DIRECTORY_ENTRY_LIMIT = 200`）；**每个条目附 `hasChildren`**（探测限定并发 8、
  **总预算 ~600 ms**，超预算的条目**省略**该字段 = 未知，客户端遇到未知就地探测）；
  返回 `{ path, requested?, parent? | drives?, entries: [{ name, kind, hidden, hasChildren? }], truncated? }`。
- **`browseRoot` 改为梯子**（取代 A.15.3 的盘根默认与 A.17 的"够得着 `/` 就用 `/`"）：
  `dirname(cwd)` → 逐级 `dirname` → 取第一个"允许访问"的层级；全被拒则退到**工作区自身**。
  Windows 与 POSIX 同一架梯子。本机工作区 `/mnt/EShare` ⇒ 默认层 `/mnt`（正是图1 那一层）；
  窄会话里父目录够不着 ⇒ 自动退到工作区自身，A.17.10 的残留 item (ii)（窄会话里可点的根面包屑）
  随之收口。
- **`atFile/list` 保持不动**（`FolderTab` 等仍在用），对话框的数据源换成 `browse`。
- 具名常量：`CHILD_PROBE_CONCURRENCY = 8`、`CHILD_PROBE_BUDGET_MS = 600`、`DIRECTORY_ENTRY_LIMIT = 200`
  （沿用）。

#### A.18.7 会动到的既有零件（诚实记录）

- `src/client/FolderPicker.tsx`：`rows` 从"一条扁平数组"改成"两分组 + 树遍历"；新增
  `expanded: Set<string>`、`children: Map<string, PickerListing>`、`needle`；`PickerEntry` 加
  `hasChildren?: boolean`；`PickerRow` 加 `level` / `kind` / `expanded`。
- `src/contract.ts`：新增 `dsh-atlas#atFile/browse` 的 `InvocationDescriptor` 与
  `browseListingSchema`（沿用 `directoryTargetSchema` 的入参）。
- `src/client/remote.ts`：face 表加 `'atFile/browse'`。
- `src/client/index.ts`（`:1145` 的 `inject`）与 `src/client/locales.ts`、`src/client/styles.ts`
  同步更新。新增文案：`picker.group.presets` = 「常用区外文件夹」、`picker.group.current` = 「当前文件夹」；
  `picker.keys` 改为 `↑↓ 移动 · Enter 展开/选中 · Ctrl+Enter 落盘 · Tab 切换 · Esc 返回/关闭`（「落盘」
  一词是用户原话，比"选择分组"更准确：它涵盖叶子行、分组行与预置行三种落盘）。
- **`tests/folder-picker.spec.tsx` 大量断言要按新结构改写**（`role="listbox"`/`option` →
  `tree`/`treeitem`）：这是本轮最大的回归面，改写时保持"每条断言仍能抓住一个真实缺陷"。

#### A.18.8 明确不改的

- `⬆ 上一级` / 盘符 / 面包屑仍是**换根**；新建文件夹、显示隐藏文件、拒绝理由文案不变。
- **整盘搜索仍然被否决**（A.15.5 的实测表不变）；本轮的过滤不引入任何后台索引，只过滤
  "已经在手上的行"+ 一层按需 I/O。
- A.16（再次点击同一对象）不受影响；`atFile/list` 的既有语义不变。

#### A.18.9 验收

1. 打开后默认层 = **工作区所在文件夹的父目录**（本机 `/mnt`），第一组是**折叠**的
   「常用区外文件夹」，第二组「当前文件夹」展开且列出完整子文件夹（含与工作区平级的
   `CShare` / `RustE` / `wine` 等）。
2. 纯键盘：`↓` 进列表 → 选到**叶子行** `Enter` → 对话框关闭、该文件夹落地到聊天框、焦点回编辑栏。
3. 纯键盘：选到**分组行** `Enter` → 原地展开（兄弟行不动、缩进 +1、箭头翻转）；再 `Enter` 折叠；
   `Ctrl+Enter` → 采纳该分组自己。
4. 鼠标：点分组行不落盘（只展开）；落盘分组自己用「选择」按钮或 `Ctrl+Enter`。
5. 编辑栏输入 `/mnt/EShare/Ru` ⇒ 常用组**自动展开并按 `Ru` 过滤**，当前组显示 `/mnt/EShare`
   的过滤结果。
6. 编辑栏输入到已存在的 `/mnt/EShare` ⇒ 常用组**不展开**，当前组是该目录的完整子文件夹、无过滤。
7. 路径行 `Enter` 仍然**严格换层**：输入不存在的路径得到"这个文件夹不存在"，绝不静默跳到有效前缀。
8. `Esc` 逐级、`Tab` 不逃；"显示隐藏文件"开关在展开的嵌套分组里同样生效。

回归与新增测试：`tests/folder-picker.spec.tsx`（**55 条**按新结构改写，含 A.18.10/第十九轮的 3 条翻页与
焦点守卫用例）+ `tests/posix-browse.spec.tsx`
（**14 条**，8 条 Host `crumbsOf` 断言原样保留，6 条对话框断言改注入 `browse`）+ `tests/recent-folders.spec.ts`
（19 条不动）+ `tests/browse-service.spec.ts`（**11 条** `atFile/browse` Host 单测：最长有效前缀、
`requested` 前缀契约、`hasChildren` 三态、`browseDefault` 梯子、越权边界、无 cwd / 关开关的报错、
根层 `drives`/`parent`）+ `tests/files.spec.ts` 的 `describe('hasSubdirectory')`（**7 条**：命中即返回、
隐藏项、软链、打不开、读失败降级）。门禁仍是 `pnpm run check`（typecheck + test + build + `verify:publish`），
本轮结果：`Test Files 40 passed (40)`、`Tests 940 passed | 1 skipped (941)`（**当轮读数**；
最新读数见 §8 的 C-01：40 files / 966 passed + 1 skipped）。

#### A.18.10 第十九轮：越屏翻页、选中必落盘、展开不动当前行（用户 2026-… 反馈，已实施）

用户原话（`m01272`）："且 up down 键 移动到当前屏显最后一行时，如果继续向屏显外面的行移动，
应该同步滚动到下一页（此时当前行停留在下一页的第一行） 请分析和唯一需求文档是否冲突，
以最新需求为准 / 同理无论什么快捷键表达选中语义（不是展开分组语义）的 都需要选中且落盘；
不要像现在一样 ，选了常用的，不但不落盘，还当前行还跳到别的行去了；同理，表达展开分组语义的操作，
展开后，当前行依然是分组所在行，不因为展开操作而发生当前行的变化；当前行的变化只可能因为up或down而改变；"

**冲突分析结论：与唯一需求文档不冲突。** 逐条核对后，唯一被这条反馈触及的旧口径是
A.15.2 / A.15.6 / A.15.7-1，而这三条**都已被 A.18 取代**（见 A.18.1 冲突表），所以这里没有
"新旧对撞"要裁决；文档此前**根本没有翻页规则**，A.18.10 是**新增**而不是修订。三条落地口径：

1. **越屏即翻页**：`↑` / `↓` 走到"当前可显示区域"的最后一行后继续走，**同步滚动到下一页**，
   当前行停在下一页的**第一行**（向上对称：停在上一页的最后一行）。实现见
   `src/client/FolderPicker.tsx` 的翻页 effect（`:566-587`）：按 `dataset.key === hotKey` 找到行，
   `row.top < box.top` ⇒ `container.scrollTop += row.bottom - box.bottom`；
   `row.bottom > box.bottom` ⇒ `container.scrollTop += row.top - box.top`；`box.height === 0`
   （jsdom 无布局）直接返回，所以这条规则在测试环境不会伪装成"通过"。**两端仍然夹住不环绕**
   （A.18.4：`moveBy` 用 `Math.min(len-1, Math.max(0, from+step))`），翻页是"走到头继续走"的结果，
   不是环绕。
   **落盘前的一处实现修正（真机 E2E 抓到，提交 `3abd603`）**：翻页最初写成对当前行 `scrollIntoView(...)`。真机上
   它把**所有可滚动祖先**一起滚了，shell 的内容在用户脚下滑动，列表下方的行被滑到静止指针底下，
   浏览器把这一"重新指向"当作那一行的 `mouseover` 报出来，`onMouseOver` 照单全收 ⇒ 当前行被交给
   了鼠标底下的行，"走到头继续走"永远走不出第一页（真机 E2E 的两条断言
   `ArrowDown cannot walk past the last row (clamped, no wrap)` /
   `the list really scrolls once the cursor leaves the visible page` 直接红）。改为**只滚列表自己的
   `scrollTop`**（`:577-586` 的注释记着这个理由）。
2. **凡是表达"选中"语义的快捷键，都必须真的落盘**：`Enter`（叶子行 / 已展开或无子的分组行）、
   `Ctrl+Enter`、鼠标「选择」按钮都走同一个 `confirm`（`adoptPath`），不存在"只把当前行挪走、
   不落盘"的路径。这修掉的正是用户报的 bug：**选「常用区外文件夹」里的预置项时既没落盘、当前行
   还跳到别的行去了**——预置行的 `Enter` 现在就是**采纳**（`activate` 对 `kind === 'preset'`
   直接 `adoptPath`），而旧实现在这里把它当成"换层"处理。
3. **凡是表达"展开分组"语义的操作，展开后当前行仍是那个分组行，不因展开而变化**；
   **当前行只可能因为 `↑` / `↓` 改变**。实现依据：光标按**行 key**（`hotKey`）记录而不是按序号，
   所以展开时插入的子行、折叠时移除的子行都不会让光标漂移；唯一会重写 `hotKey` 的地方是
   "原来的行已经不存在了"的**修复**（`useEffect` `:554-561`，筛选词删掉了该行或它所在的分组被
   折叠），那是重新定位，不是移动。
4. **"只可能因为 `↑` / `↓` 改变"这句必须由代码兑现，不能让指针投机**：除了箭头，还有第二条
   路径会写 `hotKey`——鼠标悬停（`hoverRow`，`:603-620`）。上面第 1 条的滚动会让行**在静止的指针
   底下**被换掉，浏览器为此补发的 `mouseover` 与"用户真的把鼠标移到了这一行上"在 DOM 事件里长得
   一模一样，所以用**坐标**区分：`pointer` ref 记住上一次的 `clientX/clientY`，与上次**完全相同**
   的坐标判为滚动引起的重新指向，直接返回，不写 `hotKey`。真机验证：把指针**停在列表中央**再
   `↓` 走到底，行必须照样一路走到底（E2E 断言
   `ArrowDown with the pointer on the list advances from the hovered row (m01272 c)`，以及
   `a genuine pointer move moves the cursor to that row` / `and a second move takes it away again`
   两条反例，保证守卫没有把真的悬停也一起挡掉）。
5. **对话框是 `aria-modal`：键盘焦点必须真的在它里面**（真机 E2E 抓到的第二处缺陷，提交
   `a9ef2ea`）。旧实现只在路径行挂载时 `focus()` 一次，而 shell 会在**打开选择器的同一个点击**里
   把焦点交回 composer 的 contenteditable，两者是竞态：两次真机 E2E，一次焦点落在路径行（全绿），
   另一次**每一个 `keydown` 都送给 composer**、对话框一个键都没收到（屏幕上一切正常，只是键盘
   全哑）。改为**持续守卫**而不是请求一次：effect（`[open, zone]`）在 `document` 上监听 `focusin`
   与 `focusout`（焦点掉到 `body` 时 `queueMicrotask` 再判一次），`claim()` 发现焦点不在对话框
   （`dialogRef.current.contains(document.activeElement)` 为假）就按 `zone` 把焦点抢回路径行或列表；
   唯一的例外是"采纳"这个**本意就是要离开**的出口：`adoptPath` 在 `confirm(target)` 之前先置
   `released.current = true`（`:210-216` 的 ref），守卫随即让路，焦点才交得回编辑栏。两条新单测都
   **承重**（实测：把守卫改成直接 return ⇒ 第一条红；把 `released.current = true` 去掉 ⇒ 第二条
   红）；第二条必须在 `confirm` 之后**对话框仍然挂着**（故意不传 `closesOnConfirm`）才有意义——
   对话框一卸载，effect 的 cleanup 就自己拆掉了监听，`released` 变成死代码，变异也照样绿。

**真机验收（2026-…，Omarchy guest，Chromium + CDP）**：`node .atlas-a18.mjs`（零依赖 CDP 探针，
走真实鼠标/键盘事件，断言取自 DOM 而非截图）`EXIT=0`，20 条断言全绿，逐条覆盖 1.1/1.2 两分组默认
折叠与展开、默认层的完整子目录、`↓` 进入列表且**夹住不环绕**、**真翻页**（`walkMarks` 三段计时 +
`scrollTop` 变化）、"当前行一直留在可视区内"、悬停移动/离开光标、展开/折叠后当前行不动、预置项
`Enter` 真的落盘（`Enter on a preset really lands the folder in the chat box (m01272 b)`）且落的是
预置项**自己**那层（`and it landed the preset's own folder, not a neighbour level`），以及健康路径
无 `alert`。两条真机缺陷（悬停抢行、焦点被 shell 抢走）都是先由这个探针红出来的，再回代码修、
补单测、重跑变绿——单测环境（jsdom 无布局、无 shell）**不可能**发现这两条。

口径 (3) 的推论（一并记下，作为实现契约的一部分）：`Esc` 的"逐级退出"**不含展开态**——
展开不替换兄弟行，没有"返回"语义；退层请用 `⬆ 上一级`。这一点 A.18.4 表中已写。

### A.19 第二十轮：B-10 端到端真翻页 + A-08b 含 `@` 重用的 dock 直接断言

本轮把 §8 里最后两条欠账收口（B-10 的真翻页证据、A-08 遗留的"重用一条自带引用的消息后 dock 亮"
直接断言），并订正四处陈旧读数。改动落在两仓：

- 插件仓 `E:\Eason\Rust\DSH\dsh-atlas`：`src/client/FrameCursor.tsx`（和弦复位的身份信号 + `commit` 标记）、
  `tests/history-cursor.spec.tsx`（新增 A-13 + A-26 用例）。
- harness 仓 `D:\deepseek-harness`：新增 fixture `snapshots/web/history-walk-long/session.v3.jsonl`（与它的
  `snapshot.yml`）与层覆盖文件 `apps/web/tests/history-jump.overlay.yml`（此前一直被 spec 引用却**没有入库**，
  本轮一并补上）、`apps/web/tests/history-jump.e2e.ts` 新增 describe
  `web e2e: history jump, unloaded history (B-10 / A-08b)`。

#### A.19.1 B-10：首屏只装 24 轮，第 25 按才越窗，40/40 逐字

- fixture 是 40 轮 / 80 条**计入**消息（`packages/api/session-controller/src/history.ts:39` 的
  `MESSAGE_TYPES` 只计 `user/message` 与 `assistant/message`）。这里**新开**一个 fixture 而不是加长
  `history-walk`，是因为加长会同时改掉 A-16 的最旧一轮前提与 A-17 的 `.toBe(24)`。
- 开屏窗口：`packages/api/session-controller/src/client/sessions/session.ts:53` `PAGE_MESSAGES = 50`，
  `open` 只装 50 条消息 = **最新 24 轮**（turn 17..40，48 条计入消息）。因此 turn 1 的完整原文在首屏
  DOM 里**不存在**：`packages/session/session-turn-outline/src/projection.ts:29`
  `PROMPT_PREVIEW_LIMIT = 50` 把它截成 49 字 + `…`。
- 证据：`Control+ArrowUp` 从草稿槽起一按一按往上（每按轮询 composer 文本，间隔 120ms、上限 200 次），
  **前 24 按**落在已装帧上（turn 40→17），**第 25 按**才触发翻页并落到 turn 16；40 按后累计文本与
  fixture 的 40 条用户原文**逆序逐字相等**；**第 41 按**第一次报"已到最旧"（poll 读数条含
  `Oldest loaded message`），且此时 composer 里正是最旧一轮原文。
- 跑法：`cd D:\deepseek-harness; pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/history-jump.e2e.ts`。
  该车道装的是**构建产物** `lib/client.js`（`apps/web/tests/history-jump.overlay.yml` 覆盖），所以任何
  `src/` 改动后必须先 `pnpm run build`。
- 两条 spec 会互相继承现场（B-10 结束时停在最旧帧、composer 持 turn 1 原文），故该 describe 补了
  `beforeEach(async () => { await page.reload({ waitUntil: 'load' }); await openSeededSession() })`
  （与 B-09 同款的重置），让任一条失败不替另一条做决定。

#### A.19.2 本轮真红出来的缺陷：翻页把和弦光标打回草稿槽

- 首轮 B-10 红在 `expect(seen).toEqual(expected)`：`expected [ …(26) ] to deeply equal [ …(40) ]`。
  根因：翻页把一条 outline **预览**帧换成**已加载**帧，`quickFrames` 由 41 变 40，而当时和弦复位的
  信号是"帧数变了" ⇒ 复位 `setQuickSlot(0)`，和弦从草稿槽重开，第 25 按之后整条走查从头开始。
- 修法一（`src/client/FrameCursor.tsx:636-646`）：复位信号改成**最新用户帧的身份**（`newestQuickTurn`），
  并且只在上一轮不是"同一轮内仍在跑"时复位——帧数变化本身不再触发重置。
- 修法二（`:404-405`、`:1006-1031`、`:448-469`）：`Enter` 落到 unloaded 帧时不能立刻写草稿（内容还没到），
  改为记 `pendingReuse = { turn, commit: true }` 并 `loadThrough(seq)`；等 `:448-469` 的结算 effect
  找到同名**已加载**帧后再 `reuse(frame)`，并按 `commit` 把相位收回 `idle`（否则 roam 读数条会挂在
  屏幕上，用户还得自己按一次 `Esc`）。
- 变异证据：把复位信号改回"帧数变化" ⇒ jsdom **全绿**（重复的 outline 行会被 `turn` 去重，帧数没变，
  jsdom 看不见这条），**只有 B-10 浏览器车道红**；把 `commit` 尾部删掉 ⇒ jsdom 红在 Enter 半边的
  `expect(roamBar()).toBeNull()`。两条都先红后绿。

#### A.19.3 A-08b：重用一条自带引用的消息后，dock 真的亮

- 判据是"引用从草稿**文本**里被识别"，与怎么打进去的无关。dock 行对**解析不到**的目标也会出现
  （带 已失效 徽标，见 `FilesDock.tsx:226,266-267`），所以这条不需要本页能解析 `package.json`。
- 手势与断言链：`beforeEach` 重载 → 断言起始草稿**不含 `@`**、`dock.count() === 0` → `Escape`（进 roam）
  → 一次裸 `ArrowUp`（roam 的走查从草稿槽起步，所以这一按就到**最新帧**，即 turn 40，带 `@package.json`）
  → `Enter` → `roam` 复位 → composer 文本**逐字**等于 `userTexts.at(-1)` 且含 `@package.json` →
  `dock.count() === 1` 且 `dock.innerText` 含 `package.json` → `tripwire.pageErrors` 为空。
- 起始态为什么不是"composer 为空"：**app 会持久化草稿**并在重载后恢复。整文件跑时重载后 composer 里是
  B-10 最后一次重用写进去的 turn 1 全文（无 `@`），单独跑 A-08b 时才是空的——实测先红在
  `expected 'HISTORY-1: question number 1 in this …' to be ''`。默认 `historyJumpReuseMode` 是
  `replace`（`src/contract.ts:507`），残留草稿会被**整段替换**，所以"起始不含 `@`"就足以让末尾 dock
  亮起来成为本次重用的功劳。
- 调试留档（避免后来者重走）：这条最初一直红在 composer 为空。
  `DIAG2 imm="" later="" roam=null t1=reuse turn=40 len=134 active=composer t2=enter slot=1 idx=39 frame=40/loaded/len=134`
  ⇒ 目标帧、写入长度、焦点全对；`DIAG3 imm="" later="" n=1 dump=DIV/true/"" dock=0 dockText="<none>"`
  ⇒ 页面上只有一个 composer、插件侧 dock 也没亮，写入**没进**会话发布的输入状态；
  `DIAG4 imm="" later="" lenAfterEnter=0 handDock=1 lenAfterTyping=14 roam2=true second="HISTORY-40: question number 40 in this l"`
  ⇒ 同一状态下**手工键入** `@package.json `（14 字符）能点亮 dock，且插件 `draft` prop 与可见 composer
  同步，而"先按一次真实键、再做同样的 Escape→ArrowUp→Enter"就**成功落地**。结论：被静默丢弃的只是
  `Control+a`/`Delete` 清稿（叠加 B-10 现场）之后**第一次**程序化 `setDraft`——那是测试自己制造的现场，
  不是产品缺陷；因此不去改那条只属猜测的既有路径
  （`packages/client/ui-conversation/src/client/input/editor/runtime.ts:150` 的
  `if (clean === this.projection.clipboardText) return`），而是让 A-08b 不落进这个状态：
  `beforeEach` 重载 + 删掉清稿手势。`resetToCleanDraft()` 本身仍被 B-10 使用，未删。
- 变异证据：把 `reuse()` 的分支写成 `: frame.text.replace('@', '')`（丢 token）⇒ B-10 **与** A-08b
  都红（A-08b 红在逐字断言上），说明这条链对"token 是否真的落进 composer"是承重的。

#### A.19.4 新增 jsdom 用例（A-13 + A-26）

`tests/history-cursor.spec.tsx` 新增 `keeps a chord-deferred walk — and the draft it stashed — alive,
where Enter commits (A-13 + A-26)`，两半各自独立挂载：

- 和弦半边：outline 里给一条 unloaded 预览帧（`prompt: 'truncated previ…'`），`loadThrough` 被注入
  `{ turn: 2, seq: 22, … }` 后断言 **`asked = [22]`**、草稿里出现 turn 2 的**完整原文**（不是预览文本）、
  roam 读数条上是完整原文且**不含** `zh['history.draftSlot']`，最后 `End` 交回用户自己的 `my own words`。
- `Enter` 半边（另起一次挂载）：`Escape` → `Home` → `Enter`，同样 `askedAgain = [22]`、写入完整原文、
  且 `roamBar()` 为 `null`（相位已回 `idle`）；此后草稿里**不**含 `my own words`——这条路径本就没有
  可交回的 stash。
- 承重性：`commit` 尾部被删（§A.19.2 第二条变异）时，恰是 `Enter` 半边红。

#### A.19.5 本轮读数与陈旧读数订正

- 插件仓 `pnpm run check`（typecheck → test → build → verify:publish）**EXIT=0**：jsdom
  `Test Files 40 passed (40)`、`Tests 966 passed | 1 skipped (967)`（13.47s）；build
  `lib/index.js 655.7kb`、`lib/client.js 883.3kb`；`[verify-publish-surface] ok — 65 files, no internal
  artifacts, ad-free bundle`。
- harness 浏览器车道（整文件）：`Test Files 1 passed (1)`、`Tests 15 passed (15)`，36.10s；其中
  **B-10 2477ms**、**A-08b 1076ms**。
- 本轮为取证插入的临时插桩（插件侧 `data-atlas-trace`、`data-atlas-trace2`、`data-atlas-draft-len`，
  harness 侧的 DIAG3/DIAG4 块）**全部删除**，复核 `Select-String 'atlas-trace|atlas-draft-len|TEMP PROBE' src` = 0。
- 陈旧读数订正：§8 的 C-01（`36 files` → `40 files / 966 passed + 1 skipped`，并补记
  `[verify-publish-surface] ok`）、§A.5.3（其 36 文件 / 755 通过 + 4 跳过 标注为**当轮读数**并指向 C-01）、
  §A.18.9（`940` 标注为**当轮读数**并指向 C-01）、A.14/A.15 标题补状态标记（A.14 已实施并通过验收；
  A.15 已实施，其列表一侧的键位与验收已由 §A.18 修订）。

#### A.19.6 发布到 guest（真机验证）

- 源：宿主构建产物经共享目录 `/mnt/EShare/Eason/Rust/DSH/dsh-atlas/lib`（`client.js` **904484** 字节、
  `index.js` **671245** 字节，`Oct 7 16:59`）；目标：
  `/home/omarchy/.dsh/profiles/web/node_modules/@sidequest-007/dsh-atlas/lib`（原 `client.js`
  **904370** 字节、`Oct 7 15:01`，即上一轮发布的产物）。
- `cp -f` 两个文件后 `cmp` 双向核对 ⇒ `CP_OK`、`CLIENT_CMP_OK`、`INDEX_CMP_OK`（磁盘字节一致）。
- **这两个单元是 `systemctl --user` 级的**（`sudo systemctl` 会报 `Unit dsh-web.service not found`）：
  `dsh-gui-guard.service`、`dsh-web.service` 均 `enabled enabled`；系统级只有无关的
  `dsh-harden-egress.service`。发布顺序实际执行：`systemctl --user stop dsh-gui-guard.service`（EXIT=0）
  → `sleep 2` → `cp -f` + `cmp` → `systemctl --user restart dsh-web.service`（EXIT=0）→ 轮询
  `curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/`（`HTTP=000` 连续 18 次，
  随后 `404`、`401`，即冷启动完成）→ `systemctl --user start dsh-gui-guard.service`（EXIT=0）→
  `sleep 8` ⇒ `systemctl --user is-active` 两个单元都是 `active`。
- **换了新 bundle 的证据是 pid 变了**：`ss -ltnp | grep 3080` 由
  `pid=113916`（旧）变为 **`pid=120311`**（新起的 node 进程），且磁盘上的 `client.js` mtime 已是 `Oct 7 17:10`。
- 两个操作教训（都记在这里，免得下次重踩）：① `sudo systemctl` 找的是系统级单元，本机 GUI 的单元在
  `--user` 级，用 `sudo` 只会得到 `not loaded` / `not found` 而**服务其实一直活着**（`curl` 仍回 401），
  看起来"发布失败"其实只是没重启；② pwsh here-string 经 `ssh … 'bash -s'` 进 bash 时行尾是 CRLF，
  末行会把 `\r` 粘进参数（stderr 可见 `Invalid unit name "dsh-gui-guard.service\n" escaped as
  "dsh-gui-guard.service\x0d"`），正确做法是先落盘成 LF
  （`[System.IO.File]::WriteAllText($tmp, $script -replace "`r`n", "`n", (New-Object System.Text.UTF8Encoding($false)))`）
  再 `Get-Content -Raw $tmp | ssh … 'bash -s'`。

#### A.19.7 guest 真机按键级验证（A-27 草稿 token / A-29 翻页 / A-31 scoped 插件名）

§A.20.5 留的待办，2026-10-07 夜间补做。对象是 **22:50:16** 起的 guest `dsh-web.service`（`MainPID=138288`），
`~/.dsh/profiles/web/node_modules/@sidequest-007/dsh-atlas/lib/{client.js,index.js}` 与宿主构建产物
**逐字节相同**（`cmp` 双向 OK；`client.js` **906517 B**、`index.js` **671659 B**）——即 §A.20 的 `lib/`
**加上本轮尚未提交的 `DraftLinks` 台账接线**（草稿 token 也走 `repeatClick`/`noteClick`，由
`src/client/index.ts` 注入）。驱动用 `.scratch/guest/cdp.mjs` 直连 `127.0.0.1:9333`，会话即当前这条
（workspace `/mnt/EShare/Eason/Rust/DSH`）。

**A-27：文件夹两次点击在草稿 token 上成立。** 把 `@dsh-atlas ` 放进 composer（词法编辑器里的
`<span data-composer-text-ref>`），**刷新页面拿到空台账**后逐击，每击前用"静默门"等到
`xdg-open|gio open|nautilus --new-window` 的 pid 集合连续两次相同，再取击后的 pid 集合差：

| 手势 | 右侧栏 | 新起的本地进程 |
|---|---|---|
| 第 1 击 `23:17:53.187` | `hasFolder=true`、`path=/mnt/EShare/Eason/Rust/DSH`、172 行、`selected=["dsh-atlas/"]` | **无** |
| 第 2 击 `23:17:56.668` | 同上（不动） | `145595 /bin/sh /usr/bin/xdg-open /mnt/EShare/Eason/Rust/DSH/dsh-atlas`、`145698 nautilus --new-window …/dsh-atlas` |

- 第 2 击的实参是**绝对路径**、且落在文件夹本身（不是它的所属目录），与 §A.20.1 的 A-27 判据一致。
- 有静默门才敢归因：第一轮没这道门时读到的是 `native, sidebar, native, native` 的乱序，事后确认是
  **沿用上一轮遗留的台账** + 把上一击的残留进程算进下一击，不是产品行为。空台账的 1/2 击是干净的
  sidebar → native 交替。因此 §A.20.5 记的"两次点击截图几乎一样"只是**第二条证据缺失**（截图看不见
  OS 窗口），不是行为没发生。
- 台账是**每会话一份**且只在她真正开出东西时记录：刷新即清空，所以"空台账 ⇒ 第 1 击必是 sidebar"
  这条可以被当作用例的确定性起点。

**A-31：scoped 插件名在真机成立。** composer 里 `@plugin:@sidequest-007/dsh-atlas `（尾随空格）：
`editorText` 是**一个** token；`[data-atlas-dock]` 恰好 **1 行**，`path=@sidequest-007/dsh-atlas`、
`missing=false`——**没有 file 幽灵行**；框架自己只画到 `@plugin:@sidequest-007/`（`TEXT_REF_RE` 的
`[\w-]+` 停在 `/`），其余由插件自绘，与 AGENTS.md 记的"框架匹配器比插件词汇窄"一致。

**A-29：翻页在真机按键级成立，但 §A.20.1 的夹具恒等式没有复现。** armed 一个 capture/bubble 两相
`keydown` 记录器后按 `PageDown`：只收到 **capture** 一条、`defaultPrevented=true`（插件
`preventDefault` + `stopPropagation`，bubble 那条因此收不到），**菜单保持打开**。

- 裸 `@`（插件自己的 band 全在可视区）：高亮在 band 内翻页并**两端夹紧**——`文件F`（整表 idx 70）
  → `PageDown` → `GitG`(75) → `PageUp` → `文件F`(70) → `PageUp` → 仍 70；`scrollTop` 2658 与可视集
  64…75 全程未动（高亮始终在可视区内，框架的 `block:'nearest'` 是 no-op）。
- `@file:`（插件组 20 行、行高 40、列表高 486 ⇒ 一页 12 行，组比可视区高）：`PageDown` 把高亮送到
  底边并让框架把它滚进视野——`scrollTop` 0 → **186**、可视集 0…11 → **3…15**，"焦点必须可见"这条
  用户口径成立。
- **A-29 修的是两条路径里的第二条，两条要分开读**：
  - 高亮是**插件自己的行**（裸 `@`、`@file:`）：插件只**移动高亮**，滚动交给框架的 `block:'nearest'`，
    所以落点是"高亮贴底边、上方仍是满满一页"——夹具那条恒等式在这条分支里**不适用**。
  - 高亮是**另一个 `@` 源**的行：插件自己滚视口。现场用 `@a` 造出（`hlSource="reference"`、高亮停在
    整表 idx 0），读数与代码里的 `box.scrollTop += direction * page`（`page = box.clientHeight`）逐项对上：
    `scrollTop` 2486 → **2983**（+497 ≈ `clientHeight` 498）→ **3246**（= `scrollHeight` 3744 − `clientHeight`
    498，**底端夹紧**）→ `PageUp` **2748**（−498，精确回退）；全程 `hlIndex`/`hlSource` 不变（不抢别的
    源的高亮）。**并且**可视集 60…71 → **71…84** → 78…90：**上一页的最后一行正是下一页的第一行**——
    正是 §A.20.1 的恒等式（真机的行高/表高与夹具不同，所以 `scrollTop` 的绝对值不是夹具的 80）。
  - 订正：上一轮记录说这条恒等式"未复现、是唯一缺口"，原因只是当时只造了第一条分支的现场；本条实测
    把两条分支都跑到了，恒等式在真机**成立**。
- 期间两次 `menu:false` 都是脚本自造的状态（`Ctrl+A` 清稿后编辑器丢焦点，脚本又用
  `execCommand('selectAll')` 顶上去），不是产品行为；同一按键连按三次复现的是上面的读数。

**追加（2026-10-08 下午）：m02155 的两次点击在 guest 真机成立（`@dsh-atlas/lib/types/client/`）。**
上一轮的 A-27 两次点击测的是**顶层**文件夹 `@dsh-atlas `/`@dsh-atlas`；m02155 报的是**多段相对**文件夹，
本轮补的就是这一条。对象是重启后的 guest `dsh-web.service`（`127.0.0.1:3080` 在听、页面已过 token 认证）；
打开的会话 cwd 是 **`/mnt/EShare/Eason/Rust/DSH`**（会话按 cwd 分目录存：
`~/.dsh/sessions/--mnt-EShare-Eason-Rust-DSH--/session-44b699d3-a464-487d-8e1d-d6e9ad20e29e/session.v3.jsonl.zstd`），
所以正确的草稿 token 是 **`@dsh-atlas/lib/types/client/`**。已发布产物：guest
`~/.dsh/profiles/web/node_modules/@sidequest-007/dsh-atlas/lib/client.js` = **906760 B**、
`sha256 55ebc2c0a6e71e86c86f7a2e5ded10ca9ac15e85dc6f142a825f219da1bfe024`，与宿主本轮构建（`043212a`）逐字节相同；
驱动仍是 `.scratch/guest/cdp.mjs`（真 `Input.dispatchMouseEvent`，不是 `element.click()`），探针
`.scratch/guest/{tok,folder-mini,dock}.js` 经 `.scratch/guest/eval-file.mjs` 注入。

**页面里跑的确实是这一版**：`.scratch/guest-bundle.mjs` 从 `performance.getEntriesByType('resource')` 取实际下载的
脚本并算 sha256 —— `resourceCount 78`、`bytes 16773515`、`hostResolvedFolder` **2** 处、m02155 的告警串
`this folder has no absolute path to open` **1** 处。（`shaMatch False` 是预期的：服务端把多个插件合并进一个带
`??` 的批 URL，页面里的 URL 本就不等于单文件 sha。）

**两次点击的读数**（`clear` → `paste '@dsh-atlas/lib/types/client/ '`，空台账起点；两次都点在**同一个**
`<span data-composer-text-ref>` 上、真鼠标事件；右栏出现后 composer 位移，脚本按元素中心重新定位，
坐标从 `(429,1311)` 变到 `(345,1271)`，不是写死坐标）：

| 手势 | 右侧栏 | 新起的本地进程 |
|---|---|---|
| 第 1 击 | `rightbar=520`、`hasFolder=true`、`path=/mnt/EShare/Eason/Rust/DSH/dsh-atlas/lib/types`、22 行、`selected=["client/"]` | **无** |
| 第 2 击 | 同上（不动） | `241339 /bin/sh /usr/bin/xdg-open /mnt/EShare/Eason/Rust/DSH/dsh-atlas/lib/types/client`、`241459 nautilus --new-window /mnt/EShare/Eason/Rust/DSH/dsh-atlas/lib/types/client` |

- 第 2 击的实参是**宿主解析出的绝对路径**、且**落在文件夹本身**（不是它的所属目录）——这正是 m02155 的判据：
  旧的客户端绝对化（`absoluteReferenceOf` ← `sessionWorkspaceRoot`）在这里要么给出混分隔符的
  `E:\Eason\Rust\DSH\dsh-atlas/lib/types/client` 拼写，要么摘要无 cwd 时只剩 `console.warn` + `'gone'`；
  现场 `xdg-open` 拿到的是宿主 `atFile/list` 回传的规范拼写，也正是文件夹页「在系统中打开」共用的那条 `openPath`。
- 第 1 击呈现的是**所属目录 + 子项高亮**，不是"文件夹页直接列该文件夹"：这是 A-27 对文件夹的既定口径
  （`src/client/index.ts:1017-1031`：`if (resolveSidebarRight(ctx) !== undefined) return openOwningFolder(sessionId, link)`，
  注释写明 the tree roots at the folder's parent and the user lands on the folder itself），与上表顶层文件夹的读数同形。
- **一个观察（本轮未深究机制）**：草稿里框架只把 **`@dsh-atlas`** 画成 token chip、`/lib/types/client/ ` 留在纯文本里，
  而 dock 按插件自己的 token 文法把整段解析成 1 行（`path=dsh-atlas/lib/types/client`、`missing=false`）；
  上一轮那个 `@lib/types/client/` 却整段被画成了一个 chip。两次都是纯文本 `Input.insertText`，差别只在第一段
  是不是工作区里**已知的名字**。现象记在此处：与 A-31 的"框架匹配器比插件词汇窄"同源，但分叉的边界不同。

**反面对照（同一页面、同一驱动）**：把草稿换成 `@lib/types/client/`（该会话 cwd 是 `/mnt/EShare/Eason/Rust/DSH`，
`lib/…` 在它下面**确实不存在**）⇒ dock 行 `missing=true`（`src/client/FilesDock.tsx:224` 的 `info.exists === false`），
第 1 击 **`rightbar=0`、`hasFolder=false`**：`openReferenceTarget` 的 `exists === false` 闸门
（`src/client/index.ts:1007-1012`）先于任何打开动作、安静返回 `'gone'`。这条同时钉死两件事：
① 探针能分辨"开了"与"没开"，所以上面的 `hasFolder=true` 不是假绿；② 最初 `.scratch` 里那个「已失效」
是**会话 cwd 不匹配**（我一开始按 `@lib/types/client/` 的相对根去测），不是 m02155 的复现。

**环境备注（与产品无关，免得下次误判成回归）**：本轮开头 guest 的 GUI 是死的 —— `ss -ltn` 里没有 `3080`、
Chromium 停在 `chrome-error://chromewebdata/`（正文「无法访问此网站…ERR_CONNECTION_REFUSED」），
`dsh-gui-guard.service` 在反复重启 `dsh-web.service`，而 guard 那个 Chromium app-window 的 URL 里带着 9.7 小时前
就已失效的 token。`systemctl --user stop dsh-gui-guard.service` → `stop dsh-web.service` → `start dsh-web.service`
之后 `LISTEN 0 511 127.0.0.1:3080` 恢复。驱动用的 CDP 仍是 guard 的 Chromium
（`--remote-debugging-port=9333`、`--user-data-dir=/home/omarchy/.local/share/dsh-gui-guard/profile`）。
截图证据：`.scratch/guest/ev-a197-folder-click2.png`。

### A.20 第二十一轮：文件夹两次点击、工作区内的绝对路径、单一当前项与翻页连续性、展开后的 Enter、scoped 插件名（**已实施**）

本轮把 m05904 一次报出的五条缺陷逐条落进 §8 的 A 段（`A-27`…`A-31`），并在同一轮补齐回归单测。五条里四条是**手势与呈现**（文件夹两次点击、翻页连续性、列表里只有一个当前项、已展开的行 Enter 折叠），一条是**识别**（scoped 插件名）；A-28 表面上像"路径识别"，实际是**权限闸门的适用条件**写错了——工作区内的绝对拼写被当成工作区之外的引用。
**追加（2026-10-08）**：用户随后复报了同一条链路里的第二个文件夹缺陷，落成 `A-32`（第二次点击的绝对路径改由宿主解析），见 §A.20.6。

#### A.20.1 判据与断言链

- **A-27**：一次点击后右侧栏收到的是**该文件夹的所属目录**地址（`dsh-resource://folder/…`）且带 `select`，并且**没有**本地打开；第二次点击后本地打开收到的是**绝对路径**（`openPath` 的实参）。第五个用例走反面：会话没有 `cwd` 时**不许编造路径**，只允许 `console.warn` + `'gone'`。
- **A-28**：同一个文件/文件夹用**绝对拼写**与**相对拼写**必须产出**同一条**引用（`<workspace-reference>`、source 的 `relative` 相同、**不进外部台账**）；同时越界行为**一格都不许松**——`@../secret.ts`、`@src/../../secret.ts` 即使在完全权限下仍 `[]`，无权限的越界绝对路径仍被拒。
- **A-29**：翻页后可见行集合**恰好**是"上一页的最后一行 + 后续四行"，`scrollTop` 等于"少一行的整页"（夹具固定 100px 列表、20px 行：5×20 − 20 = 80）；列表里同时只有**一个**高亮来源（行不再自带 `:hover` 底色）。
- **A-30**：对一个**未探测**（`hasChildren === undefined`）的文件夹先探、展开、再按 Enter ⇒ **折叠**——这正是用户报的顺序，也是旧行为唯一走不到的分支。
- **A-31**：`@plugin:@sidequest-007/dsh-atlas` 在**四处**都只有一个 token / 一行：`scanMentions`（宿主识别）、`draftMentions`（输入框 dock，且**不得**出现 file 幽灵行）、`PLUGIN_MENTION_PATTERN` 的匹配、`expandPluginMentions` 向宿主索要的模块名；外加 `draftPathForLabel` **不得**把 scope 读成文件路径。

#### A.20.2 变异证据（反向验证：把修法改回去，对应用例必须转红）

- A-27：第二次点击改回 `openReferenceTarget`（两次都开侧栏）⇒ `hands a FOLDER to the desktop file manager on the second click (m05904)` 转红；删掉 `resolveOwningDir` 的 `''` 分支 ⇒ 用户被丢到 Host 的浏览根而不是工作区。
- A-28：把 `inside` 判定删掉（恢复"绝对即外部"）⇒ `accepts an absolute token inside the workspace and refuses those that escape it` 转红（工作区内的绝对拼写又变回外部/失效）。
- A-29：把滚动的 `+ row.height` / `- row.height` 去掉（恢复"刚好可见"）⇒ `keeps the row that was last on the page as the first row of the next` 的可见行集合与 `scrollTop()` 同时不符。
- A-30：`action` 改回只看 `hasChildren`（删掉 `isOpen` 那一支）⇒ `collapses a folder it had to look at first, on the second Enter (m05904)` 转红。
- A-31：`MENTION_TOKEN` 改回 `[^\s@]+`（scoped 名字又被劈开）⇒ 五条 R5 用例同时转红；把 `String.raw` 去掉（`\s` 退化成 `s`）⇒ **29 条既有用例**转红——这条最贵，已在 `src/tokens.ts` 用注释钉住。

#### A.20.3 本轮读数

- `pnpm run check` 全绿：typecheck（`tsc --noEmit`）+ test + build + verify:publish，`Test Files 40 passed (40)`、`Tests 974 passed | 1 skipped (975)`、`Duration 21.83s`、退出码 0；四个被改动的 spec 单跑为 `Test Files 4 passed (4)`、`Tests 117 passed (117)`，新增的 `tests/draft-links.spec.tsx` 单跑为 `Test Files 1 passed (1)`、`Tests 34 passed (34)`。
- 产物：`lib/index.js` **671659 B**、`lib/client.js` **906517 B**；bundle 读数 `lib/index.js 656.1kb`、`lib/client.js 885.3kb`；`[verify-publish-surface] ok — 65 files, no internal artifacts, ad-free bundle`。
- 改动面：`git diff --stat HEAD` = **29 files changed, 776 insertions(+), 245 deletions(-)**（`src/`：`tokens.ts`、`mention.ts`、`reference.ts`、`references.ts`、`client/{DraftLinks,FilesDock,FolderPicker,ReferenceLinks}.tsx`、`client/{index,locales,reference-links,styles}.ts`；`tests/`：`mention.spec.ts`、`reference.spec.ts`、`references.spec.ts`、`folder-picker.spec.tsx`、`dock.spec.tsx`、`apply.client.spec.tsx`、`reference-links.spec.tsx`、`draft-links.spec.tsx`；`lib/` 重新构建。这份 diff 已含把台账接到草稿 token 的那三处改动）。
- **订正**：本节最初写的 `973 passed | 1 skipped (974)`、`lib/client.js 905757 B`、25 files / 541+ / 221− 是**草稿 token 那套接线之前**的读数（当时 §A.20.5 还标着"提交前待补"）；把草稿 token 计入后重跑，就是上面的 974 / 975、906517 B、29 files。§A.19.5 与 C-01 记的 `966 passed + 1 skipped` 是第二十轮读数，C-01 已同步改成本轮数字。

#### A.20.4 口径变更与已知张力

- **A-27 取代了 m02489 的裁定**：此前文件夹只走右侧栏、由设置项 `folderOpen` 决定（`both`/`sidebar`/`native`）；本轮改为**点击台账**驱动的一、二两次点击。旧设置项与它的宿主更新分支仍在（`src/contract.ts`、`src/settings.ts`、`src/index.ts`、`src/client/index.ts`），设置卡已不在 `src/client/SettingsSection.tsx` 里，字段只为保住旧安装的存储形状——**这是一处真实的口径冲突，已按"更新的用户要求优先"落地**，以后再想回到"设置项说了算"必须先把 A-27 的手势撤掉。
- **A-28 的边界**：只有"绝对且在工作区内"才收敛；绝对且越界仍走外部台账 + `allowsExternal`，所以"完全权限下什么都能读"这条既有语义没有被放宽。
- **A-31 的边界**：`@plugin:` 类别标签依然是 inert 的（`isInertHandle`），本轮修的是**识别**（一个 token / 一行 / 一次注入），不是把插件的 scope 变成可点链接。

#### A.20.5 待办

- guest（omarchy）真机上的**按键级**测试尚未做：本轮只跑了 jsdom 与构建期验证，没有在真机 xterm 里逐键核对翻页连续性、点击台账与 scoped 插件名的呈现。若要做，记录写 §A.19.7。
- **→ 已做（2026-10-07 夜），见 §A.19.7**：点击台账（草稿 token 上的 A-27）、scoped 插件名（A-31）、
  以及 A-29 的两条翻页路径（移动高亮 / 插件自滚视口）都在真机按键级复现；§A.20.1 的恒等式属于后一条
  分支（真机 `@a` 现场：可视集 60…71 → 71…84）。
- **→ 已补（Windows 侧，2026-10-08 凌晨）**：这份改动跑过完整 `pnpm run check`（`Test Files 40 passed (40)`、
  `Tests 974 passed | 1 skipped (975)`、退出码 0、`lib/client.js` 906517 B、`[verify-publish-surface] ok —
  65 files`），读数并入 §A.20.3；`pnpm run typecheck` 与直接 `node node_modules/typescript/bin/tsc --noEmit`
  在本机都是**退出码 0**（与下面那条 guest 侧的红对照）。
- **补记（2026-10-07 深夜，guest 侧实测）：`tsc --noEmit` 现在是红的，而且与这份改动无关。**
  仓库自带的 typescript **6.0.3**、`node_modules/typescript/bin/tsc --noEmit`，工作树报 **8 条**：
  `src/client/SettingsSection.tsx(121,3)` "Property `useSessions` does not exist" + 5 条级联的
  `TS7006`（151/172/177/178/184，`useSessions` 解析失败后快照参数失去类型），
  `src/client/index.ts(1319,66)` 与 `(1378,66)` "Property `useSession` is missing … but required in type
  `HistoryStandardProps`"（`FrameCursor` / `HistoryPalette` 在 `conversation.input.overlay` 上的注册）。
  **排除本轮改动**：把 HEAD 原样 `git archive` 到 `/tmp/atlas-head`（`node_modules` 软链回本仓）再跑，
  同样红——报错文件里 `SettingsSection.tsx`、`history-keys.ts`、`FrameCursor.tsx`、`HistoryPalette.tsx`
  对 HEAD 都**未修改**。
  根因是插件的 harness 依赖全是 `link:../deepseek-harness/packages/...`，而那个 checkout 已是
  **0.1.6-alpha.1**：`SessionStandardProps` 在 ui-slots 里已是**空接口**（`src/index.ts:194`），由
  ui-conversation 合并 `useConversation`/`useInput`/`inputActions`，**不再有 `useSession`**；而
  `useSessions` 现在只在 `GlobalStandardProps` 上（`client/ui-session/src/client/index.ts:107` 合并）。
  0.1.6 的真实用法见 `client/ui-chat/src/client/chat/ChatView.tsx:238-239`：
  `useSessions(s => s.byId[sessionId]?.cwd)` 取列表，`useSession(s => s.running)` 是**父级单独递给它的**
  组件私有 prop，`conversation.input.overlay` 这种 slot 拿不到。所以：
  - `FrameCursor`/`HistoryPalette` 要么改挂到能拿到 `useSession` 的 slot，要么把"有回合在跑"换成
    0.1.6 的选择器（`useSessions`/`useConversation` 里等价的那一位）；
  - `SettingsSection` 的 `useSessions` 需要让 `client/ui-session` 的那条 `declare module` 进入本仓的
    编译程序（它现在只 import 了 `@deepseek-ai/dsh-api-session-controller/client`）。
  这两条都属于 **0.1.6 客户端 API 迁移**（不是台账改动的产物），方向清楚但取哪个等价选择器是作者口径，
  因此本轮只记录诊断，未改源码。

- **Windows 侧对照（2026-10-08 凌晨，同一工作树、同一份仓库自带 typescript 6.0.3）**：`pnpm run typecheck`
  与直接 `node node_modules/typescript/bin/tsc --noEmit` 在本机**都是退出码 0**；`node_modules/@deepseek-ai/`
  下 `dsh-api-session-controller`、`dsh-client-ui-slots`、`dsh-client-ui-conversation` 也**都是 0.1.6-alpha.1**，
  且 `dsh-client-ui-slots/lib/types/index.d.ts` 里那份 `SessionStandardProps` 确实已经是**空接口**。⇒ 上面那 8 条红是
  **guest 侧那条解析路径上的现象，不是这份源码树的编译结论**；本轮**以 Windows 侧读数为准提交**，guest 侧的红留作
  环境待查（两侧 `node_modules` 同在一个 CIFS 共享目录，差异未进一步定位；用户已暂停 guest 侧会话）。
- **覆盖率**（`npx vitest run --coverage`，本轮）：全仓 `All files 90.69 / 85.99 / 87.2 / 93.09`；
  `src/client/DraftLinks.tsx` **87.71 / 81.25 / 88.46 / 93.33**，未覆盖区间 `src/client/DraftLinks.tsx:165-170`
  ——那是既有的 `onStructure` MutationObserver 回调（`addedNodes` 里找回 composer 根后重新 `attach()` + `schedule()`），
  与本轮新接的 `repeatClick`/`noteClick` 无关，后者由 `tests/draft-links.spec.tsx` 覆盖。
  `vitest.config.ts` 仍**没有** thresholds（见 C-01），不设门禁。

#### A.20.6 第二次点击的绝对路径改由宿主解析（m02155，**已实施**）

用户复报（`m02155`）：「@lib/types/client/ 第二次点击 没能打开 资源管理器 且打开 client 文件夹；Omarchy 侧也是，
但我发现 omarchy 侧可以在第二次点击的时候调用和侧边栏『在系统中打开』一样的功能来将 client 打开」。
被点的 `@lib/types/client/` 是**真实存在的目录**（`tsc` 产出的类型声明目录，内含 `DraftLinks.d.ts`、
`FilesDock.d.ts`、`FolderPicker.d.ts` 等），不是笔误、也不是幽灵路径——这一点先核对过，所以问题在打开链路。

- **定位**：第一次点击走的是**宿主解析**（`dsh-resource://folder/lib/types`，由宿主按会话 cwd 解析），
  所以"第一次能打开正确文件夹"只证明**宿主**知道工作区在哪；第二次点击的绝对化**完全在客户端**
  （`absoluteReferenceOf` → `sessionWorkspaceRoot` → `sessions.list.getSnapshot().byId[id]?.cwd`），
  而那份摘要**可以不携带目录**，失败时只有 `console.warn('[dsh-atlas] this folder has no absolute path to open: …')`
  + `'gone'`，UI 上没有任何可见后果（chip 至多被标 stale）。用户在 omarchy 上看到**能**工作的那个按钮是本插件
  文件夹页自己的「在系统中打开」(`folder.system`)，它的实参是 `listing?.path` —— **宿主 `atFile/list` 回传的
  规范绝对拼写**，与第二次点击的来源不同，这正好是两者一个通、一个不通的分界。
  **诚实边界**：这是**诊断**，不是已取证的断定——客户端摘要为何缺 cwd 没有进一步取证（Windows 与 omarchy
  两侧都报同一现象）。但改法让这条分支**不再是唯一通路**：宿主答不出时仍回退到原来的算法，所以它只可能让
  "打不开"变少，不会把本来打得开的改坏。
- **判据**：`DirectoryListing.path` 是"所列目录的规范拼写（正斜杠）"（`src/contract.ts:153-162`）；
  宿主 `src/runtime.ts:206-239`：`:209 const cwd = agent.session.header.cwd`、
  `:212 const absolute = isAbsoluteReference(path) ? path : resolve(cwd, …)`、`:213 const canonical = externalPath(absolute)`，
  并且**即使目录缺失/越界也回传 `path: canonical`**（`:215/:220/:221`）。⇒ 一次 `atFile/list` 就是在宿主侧把
  引用解析成绝对路径的完整答案（`tests/runtime.spec.ts:236` 钉住 `path === slashed(join(cwd,'src'))`）。
- **改法**：新增 `hostResolvedFolder(sessionId, path)`（`src/client/index.ts:1107`）：先问宿主 `listDirectory`
  （= `atFile/list`，与文件夹页同一个调用）取 `listing.path`；宿主答不了（老宿主没有 list 端点、at-file 被设置
  关掉、或线上失败）时**回退**到原来的 `absoluteReferenceOf`（会话摘要 join）。`openNativeFolder` 因此变成
  `async`，把宿主给的规范路径交给**同一个** `openPath`（文件夹页的「在系统中打开」也是它）。
- **口径变更**：§A.20.1 里 A-27 的第五个用例写的是"会话没有 cwd 时不许编造路径，只允许 warn + gone"。
  现在仍然**不编造**——只是不再把"客户端不知道工作区根"当成"这个文件夹无法打开"：根由宿主给出。
  真正的 `'gone'` 只剩"宿主与摘要都说不出路径"这一种。
- **回归单测**：`tests/apply.client.spec.tsx` 新增
  `resolves a folder through the Host listing, so a summary with no cwd cannot kill the second click (m02155)`
  （boot 里**完全不给 `sessionList`**，只给 `atFileList`；第一次点击仍走本侧算出的
  `dsh-resource://folder/lib/types` 且**不列目录**，第二次点击必须 `atFile.list('s1','lib/types/client','')`
  并以 `{ path: '/ws/lib/types/client' }` 调 `openPath`）；既有的
  `hands a FOLDER to the desktop file manager on the second click (m05904)` 夹具没有 `atFile.list`，
  因此它现在钉的是**回退**那一支，注释已写明。
- **变异证据（2026-10-08 复核）**：把 `hostResolvedFolder` 改成只 `return absoluteReferenceOf(...)`、不列目录，
  只跑这条新用例 ⇒ **转红**，报
  `AssertionError: expected "vi.fn()" to be called with arguments: [ 's1', 'lib/types/client', '', …(1) ]`
  `Number of calls: 0`（`tests/apply.client.spec.tsx:975`）；改回后同一条用例恢复绿（`1 passed | 55 skipped`）。
- **读数**：这份改动之后 `pnpm run check` 全绿——`Test Files 40 passed (40)`、
  `Tests 975 passed | 1 skipped (976)`、退出码 0、`Duration 20.49s`；产物 `lib/index.js` **656.1kb / 671659 B**、
  `lib/client.js` **885.5kb / 906760 B**；`[verify-publish-surface] ok — 65 files, no internal artifacts, ad-free bundle`。
  相对 §A.20.3 记的 974 / 975 正好 **+1 条** = 新增的这条 m02155 用例。
- **真机验证**：Windows 侧 GUI 读的就是本仓库（两个安装名都 junction 到
  `E:\Eason\Rust\DSH\dsh-atlas`），本次只改**客户端半**（`lib/client.js` 906760 B / 2026-10-08 03:20:59），
  宿主半 `lib/index.js` 671659 B 未变 ⇒ **刷新页面即可生效**；refresh 后再对 `@lib/types/client/` 点两次
  （第一次右侧栏落在 `lib/types` 并选中 `client/`，第二次桌面文件管理器切到 `lib/types/client`）即可确认。
  **guest 侧已跑完**（2026-10-08 下午，`@dsh-atlas/lib/types/client/`，真机两次点击的读数、反面对照与环境备注
  见 §A.19.7 的追加段）：第 2 击真的起了 `xdg-open` + `nautilus --new-window …/dsh-atlas/lib/types/client`；
  Windows 侧这一次点击仍留给用户。



