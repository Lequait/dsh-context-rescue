# 发布这个插件

凡是不需要凭据就能做的东西，都已经做完并且是绿的：

| 闸门 | 命令 | 结果 |
|---|---|---|
| 单测 + 折叠 + 急救 + 事务修复 + 摘录 + 工具 + 命令 + schema + 市场 + 列表规则 + 发行说明 | `npm test` | 148 tests, 145 pass, 3 skipped（仅宿主侧） |
| 同一套在应用自己的 Node 下跑 | `npm run test:host` | 148 tests, 146 pass, 2 skipped |
| `index.js` + `lib/` 的 JSDoc 类型契约 | `npm run typecheck` | 14 个文件 0 error |
| 四种失效场景 | `npm run simulate` | 全过 |
| 在已安装宿主的 cordis 4 里挂载 | `npm run mount-check` | 26 条断言通过 |
| 打包 → 安装 → 宿主 bundle 解析 | `npm run install-smoke` | 16 条断言通过（tarball 内容、安装后的 manifest、宿主加载器、兼容性、导入入口、裸模块名解析） |
| 对着一个一次性远端跑发布流程 | `npm run publish:rehearse` | 18 条断言通过（首次推送把 `master` 改名为 `main`；已经发布 `master` 的仓库保留它；被宿主接受的索引条目、钉住的 commit、安装 spec） |
| 扫描本机抓到的一切会话日志 | `npm run scan` | 216 logs, 34 oversized, 34 rescued, 182 skipped, 0 failed |
| 真实应用启动并挂载 bundle | `npm run boot-check` | 33 条断言：植入的 throw 以插件条目出现，真包启动则无此字样，且在 `billion-context`（车道归属者）与 `dsh-smart-compact`（引擎覆写者）旁边同样能挂，还能组合进桌面应用实际运行的 `web` 形状（与渲染命令面的是同一棵树），最后把这个宿主真的启动起来：打印 URL、发放鉴权 cookie、把 UI 文档服务出来 |
| 宿主自己的 `Session` 类（来自应用 bundle） | `npm run host-session` | 222 份日志播种成功，70 份被折叠（其中 32 份走预检路径），152 份宿主自己拒绝播种，0 失败 |
| 一次救援与一次预检的代价 | `node scripts/dev/rescue-bench.mjs` | 在最大的 19 份日志上：救援中位数 1.1 s、p95 7.9 s（大部分是读日志）；预检冷 16 ms、热 0 ms——同一轮里的第二次检查不重新测量 |
| 槽里的真实宿主压缩引擎 | `npm run coexist` | 14 条断言：`compaction-basic` 仍占着槽，无模型时借用会失败，零模型的折叠完成，事务闭合 |
| 按用户的方式安装 | `npm run e2e-install` | 10 条断言：`dsh plugin --profile … add <tarball>` 建出 profile、打开 bundle，宿主加载器能从里面解析出 patch；完成后删掉 profile |
| 从发布过的 spec 安装 | `npm run e2e-install -- --git` | 同一个 CLI 上的 11 条断言，但 spec 是 `git+https://github.com/Lequait/dsh-context-rescue.git#<ref>`——README 让用户跑的那一行——所以证明的是 git 源也能装、也能注册，不只是 tarball |
| 从 npm 安装 | `npm run e2e-install -- --npm` | 同一个 CLI 上的 11 条断言，spec 是 `dsh-context-rescue@<version>`——人们真正会装的 registry 条目——并检查记录下来的依赖确实带着已发布的版本号 |
| 按 Discover 页的方式安装 | `npm run market-install` | 17 条断言：抓取已发布的索引、交给宿主 `parseMarketIndex`、向 `marketInstallTarget` 要 spec、装那个被钉住的 commit、确认宿主加载器在装好的副本里找到 patch——这一行否则只能在发布后才失败 |
| 声明出来的配置 schema 被宿主使用 | `npm run schema-check` | 11 条断言：dump 把我们的条目投影到它自己的某个 `config` 定义上（不是 `unknownConfig`），该定义列出我们接受的开关并保留 `retainRatio` 的边界，越界的 patch 会让启动失败并点名字段与边界，合法的 patch 能通过配置阶段启动 |
| 市场索引条目 | `npm run market -- --repo-slug OWNER/dsh-context-rescue` | 由宿主校验 |

