# 可行性检验 — dsh-context-rescue

> 结论：**可行**。所有依赖的宿主扩展点都已在本机实际宿主包源码中逐条核实（`@deepseek-ai/*@0.2.1-rc.5`，与桌面端 0.2.x 同代）。
> 唯一硬约束是「压缩车道归属」：当 billion-context 占道时原生压缩会被 422 拒绝，因此本插件必须有一条**不调用模型**的兜底路径。

## 1. 拦截点：`agent/request-error` waterfall

`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:348` 声明：

```ts
'agent/request-error'(payload: { agent; turn; step; provider; failure; retryPolicy; signal },
                      next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
// RequestErrorAction = { kind: 'retry' } | undefined   (同文件 :102)
```

消费侧 `@deepseek-ai/dsh-agent-loop/lib/index.js:1130-1142`：

```js
const action = await this.dispatch.waterfall('agent/request-error', {...}, () => Promise.resolve(void 0));
if (action?.kind !== 'retry') throw new LlmError(...);
continue;                    // ← 重新进入 while，重发同一 step
```

- 判定：**返回 `{kind:'retry'}` 即可让同一 step 重发**，无需改宿主。
- 重发时请求体由 `session.deriveMessages()`（surface 投影）重建，所以**在 handler 内改写 surface 就能让下一次请求变小**。
- 该 waterfall 对任何 `failure.code` 都会触发，不限于 `CONTEXT_WINDOW_EXCEEDED` → 我们可以补上官方分类器漏掉的文案。

## 2. 改写点：surface 位置替换

`@deepseek-ai/dsh-compaction-basic/lib/index.js:655-672` 展示了官方唯一的写入协议：

```js
session.append('compaction/start',   { compactionId, ... }, ...)
session.append('compaction/summary', { compactionId, summary, shadowedRange, shadowedSeqs,
                                       shadowedTokenCount, provider, model, ...usage })
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
})
session.append('compaction/end',     { compactionId, ... })
```

事件 schema 见 `@deepseek-ai/dsh-compaction/lib/types/types.d.ts:21-78`（start / summary / end），另有
`:88-101` 的 **`compaction/prune`**：*model-free* 的置换，只带 `shadowedRange / shadowedSeqs / shadowedTokenCount`，
契约要求「紧随其后同步 append 替换体」。→ 这正是零模型兜底路径的官方协议，不必自创事件。

工具配对约束：`@deepseek-ai/dsh-compaction/lib/index.js:100-114` 导出 `toolPairingBalancedBefore/After`，
切点必须落在 tool-call / tool-result 成对的位置，否则 surface fold 会抛 `corrupt surface`。

## 3. 计量点：`ctx.tokenMeter`

`@deepseek-ai/dsh-token-meter/lib/types/index.d.ts:46` → `measure(session, requestHeader?) : TokenMeasurement`
（含 `totalTokens`、逐节点 `nodes`），另有 `estimateMessage`。压缩后端自己也是用它定价
（`compaction-basic:936` `let measurement = meter.measure(agent.session)`）。

## 4. 模型窗口：`ctx.llm.resolveModelInfo`

`compaction-basic:938-941`：`info.context.contextWindow`；缺该字段时抛配置错误。
→ 我们用它拿到**声明窗口**，再与失败文案里出现的数字（实际窗口）比对，这本身就是 #10138 要求的诊断。

## 5. 压缩服务槽：单槽，可选依赖

`@deepseek-ai/dsh-compaction/lib/index.js:170-173`：`class CompactionEngine extends Service { super(ctx,'compaction') }` ——
**每个 context 只能装一个实现**（compaction-basic / smart-compact / 本插件的引擎互斥）。
因此本插件**不抢槽**：用 `ctx.get('compaction')` 可选获取，有就借用 `compactIfNeeded/compactRegion`，
没有就走自己的 fold。这样与 dsh-smart-compact、dsh-glm 等零冲突。

## 6. 硬约束：压缩车道归属（billion-context）

issue #10138 的实测日志：129/129 次压缩调用返回
`422 {"code":"dsh_compaction_refused", "message":"dsh native compaction call refused by billion-context: bili owns compression on this lane"}`。
→ 凡走 `ctx.llm.stream({purpose:'compaction'})` 的摘要都会被拒。

结论：急救器**不能把全部身家押在模型摘要上**。三级降级里必须有：
- T1 官方 `toolResultPruner`（不调模型）
- T3 机械摘要 + `compaction/prune` 置换（不调模型，bili 无法拒绝）
- 仅 T2（模型分段摘要）会撞 bili，撞了要能识别 `dsh_compaction_refused` 并**立刻降级到 T3**，而不是像 #10138 那样每轮重试 129 次。
- 诊断里直接给出可执行开关：`allowDshCompaction: true` / `BILI_ALLOW_DSH_COMPACTION=1`。

## 7. 插件装载

- bundle manifest：`package.json` 的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 内容 `- insert: [{ id, name }]`。
- 纯 ESM，`export const name / inject / apply(ctx)`。
- **peerDependencies 必须用 semver 范围**（`>=0.2.0-rc.0`）。精确锁版本会被 host 的 `evaluatePluginCompatibility` 判不兼容并静默跳过 bundle（本机 dsh-codebuddy 就是这么废掉的）。

## 8. 工具链

| 项 | 状态 |
| --- | --- |
| node | v24.5.0（`G:\SillyTavern\git\node.exe`） |
| pnpm | 有（`%APPDATA%\npm\pnpm`） |
| git | 2.56.0 |
| npm registry | 可达（已成功拉取 `@deepseek-ai/*` tarball） |
| GitHub raw | **不可达**（ETIMEDOUT，走 api.github.com 代替） |
| gh CLI | **缺失** → 发布阶段改用 git push + GitHub REST（或临时装 gh） |

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 安装版宿主 0.2.0-rc.2 与参考源码 0.2.1-rc.5 有差异 | 全部能力运行时特性探测（`typeof session.append === 'function'`、事件名白名单），缺一个就 fail-closed 只报警不动手 |
| 插件写宿主 compaction 事务属「官方引擎专属」路径 | 严格成对括号 + 不闭合时补 `compaction/end {error}` + 提供 `emergencyFold: false` 全局开关 |
| 切点破坏 tool 配对 | 只用 `toolPairingBalancedBefore/After` 选切点 |
| bili 占道 | T3 零模型路径 + 识别 422 立即降级 + 诊断给开关 |
| 重复急救烧 token | 每 turn 次数上限 + 折叠后必须严格变小才提交，否则放弃并原样抛出 |

## 10. 结论

- 拦截、改写、计量、诊断四条链路全部有官方扩展点，**不需要 fork 宿主**。
- 唯一需要谨慎的是「写入协议」属半开放面：schema 稳定、有契约文档，但没有为第三方插件承诺的 ABI → 用特性探测 + fail-closed 兜住。
- 可行性：**通过**。进入工作计划。
