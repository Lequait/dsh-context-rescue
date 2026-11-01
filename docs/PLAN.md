# 工作计划 — dsh-context-rescue

状态：**实现完成，验证全绿。** 下面每个阶段都在原地带着 `→ **passed**` 的证据行；仍未完成的都在代码之外——即
`docs/PUBLISH.md` 里的 npm 与列表收录步骤。这份文件是衡量代码的尺子，每个阶段都把证据写在结论旁边，读的人
可以自己去查那一条，而不必相信摘要。

## 1. 问题

当一个请求已经超过 provider 的*真实*上下文窗口、而宿主还以为有空间时，一个 DeepSeek Harness 会话就可能
变得无法挽救。这条失效链复现自上游报告（DSH 讨论 #10138）和本插件自己的模拟：

1. 网关用宿主分类器不认识的措辞拒绝请求（`payload core text alone is ~N bytes … no upstream can accept it`），
   于是这个错误没有被标成 `CONTEXT_WINDOW_EXCEEDED`。
2. 因为错误码不对，宿主自己的上下文溢出分支从不执行。
3. 因为溢出分支从不执行，没有任何东西会去缩小 surface，于是每次重试都重新发出一个*仍然*太大的请求。

用户看到的结果是：这个会话对每条消息都回 `400`，而手动 `/compact` 什么也不做——压缩尝试走的是同一个超大
surface（当有代理层接管压缩时还会被直接拒绝，例如 billion-context 的 `422 dsh_compaction_refused`）。

## 2. 设计契约

本插件是**事后急救**，不是预防式压缩器。它从不替换宿主的压缩引擎（`compaction` 服务只有一个槽，抢过来会破坏
`zeroModelOnly` 之类的配置和 `dsh-smart-compact` 那种滚动压缩）。它监听 `agent/request-error` waterfall——
无论宿主给的是什么错误码，*每一次*失败的请求都会触发它。

实现必须守住的属性：

| # | 属性 | 为什么重要 |
|---|---|---|
| P1 | 绝不破坏 surface | 一次改坏的写入是永久杀死会话，而不是暂时救不回来 |
| P2 | 可降级到零模型调用 | 要被救的失效场景往往正是"调不了模型" |
| P3 | 每轮每档最多重试一次 | 会循环的急救就是在烧用户的额度 |
| P4 | 帮不上就交回 | 假装成功会掩盖真正的错误 |
| P5 | 与代理压缩器共存 | 压缩权可能在代理层手里，必须让路而不是争抢 |

## 3. 阶段

### 阶段 A — 可行性（已完成）

对照宿主包逐条核实（本机 `0.2.1-rc.3`，registry 上的 `0.2.1-rc.5`）：waterfall 契约、`surfaceOp: replace`
写入协议、零模型的 `compaction/prune` 协议、token 计量器、模型信息解析器，以及单槽的 `compaction` 服务。
证据与出处：[FEASIBILITY.md](./FEASIBILITY.md)。

闸门：六个机制全部在已发布的类型声明与源码里确认 → **passed**。

### 阶段 B — 检测（已完成）

`lib/overflow.js` 是给失败打分，而不是去匹配一个正则：

- 强探针（网关措辞、`model's context window`、`no upstream can accept`、预算对窗口的算式）——命中任意一条即可；
- 结构化错误码（`CONTEXT_WINDOW_EXCEEDED` 及九个相关码）；
- 数字提取（请求 token、窗口 token、payload 字节数），让急救按失败时*观测到*的窗口来定目标，而不是适配器
  声明的那个；
- 用户可给的 `extraPatterns`，只能扩展检测，永远不能关掉内置规则。

闸门：`tests/overflow.test.js` 里 10 个测试，包含 #10138 的原始措辞，以及"只有数字不触发"的反例 → **passed**。

### 阶段 C — 救援折叠（已完成）

`lib/plan.js` + `lib/digest.js` + `lib/fold.js`：