剩下的事情都需要一个已认证的远端：上面这些没有一条能自己创建或写入一个托管仓库。

由日志得来的数字（`216 logs`、`34 rescued`、`70 folds`、`152 skipped`）和下面的 bench 耗时是这台开发机的
快照：会话一多它们就变，`scan`、`host-session`、`rescue-bench` 会重新算。

那张表里有四行需要联网：`e2e-install -- --git`、`e2e-install -- --npm`、`market-install`、`publish:rehearse`
（最后那个只跟本地裸仓库打交道，但它会先克隆真实远端）。当它们需要的宿主完全连不上时，它们会打印 `SKIP` 和
失败的那一行并 exit 0，`npm run verify:network` 把它们记成 `skip` 而不是 `ok`——合计那行会明说
（`2/3 gates passed …, 1 skipped (no network)`）。SKIP 只按连接层输出判定（`Failed to connect`、
`ECONNRESET`、`getaddrinfo`、`Could not resolve host` 等），所以"连得上但给出错制品"的宿主照旧判失败。
直连被墙时，把那一组走代理跑：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://HOST:PORT npm run verify:network` ——
2026-10-31 就是这么把那四行网络闸门填成 `4/4` 的。

## 1. 建仓库

<https://github.com/Lequait/dsh-context-rescue> 已存在，默认分支是 `master`。实际跑的是：

```bash
npm run publish:remote -- --repo Lequait/dsh-context-rescue --dry-run   # 只打印计划
npm run publish:remote -- --repo Lequait/dsh-context-rescue
```

分支保持 `master`，是因为那个仓库创建时默认就是 `master`，而脚本只在远端完全没有该分支时才改名。一个没有默认
分支的全新仓库会得到 `main`。

新仓库的话，要么在 GitHub 上建一个空仓库（不要 README、不要 license——本 checkout 两者都有），再跑同一条命令；
要么手工来：

```bash
cd dsh-context-rescue
git remote add origin https://github.com/OWNER/dsh-context-rescue.git
git push -u origin main
```

……或者，如果仓库是在别处建的，推这个 bundle 而不是工作副本（把 `<version>` 换成你手上的文件名）：

```bash
git clone dsh-context-rescue-<version>.bundle dsh-context-rescue
cd dsh-context-rescue && git remote add origin <URL> && git push -u origin main
```

没有令牌时，HTTPS 推送走 git credential helper，它的 GitHub OAuth 窗口就够了——不需要手输任何令牌。SSH 需要
密钥（`ssh-keygen -t ed25519`，然后把 `~/.ssh/id_ed25519.pub` 加到 GitHub）。这台机器没有 `gh` CLI，但 DSH
bundle 自带的 `git-credential-manager.exe` 早已登录。

## 2. 让它可被发现

- 仓库 topic：`dsh-plugin`（这是生态里各份列表扫描的那个 topic）。
- `publish:remote` 已经重新生成并推送了 `market/index.json`；发布新版之后要再手工生成一次，免得列表一直指向旧
  构建。该文件是提交进仓库的，所以新克隆里本来就有；`.gitignore` 列出它只是因为 `publish:remote` 每次推送都会
  重写，而提交进去的那份必须永远钉一个真实存在的 commit：

  ```bash
  npm run market -- --repo-slug OWNER/dsh-context-rescue --out market/index.json
  git add market/index.json && git commit -m "chore: market index entry" && git push
  ```

  条目钉的是一个 commit，所以想让列表指向更新的构建就要重新生成。把 `market/index.json` 从仓库的 raw URL 服务
  出去，或者发布到任何 HTTP 可达的地方，然后把这个 URL 作为索引源加进 Discover（市场 bundle 初始是
  `indexes: []`，不加源就什么都不列）。

