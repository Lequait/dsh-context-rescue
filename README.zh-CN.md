# dsh-context-rescue

![test](https://github.com/Lequait/dsh-context-rescue/actions/workflows/test.yml/badge.svg)

**给"上下文爆窗"的 DeepSeek Harness 会话叫救护车。**

会话里每条消息都回 `400`，因为某一次请求超过了模型真正能吃的窗口。`/compact` 也救不回来
—— 它沿着同一条超限的投影重发；如果压缩被代理层接管，还会被直接拒绝。这个插件是急救车：
识别爆窗、把最老的历史折叠成结构化摘要、把同一步重发一次，会话就活了。

```
400 the request exceeds the model's context window
  └─ context-rescue: overflow detected (gw-prose, score 0.95)
     ├─ T1 裁剪工具输出     → 宿主未提供
     ├─ T2 宿主压缩引擎     → 代理拒绝，本进程内该车道永久关闭
     ├─ T3 机械折叠         → 956 节点 → 169 节点，991,512 → 298,595 tokens
     └─ T4 超大单条消息     → 仅当历史只有一条巨消息时：保留它的开头与结尾
  └─ 重试同一步 → 200 OK
```

## 为什么需要它

这条失效链在上游有完整记录（DSH 讨论 #10138），它是**三段叠加**，不是单点 bug：

1. 网关用自然语言拒绝（`payload core text alone is ~N bytes … no upstream can accept it`），
   宿主的分类器认不出来，于是这次失败**没有**被打上 `CONTEXT_WINDOW_EXCEEDED`；
2. 错误码不对，宿主自带的上下文溢出分支就**不会执行**；
3. 没有任何东西缩小投影，重发出去的请求字节级相同，于是再失败一次 —— 无限循环。

现有插件都是**事前预防**（滚动换窗、裁剪工具输出、代理侧压缩）。没有一个在会话已经卡死之后
动手。本插件平时什么都不做，只在请求失败时介入，因此可以和上面任何一款共存。

## 安装

```bash
# 直接从本仓库装
dsh plugin --profile <profile> add git+https://github.com/Lequait/dsh-context-rescue.git#master

# 本地目录
dsh plugin --profile <profile> add /path/to/dsh-context-rescue

# 发布 npm 之后
dsh plugin --profile <profile> add dsh-context-rescue
```

分支形式跟随 `master`；市场条目则是钉死提交（`git+…#<commit>`），列表指向的构建不会在脚下挪动。

包内声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，以 `context-rescue`
为 id 插入。**运行时它不 import 任何 `@deepseek-ai/*` 包**：`surfaceOp`、`compaction/*` 事务、
配对规则、模型窗口解析全部按宿主的线上结构在本地构造。宿主升级不会打断它的 import，
它也不声明任何宿主 peer 依赖（也就没有"peer 缺失装不上"这回事）。装完重启一次（新 bundle 需要宿主重载）。

## 上架条目

`market/` 放图标和生成脚本，产出的是**格式 1 的插件市场索引条目**。校验用的是宿主自己的
`parseMarketIndex` —— 也就是 Discover 页读索引时跑的那套代码：

```bash
# 校验一条以本仓库某个 commit 作为 Git 源的条目
node scripts/make-market-index.mjs \
  --repo https://github.com/OWNER/dsh-context-rescue \
  --commit "$(git rev-parse HEAD)" \
  --out market/index.json

# 或者一步发布：先推送，再把条目钉到真正推上去的那个提交
npm run publish:remote -- --repo OWNER/dsh-context-rescue --dry-run
```

它会打印解析出的安装 spec（`git+https://…git#<commit>`；加 `--npm` 则是 `name@version`），
任何一条规则不通过就带 JSON 路径非零退出。校验器位置可用 `DSH_APP_ASAR` 覆盖。

DSH 只读用户自己配置的索引：市场 bundle 是可选的、默认 `indexes: []`，所以"能被发现"只差一步。

本仓库已经发布，用户有两条路：

```bash
# 1. 直接从 git 装 —— 不需要任何市场，钉住你复核过的 commit
dsh plugin --profile <profile> add git+https://github.com/Lequait/dsh-context-rescue.git#<commit>
```

```text
# 2. 通过 Discover 页
添加索引源   https://github.com/Lequait/dsh-context-rescue/raw/master/market/index.json
            （Discover → 索引源 / "Add index source"；官方市场 bundle
             @deepseek-ai/dsh-plugin-market 是可选的，不是每个 profile 都有）
选中条目     dsh-context-rescue —— 它装的是条目里钉住的 commit，不是分支
```

仓库同时带了 `dsh-plugin` topic，按 topic 扫描的列表能自动发现它；条目也已投给两个策展列表
（PR 记录在 `docs/PUBLISH.md`）。

## 请求发出之前

等到 400 才救，代价是一次白走的重试；而有些会话一次都救不回来（issue #10138）。所以同一套急救
也挂在 `agent/pre-step` 上，早一步发生：

1. 先量循环即将发出的投影；
2. 如果它已经**超过模型窗口**，这个请求根本不可能被接受 —— 就地折叠：先 T1 裁剪，再走零模型检查点；
3. 如果只是落在压力带（`fitRatio × 窗口` 到窗口之间），一律不动：那是普通压缩策略，归宿主管。

窗口依次来自模型注册表（用会话头里的 provider）、会话自身、`windowFallback`，并按目标缓存，
一个 turn 不会每步都去解析一次。这里**故意不走 T2**：宿主引擎有自己的 pre-step 钩子，借它会为
同一次超窗压缩两遍。

量一份大投影才是急救里最贵的一步：本机实测整条阶梯中位数 1.1 秒，几乎都花在给节点计价上。pre-step
每一步都会调用，所以它**一个 turn 只量一次**，之后只数「这之后新追加了什么」——同一 turn 的第二次检查
耗时可忽略，但仍然会发现大段粘贴（任何新消息超过 4,000 字符就强制重新测量；投影节点数与缓存不符也
强制重测，那说明别人折叠过）。`node scripts/dev/rescue-bench.mjs` 会打出本机最大几份日志的耗时分布。

## 请求失败之后它做什么

挂在 `agent/request-error` 瀑布上 —— 这条钩子对**任何**失败都会触发，跟宿主给的是什么错误码
无关，因此正好补住分类器的漏。

1. **判定**：强证据（网关原文、`model's context window`、`no upstream can accept`、
   预算与窗口的算术关系）+ 结构化错误码；顺带抽出 `requestTokens` / `windowTokens`。
   失败里**观测到**的窗口优先于适配器**声明**的窗口。
2. **计量**：走宿主 token meter，没有就本地估算。
3. **规划**：用宿主自己的配对规则算安全切点（工具调用是 `assistant/message` 里的
   `tool-call` block，结果是 `tool/result`，镜像事件不动余额）。保留钉住的头部和最近尾部；
   遇到未闭合的 compaction 事务直接拒绝出计划。
4. **四档阶梯**：
   - **T1** 用宿主暴露的 pruner 裁剪工具输出（最便宜，零模型）；
   - **T2** 请宿主的压缩引擎做它本该做的事：`compactIfNeeded(agent, 'context-overflow', signal)`；
     借来的引擎只有把投影**真的变小**才算救活，什么都没做的 no-op 会继续落到 T3；
     若被代理拒绝（`dsh_compaction_refused`），记下来，本进程内不再问第二次；
   - **T3** 写检查点：`compaction/start` → `compaction/prune` → `user/message`（`surfaceOp: replace`）
     → `compaction/end`，正文是折叠区间的结构化摘要。
   - **T4** 当整段超窗的其实**只有一条消息**（比如刚贴进来的一整个文件）时，没有区间可折：
     把那条消息本身换成「开头 + 结尾」的摘录，并在检查点里写明原文长度与被丢弃的中间部分。
     只对删掉它仍能保持工具调用配对完整的文本消息生效；孤儿 `tool/result` 之类一律不碰。
   系统提示词永远不会被摘录：把指令换成首尾摘录，等于让请求合法地丢掉这一轮该做什么，所以当窗口里
   超出的只剩它时，阶梯报告失败而不是假装成功。一次贴进多段内容也能一趟处理完——折叠先吃掉旧区间，
   留在尾部的那条由 T4 截断。

5. **只重试一次**：返回 `{ kind: 'retry' }`，让循环用变小后的投影重发同一步。全档失败或
   超出每轮预算就 `next()` 交出控制权，绝不让真实错误被吞掉。

摘要是结构化的，不是复述：错误与失败、涉及的文件与路径、任务清单、关键操作、用户意图、
最近结论。长会话会丢细节，但保留骨架和线索。

## 工具

| 工具 | 用途 |
|---|---|
| `context_rescue` | `action: "status"` 报告占用、能力与上次急救；`action: "rescue"` 立刻走一遍阶梯、不等失败 |
| `context_rescue_estimate` | 按声明或实际观测的窗口估算当前投影占用 |
| `context_rescue_fold` | 折叠指定区间（`start` / `end` seq），同样做安全校验 |

工具不抛异常，统一返回带 `ok`、`reason` 和计数的报告对象。

## 斜杠命令

只要宿主提供了命令注册表（`/compact` 用的那个槽），插件就会注册两个命令。它们是可选的：没有该注册表的 profile 仍然有自动急救与工具。

| 命令 | 用途 |
|---|---|
| `/rescue` | 立刻折叠最旧的一段并报告 token 变化（`/rescue status` 只报告不改写） |
| `/rescue-status` | 报告占用、解析出的窗口、是否可折叠，以及上一次急救结果 |

命令注册表可能比插件后挂载，插件会在服务出现时补注册。命令结果是一行文本，走的仍是与自动急救完全相同的代码路径，且永不抛异常。

## 配置

全部可选。

| 键 | 默认 | 含义 |
|---|---|---|
| `mode` | `"auto"` | `auto` 急救；`diagnose` 只报告不改写；`fold` 直接机械折叠 |
| `zeroModelOnly` | `false` | 永不调用模型/压缩引擎，直接走机械折叠 |
| `trimOversizedMessages` | `true` | 单条消息自己就装不下时，用它的开头+结尾替换它 |
| `excerptChars` | `3000` | 替换时首尾各保留多少字符 |
| `allowModelCompaction` | `true` | 是否允许 T2 |
| `retainRatio` | `0.25` | 作为最近尾部保留的占比 |
| `retainMinTokens` / `retainMaxTokens` | `4000` / `40000` | 尾部长度的上下限 |
| `targetRatio` | `0.75` | 折叠到窗口的这个比例以内 |
| `fitRatio` | `0.9` | 低于该比例即认为装得下 |
| `minFoldTokens` | `4000` | 小于这个量不值得开一次事务 |
| `maxAttemptsPerTurn` | `2` | 每个 assistant 轮次的急救预算 |
| `maxDigestChars` | `12000` | 检查点正文硬上限 |
| `pinFirstUserMessage` | `true` | 首条用户消息不进折叠区间——除非它自己就超过了预算 |
| `windowFallback` | `196608` | 失败与模型信息都给不出窗口时使用 |
| `extraPatterns` | `[]` | 追加的溢出识别正则 |
| `laneRefusalPatterns` | `["dsh_compaction_refused", "bili owns compression"]` | 命中即永久关闭 T2 |
| `registerTools` | `true` | 是否注册上述三个工具 |
| `registerCommands` | `true` | 宿主有命令注册表时是否注册 `/rescue` 与 `/rescue-status` |
| `preflight` | `true` | 投影已超窗时在 `agent/pre-step` 就地折叠 |
| `repairTransactions` | `true` | 关掉崩溃留下的半截压缩事务；悬空的 start 会让之后每一次折叠都被拒绝 |
| `verbose` | `true` | 把急救决策写进会话日志 |

### 配置写错会被告知，而不是被吞掉

插件挂载时会校验选项：拼错的键（如 `retainRation`）、不认识的 `mode`、超出可用区间的比例、
以及不低于 `fitRatio` 的 `targetRatio`，都会以 `config:` 开头的 warn 日志报出，而不是悄悄按别的
值运行。对急救插件来说，"静默忽略拼写错误"和"根本没装"是同一件事。

## 安全边界

- **绝不损坏投影**：切点按宿主自己的平衡规则计算，会把工具调用和它的结果切开的区间一律不用；
  写入中途抛错会补一条 `compaction/end{error}` 闭合事务括号。
- **绝不为空忙花上下文**：如果按插件自己的计量，投影本来就在报错所说的窗口之内，就直接原样重试，
  不做折叠 —— 网关可能比投影算得更多，那时改写只会白白烧掉历史。
- **绝不循环**：每轮最多 `maxAttemptsPerTurn` 次，然后让位。
- **绝不假装成功**：没有可折叠区间（单条巨消息，或钉住的头部本身超窗）时明确报告并交出控制权。
- **绝不抢位**：不注册 `compaction` 服务槽，预防型压缩器照常持有它，并且在 T2 有优先权；
  开 `zeroModelOnly` 时根本不会碰这条车道。`npm run mount-check` 会先挂一个宿主压缩引擎，
  再证明挂载插件后该槽仍然路由到它、且急救仍在零模型档完成。

## 验证

```bash
node --test                          # 单测 + 回放
npm run typecheck                    # 用 JSDoc 给 index.js 与 lib/ 做类型检查
node scripts/simulate.js             # 三个失效场景跑真实插件代码
DSH_SESSION_LOG=<session.v4.jsonl.zstd> node --test tests/replay-real-log.test.js

# 同一套测试改用 app 自己的 Node 跑，那里才读得到 app.asar 里的宿主校验器
npm run test:host

# 装进本机 app 自己的 cordis 容器里跑一次真实救援
npm run mount-check

# 真正打包、装进临时项目，再让宿主自己的加载器解析 bundle
npm run install-smoke

# 用 app 里真实的 Session 类回放本机日志并折叠
npm run host-session

# 和宿主的真实压缩引擎（compaction-basic）共存跑一次救援
npm run coexist

# 用宿主自己的 CLI 装进一个一次性 profile，再删掉
npm run e2e-install
# 同上，但装的是已发布的 git spec（真实网络路径）
npm run e2e-install -- --git
# 拉线上市场索引，交给宿主解析，再装它给出的 spec（Discover 页走的同一条路）
npm run boot-check                   # 真的启动应用：apply() 被执行吗，且能否与占用压缩车道的插件同一个 profile 共存
npm run market-install

# 用临时克隆 + 本地裸仓库把整条发布流程排练一遍
# （同时钉住分支规则：空远端首次推送改成 main，已有 master 的仓库保持 master）
npm run publish:rehearse

# 为当前 checkout 生成并校验上架条目
npm run market -- --repo-slug OWNER/dsh-context-rescue

# 可选的 npm 发布：先查工作树、包内容清单、版本是否被占，最后停在唯一需要账号的那一步
npm run publish:npm -- --dry-run
```

覆盖判定、配对安全规划、折叠事务、阶梯行为、车道拒绝记忆、每轮预算、no-op 借用引擎、
本来就装得下的投影、同一轮内第二次被拒时强制走阶梯、内部异常交还宿主，以及计量精度。
`tests/replay-real-log.test.js` 还会把真实会话日志折叠一遍，再复核宿主不变量；未设
`DSH_SESSION_LOG` 时自动跳过。`node scripts/dev/scan-sessions.mjs` 会把本机所有会话日志扫一遍，
每个超标会话都在**零模型调用**下救回来：174 个已捕获会话里有 32 个超过 196,608 窗口，32 个全部
救回，0 失败（见 `docs/PLAN.md` §5）。

`host-session` 是保真度最高的一道闸门，也是上面那两个 bug 的被发现处。它把**装好的 app 里那份**
`Session` 类加载出来回放真实日志：追加由宿主自己的 `validateSessionEventData` 校验，投影由它的
`SurfaceManager` 构建，断言对象是 `deriveMessages()` —— 也就是下一次请求真正要发的那串消息。
174 份日志能播种，65 份完成折叠（每份折两次，证明折过的会话还能再折），其中 30 份走的是 pre-flight 路径（请求还没发出就折好），其余是宿主在孤立进程里
自己也没法重建的（别的插件的事件投影、或 v4 之前的旧格式）。

`boot-check` 再高一层：它真的启动应用。它从出厂 `headless` 模板建三个一次性 profile ——
第一个装的是**故意在 `apply()` 里抛错**的副本，断言宿主把这个错误挂在它自己插入的那个条目名下
（`context-rescue (dsh-context-rescue)`）；这一步是反证，否则"跑绿了、没报错"什么都不能说明。
第二个装真包，断言启动能走过挂载、没有任何指向本插件的错误，并停在模型调用处（没有 API key 的机器就停在那里）。
第三个把 `billion-context`（某些机器上占着压缩车道的代理）和本插件装进同一个 profile 再启动一次，
于是"能和车道持有者并排工作"是被测出来的，而不是被假设的。
三个 profile 用完即删。它证明的是"装得上、挂得住"，不证明"能推理"。

`coexist` 把插件挂到**宿主真实的压缩引擎**旁边跑：它加载 app 里的 `@deepseek-ai/dsh-compaction-basic`，
让引擎自己占住 `compaction` 槽位，然后只给假 `llm`（拿不到模型）。断言的是三件事——插件不抢槽、
"借了引擎却没缩小投影"不算救回来、以及借失败之后引擎与容器都还完好（再调一次也不炸）。

"借"是它敢跟已有压缩器并排装的原因。`dsh-smart-compact@0.5.3` 继承的是同一个引擎，并重写了
`compactIfNeeded(agent, trigger, signal)`：非压力触发直接交给基础引擎、有待处理的 `new_context` 请求时
绕过压力档、拒绝时返回 `null` 而不是抛错。正因为这层重写，我们才用同样三个参数去问 `context-overflow`，
把 `null` 当作"什么都没缩小"继续走零模型折叠；另有单测钉住——引擎因自身原因抛错（预算测量失败、基础引擎
报错）既不算"车道拒绝"，也拦不住折叠。

`mount-check` 是集成闸门：它把插件装进**本机已安装 app** 自带的 cordis 4 容器，因此验证的是
真实的 `inject`/`Service` 接线和真实的 `ctx.waterfall('agent/request-error', payload, next)`
派发，而不是手搓的假 context。它断言工具确实注册到真实 `tools` 服务、瀑布返回
`{kind:'retry'}`、投影被改写成检查点、每轮预算拦住第三次、工具能通过服务响应，以及在先挂了
宿主压缩引擎时服务槽仍归宿主、急救仍在零模型档完成。

`install-smoke` 是打包闸门：`npm pack` 决定最终发出去的形状（受 `files` 白名单约束），
tarball 被当作依赖装进一次性项目，`evaluatePluginCompatibility` 断言宿主接受这个 manifest
（同时用一个故意写成不可能满足的 `engines.dsh` 做反例，保证这道闸门不会空过），再由**宿主自己的**
`bundlePatchPaths`/`loadOverlayPatches` 从"安装后的路径"解析出 patch。少一个文件、或 patch 相对目录解析错，只会在这一关暴露 —— 其余闸门
读的都是源码树。

模拟不是摆设：它抓到了一个真 bug —— 计量路径复用了摘要渲染的 2000 字符截断，把一条
480,000 字符的消息算成 1,992 tokens，插件因此误判"装得下"。

`publish:rehearse` 补上源码树测试碰不到的最后一段：`publish-remote` 是唯一需要账号的步骤，
所以排练会把本 checkout 克隆到临时目录、建一个裸仓库当远端、对它跑**真实的发布脚本**，再断言
宿主会看到什么 —— 推上去的分支、能被宿主 `parseMarketIndex` 接受的 `market/index.json`、
条目 pin 住的 commit 确实是"带代码的那个"而不是索引 commit 自己、commit 钉死的
`git+…#<commit>` 安装 spec，以及写进推送后 `package.json` 的仓库元信息。

## 它没救回来时

不要猜，直接读插件自己的状态：`context_rescue` 的 `action: "status"`，或输入框里的
`/rescue-status`，会报出当前会话的 `measuredTokens`、`window.windowTokens`、`fits`、
`foldSupported`、`hostCompaction`、`toolResultPruner` 与 `laneBlocked`。

| 现象 | 含义 | 处理 |
|---|---|---|
| 启动时没有 `armed: context-overflow rescue active` 这一行 | 宿主跳过了这个 bundle | 核对 `engines.dsh` 与 app 版本，并确认 patch 文件在安装目录里能解析到 |
| `fits: true` 但 provider 仍然拒绝 | 窗口估计比网关真正执行的上限大 | 失败文案里通常带着真实数字；没有数字时把 `windowFallback` 设成实际窗口 |
| `laneBlocked: true` | billion-context 拒绝了宿主自己的压缩 | 插件会留在零模型路径上；可设 `zeroModelOnly: true` 把这点写明，不再尝试借用 |
| `foldSupported.ok: false` | 这个会话形状没有 `append`/`surface.nodes`/`eventAt` | 宿主版本不匹配 —— 插件拒绝改写自己读不回来的投影 |
| `hostCompaction: absent` | 没有挂载压缩引擎 | 无害：第二档跳过，零模型阶梯照常跑 |
| 救过了但请求仍然失败 | 折叠后仍然超窗 | 调低 `retainRatio`/`retainMaxTokens`，或开新的一轮让检查点接住要点 |

## 局限

- 它在请求失败之后动手。想完全不看到失败，请搭配一款事前预防插件，两者不冲突。
- 摘要保留骨架与线索，不保留每一个 token。
- "车道被拒"只在进程内记忆；重启宿主会再试一次，这是有意的（代理策略可能已改）。

## 许可证

MIT。