- 折叠区间从真实 surface 的*配对安全*切点里选，用宿主自己的配对规则计算（`assistant/message` 里的 tool-call 块
  记 `+n`、`tool/result` 记 `−1`、其余记 `0`）——与 `@deepseek-ai/dsh-compaction` 的 `tool-pairing.js` 一致；
- 钉住的头部（system prompt、第一条用户消息）与最近的尾部被保留；当那条消息自己就超过目标预算时，钉住会被
  放弃，因为那时它不是保护，而是每个请求都失败的原因；
- 摘要是结构化检查点（失败、涉及的文件与路径、任务清单、关键动作、用户意图、最近的结论），不是有损的改写；
- 写入是一个事务：`compaction/start` → `compaction/prune|summary` → 带 `surfaceOp: replace` 的
  `user/message` → `compaction/end`，替换体与它的计价事件之间没有 `await`，替换抛错时补一个闭合括号的
  `compaction/end{error}`。

闸门：`tests/fold.test.js`（10 个测试）加上 `tests/replay-real-log.test.js` 的回放 → **passed**。

### 阶段 D — 档位与预算（已完成）

`lib/rescue.js` 负责升级与停止：

- **T1** 用宿主暴露的 pruner 修剪工具输出；
- **T2** 请宿主自己的压缩引擎出手（`compactIfNeeded(agent, 'context-overflow', signal)`）；
- **T3** 机械折叠，不需要模型；
- **T4** 对一条消息做首尾摘录——那种"折它周围仍然会把它剩下"的巨型消息（只处理删掉它仍保持配对平衡的文本
  消息，且永不碰 system prompt）。

`mode` 决定跑多少：`auto` 是完整四档，`fold` 是同一套但去掉 T2——所以一个"绝不能请模型总结"的 profile 仍然
拿到 T1、T3、T4——`diagnose` 只检测并报告，不写任何东西。

车道拒绝（`dsh_compaction_refused`、`bili owns compression`）会把 T2 在**本进程内**永久标记为不可用，于是下一次
失败直接跳到 T3，而不是再去问一个已经说过"不"的代理。尝试次数按轮计数并有上限（`maxAttemptsPerTurn`）。

同一套档位还会提前一步跑：在 `agent/pre-step` 上，如果投影已经大于窗口，就在循环拼装请求之前折叠（T1 然后
T3；T2 留给宿主自己的压力钩子，避免一次超限被压两遍），而压力带本身不动，因为那属于普通压缩策略。

闸门：`tests/rescue.test.js` 里的档位测试，包含"车道拒绝被记住而不是反复去问引擎"和每轮预算 → **passed**。
预检：另有 7 个测试，加上真实 cordis 容器里的三条断言 → **passed**。

### 阶段 E — 操作面（已完成）

三个工具，让卡住的用户（或者读得到 `session` 的 agent，例如队友或脚本）不必等下一次失败就能动手：
`context_rescue`（`status` / `rescue`）、`context_rescue_estimate`、`context_rescue_fold`。工具只返回数据，
从不抛错。工具面向模型；坐在输入框前的人也需要一个把手，所以插件还在宿主的命令注册表（`/compact` 那个槽）里
注册了 `/rescue` 与 `/rescue-status`。该服务是特性探测式的，绝不注入：即使某个 profile 没有它，
request-error 钩子也必须装上，并在 `internal/service` 时重试注册（注册表可能后挂载）。

闸门：通过 `tests/rescue.test.js` 与 `tests/command.test.js` 里的假 context 实测，并通过宿主自己的
`CommandRuntime` 端到端（先 `/rescue-status` 再 `/rescue`，含 `command/run` + `command/done` 生命周期）在
`scripts/dev/mount-check.mjs` 里验证 → **passed**。

### 阶段 F — 模拟与回放（已完成）

- `scripts/simulate.js` 用真实插件代码回放四种场景：(1) #10138 那条链；(2) 代理层拒绝车道；(3) 一条折不动的
  巨型消息，必须交回；(4) 一个损坏的 surface（孤儿 tool call/result），必须原样交回宿主。在这里发现的一个 bug
  是：计量路径沿用了摘要的 2000 字符截断，导致一条 48 万字符的消息只被计价 1,992 token——用"原始文本"与
  "渲染文本"分开来修掉了。