- 本仓库的实际取值（2026-10-30 核对）：索引 URL
  `https://github.com/Lequait/dsh-context-rescue/raw/master/market/index.json`（HTTP 200，被宿主
  `parseMarketIndex` 接受），jsDelivr 镜像
  `https://cdn.jsdelivr.net/gh/Lequait/dsh-context-rescue@master/market/index.json`（HTTP 200），topics 已是
  `compaction, context-window, deepseek-harness, dsh-plugin, slash-commands`。
- 用户有两条路，这里都实测过：直接从 git 装
  （`dsh plugin --profile <p> add git+https://github.com/Lequait/dsh-context-rescue.git#<commit>`，由
  `npm run e2e-install -- --git` 与 `npm run market-install` 证明），或者把索引 URL 加成索引源、在 Discover
  页里装那个钉住的 commit。官方市场 bundle（`@deepseek-ai/dsh-plugin-market`）是可选的——没有它，profile 仍能
  从 git spec 安装。

## 3. 列表的 pull request

那份列表由数据文件生成，所以一次投稿是**一个 YAML 文件**，不是 README 里的一行：
`data/plugins/Lequait__dsh-context-rescue.yml`（本仓库把内容原样保存在
[`awesome-entry.yml`](awesome-entry.yml) 里）。已对照
[`contributing.md`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 核对：

```yaml
url: https://github.com/Lequait/dsh-context-rescue
name: Lequait/dsh-context-rescue
category: session
description:
  en: Recovers a session the host already refused for exceeding the context window — it re-checks
    the gateway message the built-in classifier misses, takes the real window out of that message,
    and folds the oldest span into one checkpoint without a model call (tool-result pruning, the
    host compaction engine, or a mechanical digest fold), then retries the failed step.
  zh: 抢救已经被上下文窗口拒掉的会话：补上宿主分类器漏判的网关文案，从失败信息里拿到真实窗口，
    不调用模型把最旧的一段历史折成一个检查点（工具结果裁剪、借宿主压缩引擎、或纯机械摘要折叠），
    然后重试失败的那一步。
```

适用于本仓库的要求，2026-10-30 对照指南核对过：

| 规则 | 状态 |
| --- | --- |
| `package.json` 里有 `dsh.bundle` manifest | 有（`bundle.patch`） |
| [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic | `Lequait/dsh-context-rescue` 已设 |
| 真实可用的代码 | 148 个测试，第九道宿主侧闸门 |
| 仓库至少 **1 天** | 创建于 2026-10-30T10:28Z，所以不早于 2026-10-31T10:28Z 提交 |
| 描述只讲功能 | 没有最高级形容词；上面每条说法都能对到 `lib/` |

从 fork 提交 pull request（维护者在 merge 后重新生成两份 README）：

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cp <this repo>/docs/awesome-entry.yml data/plugins/Lequait__dsh-context-rescue.yml
git checkout -b add-dsh-context-rescue
git add data/plugins/Lequait__dsh-context-rescue.yml
git commit -m "Add Lequait/dsh-context-rescue"
git push -u origin add-dsh-context-rescue
```

同一次投稿走脚本（实际就是这么提交的）：`npm run awesome -- --prepare` 做除了开口 PR 之外的每一步——先把 fork
同步到上游（`POST /repos/{fork}/merge-upstream`），断言 fork 的 `main` 与上游相等之后从**fork 自己的** `main`
起分支（ref 只能指向 fork 真有的 commit，这就是直接拿上游 sha 建分支会得到 `422 Object does not exist` 的原因），
写入条目，并且在 compare 不是"恰好一个新增文件、零删除"时拒绝继续。`--prepare` 只容忍一个门槛问题、且只容忍它：
`too-young`，因为光有一个分支不会让任何东西上榜。之后真正提交是 `npm run awesome`，它会重复一遍检查并开口 PR。

那份列表自己的 CI 会检查什么，提交前已在本机复现（2026-10-31）：条目文件正好放在
`data/plugins/<owner>__<repo>.yml`；`node scripts/generate-readme.mjs` 把两份 README 重新生成到 7925 条，
随后 `--check` 干净；四个规则套件（`added-dates`、`capabilities`、`adopt-discussions`、`entries-path`）分别
3 / 9 / 9 / 3 全过；`SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs` 带上条目把站点构建出来——added-date
是从 git 历史推出来的，所以构建只接受"已提交的条目"，而 pull request 恰好就是那个形态。`npx awesome-lint`
在本机复现不了：Windows 上它把 README 自己的路径当成仓库 URL
（`Invalid GitHub repo URL: G:\\Temp\\awesome-check\\README.md`），一个未改动的克隆上报同样的错，所以 lint
留作 CI 侧检查而不是本地检查。

### 3a. 2026-10-30 提交的列表

`awesome-dsh-plugin` 有一天年龄规则，所以那一份排到第二天。另外两份列表当天就收下了，都是走 GitHub API
（fork → 一行 commit → pull request），中间没有克隆：

| 列表 | 提交了什么 | 状态 |
| --- | --- | --- |
| [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | `README.md` 与 `README.zh-CN.md` 里 **Context & Search** 下一行——该指南要求两种语言同一个 PR | [PR #768](https://github.com/0xsline/awesome-deepseek-harness/pull/768)，open、mergeable、2 文件 / +2 行 |
| [AdamPlatin123/dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar) | `PLUGINS.md` 的 🔌 单插件表里一行（这份列表每天 02:00 还会自动发现带 `dsh-plugin` topic 的仓库） | [PR #986](https://github.com/AdamPlatin123/dsh-plugin-radar/pull/986)，open、mergeable、1 文件 / +1 行 |
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | `data/plugins/Lequait__dsh-context-rescue.yml` | 门槛过后已提交：[PR #10903](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10903)，PR check 与提交闸门双绿 |

### 3b. 第二波，用计划文件驱动

每份列表要的是同一个改动，只是包装略有不同——一个 README 里一行、两个 README 里各一行、某个分类文件里一行——
所以第二波用计划文件驱动，而不是一次性脚本。`market/listings/<list>.json` 说明改哪个文件、锚点哪一行、插入什么；
`scripts/dev/list-plan.mjs` 离线校验它；`scripts/dev/submit-list.mjs` 执行它（fork → 分支 → `PUT contents` →
pull request），并且在锚点命中多行、或条目已经存在时拒绝去猜。

```sh
npm run list-pr -- --plan market/listings/kejixiaoliang.json --dry-run
npm run list-pr -- --plan market/listings/kejixiaoliang.json
```

| 列表 | 提交了什么 | 状态 |
| --- | --- | --- |
| [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) | `plugins/context-memory.md` 里 **上下文审计 / 压缩 / 蒸馏** 下一行 | [PR #173](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/173)，open |
| [beancookie/awesome-dsh-plugin](https://github.com/beancookie/awesome-dsh-plugin) | 计划在 `market/listings/beancookie.json`：`README.md` 与 `README.en.md` 各一行，放在 **Sessions & Messages** 下 | 本账号提交不了，见下 |
| [GordenSun/awesome-dsh-plugins](https://github.com/GordenSun/awesome-dsh-plugins) | 计划在 `market/listings/gordensun.json`：`README.en.md` 与 `README.md` 各一行，放在 **Orchestration, memory, and workflow** 下 | 同一限制 |
| [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) | 未尝试 | 同一限制 |
| [Alex-Yanggg/awesome-DSH-plugin](https://github.com/Alex-Yanggg/awesome-DSH-plugin) | 未尝试 | 同一限制（对 GitHub 来说 `awesome-DSH-plugin` 与 `awesome-dsh-plugin` 是同一个名字） |

这个阻碍值得记下来，因为它不在任何列表的规则里：**GitHub 每个账号、每个仓库名只允许一个 fork。**
`Lequait/awesome-dsh-plugin` 已经是 `awesome-dsh-plugin/awesome-dsh-plugin` 的 fork（第一波），
`Lequait/awesome-dsh-plugins` 是给 `kejixiaoliang` 那个 PR 建的 fork。其余列表只要名字是这两个之一——大小写
不敏感，因为 GitHub 认为 `awesome-DSH-plugin` 和 `awesome-dsh-plugin` 同名——共用那个仓库：本地 fork 的 `main`
和上游不在同一个 commit 上，于是用上游 sha 建分支会 `HTTP 422 Object does not exist`。`submit-list.mjs` 现在会
在写任何东西之前比较 `parent.full_name`，把这个原因报出来而不是丢一个 422。

真正剩下的路：找一个仓库名没被占用的列表（`diegosouzapw/awesome-omni-dsh-plugins` 是一个，但它的 README 由 43
个 locale 的目录生成并在 CI 里校验，所以它要的是数据文件 PR 而不是一行），或者换第二个 GitHub 账号，或者等两个
open 的 fork 被 merge 后删掉它们。计划文件留在 `market/listings/` 里，上面任何一条路都只差一条命令。

## 4. npm

**已完成：`dsh-context-rescue@0.2.2` 于 2026-10-31 手工发到 npm，`0.2.3` 与 `0.2.4` 由 tag 发出**——
`git push origin v0.2.3` 触发了 `release.yml`，它通过 `NPM_TOKEN` secret 发布并把 `latest` 留在这个版本上；
`npm run e2e-install -- --npm` 随后把那个确切版本装进一次性 profile。发布不再需要一个坐在终端前的人。
`NPM_TOKEN` 仓库 secret 已设，所以以后任何 `git tag v*` 都会通过 release workflow 自动发布。
`npm i dsh-context-rescue` 能解析；一次性 profile 能装上并注册 bundle。

有一个制品需要知道：npm 的分阶段发布（staged publishing）会用公开的 `0.0.0-stage` 占位版预留一个新包名。
granular 令牌删不掉它，所以把它 deprecated 了（`npm deprecate dsh-context-rescue@0.0.0-stage "placeholder
created by staged publishing; install 0.2.2 or later"`），这就是有人按名字点名它时看到的东西。`latest` 指向
0.2.4，所以普通 `npm i dsh-context-rescue` 永远不会解析到占位版。

要么本地发，走守卫脚本：

```bash
npm run publish:npm -- --dry-run   # 脏工作区拒绝；检查 tarball 清单；证明版本没被占；
                                   # 没登录时直接说出来
npm login                          # 唯一需要账号的一步
npm run publish:npm                # 发布，然后打印安装行
```

要么让 release workflow 从 tag 发——它先跑类型检查、测试、模拟、安装 smoke 与发布排练，拒绝与 `package.json`
不一致的 tag，然后带 provenance 发布：

```bash
git tag v0.2.4 && git push origin v0.2.4   # NPM_TOKEN 已设；workflow 负责发布
```

同一个 workflow 还负责建 GitHub release 页，正文取 `CHANGELOG.md` 里该版本的那一段
（`node scripts/dev/release-notes.mjs <version>` 打印的就是它用的内容）。这就是为什么页面读起来像人写的，而不是
生成的英文 commit 标题，也是为什么 changelog 是唯一要改的地方。已经存在的 release 不会被碰，所以重跑任务是安全
的，手改过的页面也不会被覆盖；段落缺失时正文指向 changelog，而不是编造内容。0.2.0–0.2.4 的页面早于这一步：
它们是手工建的、事后翻译的，`v0.2.4` 的 tag 与它缺失的 release 页之间的缺口正是这样发现的。

包里带 `index.js`、`lib/`、`cordis.patch.yml`、`market/icon.svg`、`docs/`、两份 README、`CHANGELOG.md` 与
license——tarball 只带 `market/` 里的那张图标，因为 `market/index.json` 是从仓库直接服务的；
`publishConfig.access` 已经是 `public`。发布之后，市场生成器的 `--npm` 会把列出的源从钉住的 commit 切换成
`dsh-context-rescue@<version>`。
