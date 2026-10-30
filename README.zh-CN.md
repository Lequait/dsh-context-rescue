# dsh-context-rescue

**给"上下文爆窗"的 DeepSeek Harness 会话叫救护车。**

会话里每条消息都回 `400`，因为某一次请求超过了模型真正能吃的窗口。`/compact` 也救不回来
—— 它沿着同一条超限的投影重发；如果压缩被代理层接管，还会被直接拒绝。这个插件是急救车：
识别爆窗、把最老的历史折叠成结构化摘要、把同一步重发一次，会话就活了。

```
400 the request exceeds the model's context window
  └─ context-rescue: overflow detected (gw-prose, score 0.95)
     ├─ T1 裁剪工具输出     → 宿主未提供
     ├─ T2 宿主压缩引擎     → 代理拒绝，本进程内该车道永久关闭
     └─ T3 机械折叠         → 956 节点 → 169 节点，991,512 → 298,595 tokens
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
# 本地目录
dsh plugin --profile <profile> add /path/to/dsh-context-rescue

# 发布之后
dsh plugin --profile <profile> add dsh-context-rescue
```

包内声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，以 `context-rescue`
为 id 插入。**运行时它不 import 任何 `@deepseek-ai/*` 包**：`surfaceOp`、`compaction/*` 事务、
配对规则、模型窗口解析全部按宿主的线上结构在本地构造。宿主升级不会打断它的 import，
peer 依赖缺失也不会导致装载失败。装完重启一次（新 bundle 需要宿主重载）。

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
4. **三档阶梯**：
   - **T1** 用宿主暴露的 pruner 裁剪工具输出（最便宜，零模型）；
   - **T2** 请宿主的压缩引擎做它本该做的事：`compactIfNeeded(agent, 'context-overflow', signal)`；
     若被代理拒绝（`dsh_compaction_refused`），记下来，本进程内不再问第二次；
   - **T3** 写检查点：`compaction/start` → `compaction/prune` → `user/message`（`surfaceOp: replace`）
     → `compaction/end`，正文是折叠区间的结构化摘要。
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

## 配置

全部可选。

| 键 | 默认 | 含义 |
|---|---|---|
| `mode` | `"auto"` | `auto` 急救；`diagnose` 只报告不改写；`fold` 直接机械折叠 |
| `zeroModelOnly` | `false` | 永不调用模型/压缩引擎，直接走机械折叠 |
| `allowModelCompaction` | `true` | 是否允许 T2 |
| `retainRatio` | `0.25` | 作为最近尾部保留的占比 |
| `retainMinTokens` / `retainMaxTokens` | `4000` / `40000` | 尾部长度的上下限 |
| `targetRatio` | `0.75` | 折叠到窗口的这个比例以内 |
| `fitRatio` | `0.9` | 低于该比例即认为装得下 |
| `minFoldTokens` | `4000` | 小于这个量不值得开一次事务 |
| `maxAttemptsPerTurn` | `2` | 每个 assistant 轮次的急救预算 |
| `maxDigestChars` | `12000` | 检查点正文硬上限 |
| `pinFirstUserMessage` | `true` | 首条用户消息永不进入折叠区间 |
| `windowFallback` | `196608` | 失败与模型信息都给不出窗口时使用 |
| `extraPatterns` | `[]` | 追加的溢出识别正则 |
| `laneRefusalPatterns` | `["dsh_compaction_refused", "bili owns compression"]` | 命中即永久关闭 T2 |
| `registerTools` | `true` | 是否注册上述三个工具 |
| `verbose` | `true` | 把急救决策写进会话日志 |

## 安全边界

- **绝不损坏投影**：切点按宿主自己的平衡规则计算，会把工具调用和它的结果切开的区间一律不用；
  写入中途抛错会补一条 `compaction/end{error}` 闭合事务括号。
- **绝不循环**：每轮最多 `maxAttemptsPerTurn` 次，然后让位。
- **绝不假装成功**：没有可折叠区间（单条巨消息，或钉住的头部本身超窗）时明确报告并交出控制权。
- **绝不抢位**：不注册 `compaction` 服务槽，预防型压缩器照常工作，并且在 T2 有优先权。

## 验证

```bash
node --test                          # 单测 + 回放
node scripts/simulate.js             # 三个失效场景跑真实插件代码
DSH_SESSION_LOG=<session.v4.jsonl.zstd> node --test tests/replay-real-log.test.js
```

覆盖判定、配对安全规划、折叠事务、阶梯行为、车道拒绝记忆、每轮预算与计量精度。
`tests/replay-real-log.test.js` 还会把真实会话日志折叠一遍，再复核宿主不变量；未设
`DSH_SESSION_LOG` 时自动跳过。本机实测：`956 → 169` 节点（991,512 → 298,595 tokens）、
`2232 → 507`（933,308 → 241,381）、`482 → 183`、`382 → 165`。

模拟不是摆设：它抓到了一个真 bug —— 计量路径复用了摘要渲染的 2000 字符截断，把一条
480,000 字符的消息算成 1,992 tokens，插件因此误判"装得下"。

## 局限

- 它在请求失败之后动手。想完全不看到失败，请搭配一款事前预防插件，两者不冲突。
- 摘要保留骨架与线索，不保留每一个 token。
- "车道被拒"只在进程内记忆；重启宿主会再试一次，这是有意的（代理策略可能已改）。

## 许可证

MIT。