- `tests/replay-real-log.test.js` 对一份从真实会话抓下来的日志驱动整套档位：输入宿主没分类的失败措辞，输出
  更小的投影与一次重试请求，并在改写后的 surface 上重新检查宿主的不变量。

闸门：四种模拟场景全绿；本机每一份超标的真实日志都被零模型调用救回（§5），44 份日志的扫描 0 失败
→ **passed**。

### 阶段 G — 发布（已完成）

- README（中文 + 英文 `README.en.md`）、配置参考、安装说明；
- 发布在 <https://github.com/Lequait/dsh-context-rescue>（`master`），topics 设为 `dsh-plugin`、
  `deepseek-harness`、`context-window`、`compaction`、`slash-commands`；
- 市场：`publish:remote` 推送提交，按落地的那个 commit 重新生成 `market/index.json`，被宿主自己的
  `parseMarketIndex` 接受，并推送条目：
  <https://github.com/Lequait/dsh-context-rescue/raw/master/market/index.json>；
- 后续进展：awesome 列表的提交是一个数据文件（`docs/awesome-entry.yml`），该列表拒绝创建不满一天的仓库，而本
  仓库创建于 2026-10-30T10:28Z——门槛过后已提交
  [PR #10903](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10903)（PR check 与提交闸门双绿）。
  npm 已经发布（0.2.2 手工、0.2.3 与 0.2.4 由 tag 触发 workflow）。另外两份列表当天就收下了条目，都是走 GitHub
  API 而不是克隆：`0xsline/awesome-deepseek-harness`
  （[PR #768](https://github.com/0xsline/awesome-deepseek-harness/pull/768)，中英两份 README）和
  `AdamPlatin123/dsh-plugin-radar`
  （[PR #986](https://github.com/AdamPlatin123/dsh-plugin-radar/pull/986)，`PLUGINS.md` 一行）。

两条 manifest 决定来自对已安装宿主的检查（`0.2.1-rc.3`）：

- `@deepseek-ai/dsh-plugin`——本插件最初声明的那个 peer——在宿主 `node_modules` 里**不存在**，所以那条声明是
  幽灵依赖。已经删掉；插件运行时不需要任何宿主包。
- 现在的护栏是 `engines.dsh: ">=0.2.0-rc.1"`。按宿主自己的规则（`evaluatePluginCompatibility`：自己声明了
  `engines.dsh` 就单独裁决，peer 被忽略）这是唯一声明契约的地方。两个方向都验过：`0.2.1-rc.3` → 兼容，
  `0.1.5-rc.2` → 不满足 `{"engines.dsh":">=0.2.0-rc.1"}`。

闸门：仓库已推送、列表条目可被服务 → **passed**；同一天提交的两份列表（`awesome-deepseek-harness` #768、
`dsh-plugin-radar` #986）→ **open，等维护者**；受年龄门槛限制的 `awesome-dsh-plugin` PR 已提交（#10903）。

推送本身走的是 `npm run publish:remote`，它不持有凭据：由本机的 git credential helper 提供。那个脚本里有两个
缺陷只在真实远端才暴露，第一次运行后就修了：它原先用普通 node 执行，宿主 `parseMarketIndex` 会静默降级成
本地规则（现在用 `ELECTRON_RUN_AS_NODE=1` 自我重启）；以及 `ls-remote` 返回 `undefined`（没答上）被当成
"分支存在"，跳过了首次推送的分支重命名。

不需要 npm 账号就能产出的东西都已具备：提交、被宿主验证过的索引条目、可安装的 bundle 形状，以及一个拿本地裸
仓库跑真实 `publish-remote` 的排练（检查推送后的分支、被宿主接受的条目、钉住的安装 spec：
`npm run publish:rehearse`，18 条断言），还有首次推送两条分支规则的正反验证（空远端得到 `main`，已存在的
`master` 被保留）。npm 侧也按同样标准准备：`npm pack` 产出确定的制品，`npm publish --dry-run` 在
`registry.npmjs.org` 上以公开访问认证、只停在登录那一步，`.github/workflows/release.yml` 从 tag 发布（先类型
检查、测试、模拟、安装 smoke、发布排练，再校验 tag 与版本一致，最后 `--provenance`），并顺带用 `CHANGELOG.md`
的对应版本段生成中文 release 页。

## 4. 验证矩阵

| 关注点 | 检查方式 | 结果 |
|---|---|---|
| 宿主 waterfall 契约 | `agent/request-error` 返回 `{kind:'retry'}`，循环 `continue` | 宿主源码确认 + 模拟通过 |
| surface 写入协议 | 替换体是 `compaction/start` 与 `compaction/end` 之间带 `surfaceOp: replace` 的 `user/message` | 宿主源码确认 + 回放通过 |
| 工具配对 | 折叠边界落在配对安全切点上，遵循宿主自己的规则 | 4 份真实日志验证（956→169、2232→507、482→183、382→165 节点） |
| 零模型路径 | `llm.stream` 不可用或被拒时仍工作 | 模拟与测试验证 |
| 不 import 宿主包 | 运行时插件不 import 任何 `@deepseek-ai/*` | `grep -rn "@deepseek-ai" index.js lib/` 验证——唯一命中是 `lib/command.js` 里的定义 id 字符串——加上包的 `files` |
| 幂等性 | 同一轮第二次失败不会盲目再折一次 | 每轮预算测试验证 |
| bundle patch | `cordis.patch.yml` 能被宿主自己的加载器解析 | `bundlePatchPaths` + `loadOverlayPatches` 返回预期的 insert 条目 |
| manifest 兼容性 | 宿主 `evaluatePluginCompatibility` 接受该 manifest，并拒绝 0.1.x | `0.2.1-rc.3` 兼容、`0.1.5-rc.2` 报 `{"engines.dsh":">=0.2.0-rc.1"}` 不满足 |
| 市场索引条目 | 生成的条目通过宿主自己的 `parseMarketIndex`，并给出钉住 commit 的安装 spec | 在 `0.2.1-rc.3` 上验 `parseMarketIndex` + `marketInstallTarget` |
| 宿主容器挂载 | 插件挂进已安装应用的 cordis 4，工具落到真实 `tools` 服务上，且救援在宿主压缩引擎同时挂载时仍工作、不抢槽 | `scripts/dev/mount-check.mjs`（26 条断言） |
| 预检折叠 | 已超窗的投影在真实 `agent/pre-step` 上、请求拼装之前就被折叠，循环的决定原样返回，压力带留给宿主 | `tests/preflight.test.js`（7 个测试）+ `scripts/dev/mount-check.mjs` §7（3 条断言） |
| 人用的命令 | 宿主自己的 `CommandRuntime` 列出 `/rescue` 与 `/rescue-status`、能执行、并记下 `command/run` + `command/done` | `scripts/dev/mount-check.mjs` §6（8 条断言） |
| 按用户的方式安装 | `dsh plugin --profile <name> add <tarball>`——应用自己的 CLI，在真实 profile 里转发给 pnpm——产出依赖并启用插件的 profile，宿主加载器能在里面解析出 patch | `scripts/dev/e2e-install.mjs`（10 条断言，临时 profile 事后删除） |
| 从发布过的 spec 安装 | README 里那行 `dsh plugin --profile <name> add git+https://github.com/Lequait/dsh-context-rescue.git#<ref>` 能从 GitHub 装、记录 git spec、进入 profile 的 bundle 列表 | `npm run e2e-install -- --git`（11 条断言） |
| 从发布过的索引安装 | Discover 页走的那条路：取 `market/index.json`、用宿主 `parseMarketIndex` 校验、用 `marketInstallTarget` 取 spec、装那个钉住的 commit、再用宿主 bundle 加载器加载装好的副本 | `npm run market-install`（17 条断言） |
| 从 npm 安装 | `npm run e2e-install -- --npm`——registry 上的 spec，不只是 tarball | 11 条断言，装的是当前发布版本 |
| 安装后的包 | `npm pack` 的产物作为依赖装上后，宿主 bundle 加载器能从安装路径解析出 `cordis.patch.yml` | `scripts/dev/install-smoke.mjs` |
| 类型契约 | `index.js` + `lib/` 里每个导出签名与内部形状在 `--checkJs` 下通过 | `npm run typecheck` → 14 个文件 0 error（`tsconfig.json`） |
| 发布流程 | 克隆本 checkout、推进裸远端、重钉索引条目，产出指向代码 commit 且被宿主接受的条目 | `scripts/dev/publish-rehearse.mjs`（18 条断言，不需要账号） |
| 真实应用启动 | 装好的 bundle 真的会挂载：`apply()` 在运行中的应用里执行，植入的 throw 以插件自己的条目出现在日志里，且在"压缩车道已有归属者"的 profile 里同样能挂 | `npm run boot-check`（33 条断言，五个临时 profile，全部删除；web 形状还会真启动并要求它提供 UI） |
| 摘要可读性 | 模型实际收到的检查点说清每次工具调用是为了什么，把重复压成一行加计数，把 harness 的管道内容（运行时快照、技能目录、记忆投影、时间采样）排除在意图列表之外，并把每轮重复出现的同一目标只写一次 | `tests/digest.test.js`（8 个测试），`scripts/dev/digest-preview.mjs` 打印最大日志的摘要供人读 |
| 面向模型的工具 | 三个工具都端到端跑过：status 只读，rescue 会折叠并报告差值，手动折叠在关闭事务时没有轮次编号，没有 session 的调用返回错误对象 | `tests/tools.test.js`（9 个测试） |
| 折叠预览 | status 调用会说出折叠将替换哪一段、代价多少、保留什么，并且什么都不写 | `tests/rescue.test.js`（1 个测试）+ `tests/command.test.js`（断言） |
| 宿主真正会发出的请求 | 每次折叠之后，派生出的请求必须变小且装得下，而不只是 surface 的计价变小；`/rescue-status` 两个数都报 | `scripts/dev/host-session-check.mjs`（每份被折的日志 2 条断言）+ `tests/command.test.js` |
| 救不回来的会话 | 四档各试一次后就记住，不再每请求全量重测；`/rescue` 强制再试一次 | `tests/rescue.test.js`（3 个新测试） |
| 路径保真 | 检查点至少保留折叠区间里的一个文件路径，让模型仍知道活干在哪儿；在宿主自己的投影上断言 | `scripts/dev/host-session-check.mjs`（每份被折的日志；`tests/digest.test.js`） |
| 判定绑定窗口 | 已放弃的会话在"解析出的窗口变了"或"它放弃的那段历史变长了"时会重新测量，失败路径与 step 检查里都如此；窗口与形状都没变则仍然短路 | `tests/rescue.test.js`（窗口变大即重开；窗口不变则不测） |
| 状态预览覆盖摘录档 | `/rescue-status` 说出折叠将取哪一段；折不了时它点名将被摘录的那条消息，而不是说"无事可做" | `tests/command.test.js`（预览不得改写；摘录情形有断言） |
| 不丢历史 | 折叠是追加：每个原始事件都留在日志里且仍可解析，只是离开投影 | `tests/fold.test.js`（`a fold never removes an event from the log`） |
| 折叠在卸载后仍然成立 | 一个全新的宿主 `Session`，只用折叠后的事件播种、完全不涉及本插件代码，能派生出同样的消息、同样的工具配对、同样的度量大小——这正是卸掉插件后留下的东西 | `npm run host-session`（重开断言，每份被折日志都跑） |
| 配置 schema | 选项声明为 Schemastery 图，宿主在插件启动前就校验 patch，`--dump-config-schema` 能给出文档；越界值会让启动失败并点名字段与边界 | `tests/schema.test.js`（8 个测试）+ `npm run schema-check`（对已安装应用 11 条断言） |
| 摘录优先级 | 优先摘录较早历史里的超大节点，只有更早的都还不够大时才动当前轮输入的那条 | `tests/trim.test.js`（同一会话上 3 组对比） |
| 超大的工具结果 | 一条比窗口还大的工具结果与产生它的调用一起替换，因为只丢一半会让另一半成为孤儿 | `tests/trim.test.js`（结果加调用，surface 不留半个配对） |
| 折了还是装不下 | 机械折叠后投影仍超窗时不算救援，避免发出必然失败的重试；档位继续走到真正会切的那一档 | `tests/trim.test.js`（多段粘贴块，system prompt 不动） |
| 超大的单条消息 | 自己就溢出的消息换成它自己的首尾（绝不动那些删掉会破坏配对的节点），失败路径与预检路径都如此 | `tests/trim.test.js`（4 个测试）+ `tests/preflight.test.js` |
| 崩溃留下的半截事务 | 早先某轮遗留的 `compaction/start` 在规划之前被闭合，于是折到一半死掉的会话又能折了；当前轮遗留的那个不动 | `tests/repair.test.js`（5 个测试） |
| 预检开销 | pre-step 钩子每轮只测一次，之后只数追加进来的部分，所以长轮次不会每个 step 都给整个投影重新计价；一次大粘贴或外来的折叠会强制真测 | `tests/preflight.test.js`（`countingMeter`：3 个测试），`scripts/dev/rescue-bench.mjs` 打印最大日志的冷/热耗时 |
| 超大的首条消息 | 第一条用户消息本身就超窗的会话会被折叠，而不是被判"折不动" | `tests/fold.test.js`（2 个测试）、`tests/rescue.test.js`（1 个测试） |
| 宿主 Session 类 | 折叠被宿主自己的 `Session` 接受：追加通过 `validateSessionEventData`，投影由 `SurfaceManager` 重建，`deriveMessages()` 不留孤儿工具结果，括号闭合 | `scripts/dev/host-session-check.mjs`：222 份日志播种成功，70 份折叠两次，其中 32 份还走预检路径，152 份被宿主自己拒绝播种，0 失败 |
| 真实压缩引擎 | 插件可以借用 `dsh-compaction-basic`（stock profile 放进槽里的那个引擎）而不占槽，也不把"借了但什么都没变"算成救援，借用失败时不把引擎或会话留在坏状态 | `scripts/dev/coexist-check.mjs`（14 条断言，真实引擎，无模型） |
| 真实事件形状 | surface 归属与 `isSurfaceEligibleType` 一致（`tool/call` 与 `tool/ptc-dispatch` 不是 surface 节点），且事件通过 `snapshotEvents()` 读取，因为宿主 `Session` 没有 `.events` | 两条都由上面的 host-session 闸门钉住 |
| 会覆写引擎的压缩器 | `dsh-smart-compact@0.5.3` 在 `dsh-compaction-basic` 之上替换了 `compactIfNeeded(agent, trigger, signal)`：非压力触发走基础引擎，待处理的 `new_context` 请求绕过压力带，拒绝时 resolve `null`。因此借用用的是那个确切签名，把 `null` 当作"没缩小"，并且绝不因为引擎的 bug 而锁死 `laneBlocked` | 覆写签名读自发布 tarball；`null` 路径由 `a borrowed engine that changes nothing…` 覆盖，抛错路径由 `a host engine that throws for its own reasons…` 覆盖 |

## 5. 真实日志证据

回放闸门现在驱动的是**整套档位**，不只是规划器：
`DSH_SESSION_LOG=<path> node --test tests/replay-real-log.test.js`。它载入本机抓下来的一份日志，喂进宿主分类器
漏掉的措辞，要求插件在不调用模型的情况下救回。本机每一份超标日志，一次跑完：

| 会话 | 折叠前 token | 救援后 | 窗口 |
|---|---|---|---|
| `abc05855` | 575,630 | 51,321 | 196,608 |
| `9a608fe8` | 933,308 | 50,889 | 196,608 |
| `753cc91b` | 829,396 | 55,544 | 196,608 |
| `eba32f8b` | 1,067,623 | 51,683 | 196,608 |
| `335a745b` | 1,067,701 | 51,761 | 196,608 |
| `63836d1c` | 1,087,491 | 51,257 | 196,608 |
| `711575e5` | 444,738 | 95,612 | 196,608 |
| `aeb2b2fd` | 460,921 | 51,510 | 196,608 |
| `ba2e8cf2` | 177,001 | 53,417 | 196,608 |
| `d314a822` | 991,512 | 94,081 | 196,608 |
| `08d7604d` | 400,907 | 51,752 | 196,608 |
| `8c892e4e` | 893,098 | 49,098 | 196,608 |
| `c689be83` | 1,278,034 | 94,731 | 196,608 |
| `a5f65c42` | 818,516 | 52,303 | 196,608 |
| `d1024be4` | 824,194 | 96,974 | 196,608 |
| `e5701595` | 419,425 | 49,346 | 196,608 |
| `7b364d6b` | 402,212 | 48,420 | 196,608 |
| `50491777` | 368,392 | 51,518 | 196,608 |
| `e66c6120` | 1,991,124 | 92,976 | 196,608 |
| `a8e946e7` | 4,555,770 | 51,377 | 196,608 |
| `0a7a80b4` | 2,023,494 | 96,105 | 196,608 |
| `c1131526` | 241,565 | 47,975 | 196,608 |
| `dbc6854d` | 200,442 | 48,959 | 196,608 |
| `d1b1eba1` | 8,226,127 | 97,309 | 196,608 |
| `7fab0a11` | 1,515,222 | 91,895 | 196,608 |
| `d8b055c7` | 759,826 | 91,149 | 196,608 |
| `61228a91` | 969,280 | 93,508 | 196,608 |
| `86514f66` | 3,818,724 | 85,645 | 196,608 |
| `0421090c` | 642,451 | 79,057 | 196,608 |
| `de748264` | 667,760 | 79,062 | 196,608 |
| `a29d7aba` | 1,268,709 | 77,752 | 196,608 |
| `96553c67` | 305,736 | 78,316 | 196,608 |
| `1d26101d` | 352,583 | 87,807 | 196,608 |
| `eb01eb3c` | 196,240 | 82,196 | 196,608 |

每次运行都断言：溢出措辞被识别、**观测到的**窗口覆盖声明的窗口、档位到达零模型那档、投影最终落在
`fitRatio × window` 之下、surface 仍然良构（`corrupt === false`）、两个折叠边界都是配对安全的、事务括号闭合、
替换体的 `source.kind === 'compact-checkpoint'`。每一份超标日志都被救回，0 失败。空的或本来就装得下的日志被
跳过而不是判失败——扫描脚本（`node scripts/dev/scan-sessions.mjs`）当前在本机报
`216 logs · 34 rescued · 182 skipped · 0 failed`。上面那张表是扫描脚本所依据的更早一次结果：它列了 34 份，因为
当时 `tool/call` 与 `tool/ptc-dispatch` 还被算作 surface 节点，所以有三份"看起来超标"的其实早就在窗口内；
surface 精确之后降到 31 份，等窗口改为按 session header 里点名的 provider 解析后又升到 32 份（其中一份属于窗口
比 `windowFallback` 更小的模型）。本机后来又抓到一份超标的会话，于是到 33 份——而现在扫描口径报 34 份。
本节所有数字（含表格行）都是某一次本地日志目录的快照，不是常量。

## 6. 已知局限

- 如果钉住的头部自己就超过窗口，救援**无能为力**（再折就得毁掉用户的第一条指令）；插件会明确报告这种情况并
  交回。
- 摘要是启发式的。它保留结构与指针，不保留每个 token；这样救回来的会话应当接着聊，而不是期待完美回忆。
- "车道被拒"的标记是**按进程**的。重启宿主会再试代理一次，这是有意的：代理的策略可能已经变了。
- T1 的工具名发现是按约定（`toolResultPruner` / `prune` / `toolPruner`）；如果宿主暴露的 pruner 叫别的名字，
  这一档会被跳过，而不是去猜。
