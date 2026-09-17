# dsh-dog → OMP 移植:方案与实施记录

> 状态:**已实施并真机验证**(2026-09-17)。本文前半是核对过的方案,后半(§6 起)是 as-built 结果与证据。
> 调研口径:OMP **18.2.3**(本机 `~/.local/bin/omp`,单文件二进制)+ 官方 npm 包 `@oh-my-pi/pi-coding-agent@18.2.4`(完整 `src/`)。
> 安装位置:`~/.omp/agent/extensions/dog/`(自动发现,已生效)。**仓库形态待定**(见 §9)。

---

## 1. 一句话结论

dsh-dog 的**判据层(引擎/图/存储/台账,3071 行)零改动可用**;适配层与展示层重写。
唯一的硬约束:**OMP 扩展没有任何派发 subagent 的接口**,所以 agentic 判据的执行者从「扩展自己起子代理」改成
「模型用 `task` 派发、扩展做判据与台账权威」。

---

## 2. OMP 机制盘点(实测)

本节每条都注明证据位置,分三类:`探针`(本仓 `docs/omp-probes/` 的脚本与结果 JSON)、
`源码`(官方 npm 包 `@oh-my-pi/pi-coding-agent@18.2.4` 解包后的 `path:line`)、
`真机`(本机 omp 18.2.3 上可重跑的命令与观察结果)。标 `[推断]` 的是我从材料里读出的结论,
不是直接观测。

### 2.1 可用

| 机制 | 入口 |
|---|---|
| 工具注册(+ TUI 自定义渲染) | `pi.registerTool({name,label,description,parameters,loadMode,approval,execute,renderCall,renderResult})` |
| 命令 / 快捷键 / flag | `pi.registerCommand` / `registerShortcut` / `registerFlag` |
| 状态行 / widget / 全屏 overlay | `ctx.ui.setStatus` / `setWidget(key, string[]\|ComponentFactory, {placement})` / `custom({overlay})` |
| 消息卡(不触发 turn) | `pi.sendMessage({customType,content,display:true},{triggerTurn:false})` |
| 子进程 | `pi.exec(cmd, args[], {cwd,signal,timeout})` → `{stdout,stderr,code,killed}` |
| 持久化 | 自己的文件树 + `pi.appendEntry` / `ctx.sessionManager`(只读,含 `getArtifactsDir/saveArtifact`) |
| 组件库 | **静态** `import { Container, Text } from "@oh-my-pi/pi-tui"`(loader 重写到二进制内置副本)。证据:`源码` `src/extensibility/plugins/legacy-pi-compat.ts` 的 `PI_PACKAGE_NAMES` 与 `legacyPiPackageRootOverrides`;`探针` `docs/omp-probes/probe4.ts` → `result4.json`(`canConstruct: "ok"`) |
| 扩展包自带 agent 定义 | `<extension-root>/agents/*.md` 是 task 发现链第 3 层。证据:`真机` 本机会话用 `task {agent:"dog-verifier"}` 派发成功,子代理 `dog-verify-1` 运行 1m8s 并写下结算文件 `<项目>/.omp/dog/dispatches/*.settlement.json` |

### 2.2 不可用 / 受限

- **派发 subagent:无 API**。证据:`探针` `docs/omp-probes/index.ts` → `result.json` 的 `piProto`/`ctxProto` 全量枚举(各 30/23 项,含 `constructor`,无任何 spawn/agent 方法);`源码` `src/extensibility/extensions/types.ts:540` 的 `invokeTool` 注释为同名内置委托。
- 调任意内置工具:不行。证据:`源码` `types.ts:540`(`invokeTool` 只在重注册同名内置时存在)+ `探针` `result.json` 里 `ctxProto` 无通用调用面。
- Web 面板 / HTTP 路由:无官方通道。证据:`源码` `src/modes/rpc/rpc-mode.ts:883-1056`(`--mode=rpc-ui` 只是 stdio RPC + 工具 UI 通道,无 HTTP);导出 HTML 的工具卡来自构建期字面量注册表,扩展工具落 generic JSON 卡。
- 热重载:无,改扩展要重启会话。证据:`真机` 本机实测——改 `index.ts` 新增 `graphFile` 参数后,当前已启动的会话仍按旧 schema 工作,直到另起一次 `omp -p` 才生效;`源码` `src/extensibility/extensions/loader.ts` 只在加载期 import。
- 隔离:扩展与宿主同进程无隔离,未捕获异常掀翻整个 session。证据:`源码` 官方扩展文档 `extensions.md` 的 "Background work" 段(裸 `setTimeout` 抛错会以 `uncaughtException` 结束会话)。
- 扩展包内的 `skills/` 不被发现。证据:`真机` 把 `SKILL.md` 放进 `<extension-root>/skills/<name>/` 后,`omp -p --model <m> "列出含 dog 的 skill 名"` 只返回托管库里的 skill;同一条命令在把该 skill 装成托管 skill 后返回了它。

### 2.3 需要但缺位的概念

OMP **没有通用「验证器」概念**——最接近的只有 advisor 意见、`cleanse` 环、`security_scan` 证据库、subagent `outputSchema` 校验。`[推断]`
依据是 `源码` `src/` 目录清单与官方文档索引(`omp://` 131 篇)里没有验证器契约,只有上述若干专用机制;这是"未发现",不等于"不存在"。
DoG 的机械判据 + 证据台账在这里是**空位补位**,不是重复造轮子。

---

## 3. 逐能力映射

| dsh-dog | OMP | 处置 |
|---|---|---|
| `src/core/*`(engine/model/graph/storage/verifiers/logic/verifier-file/debug) | 无(宿主无关,零 `@deepseek-ai` 引用) | **原样搬**(dog/ 下 core/) |
| `src/shared/protocol.ts`(路由常量) | — | 删 |
| `src/dsh/plugin.ts`(Cordis) | 扩展默认工厂 | 重写 |
| `src/dsh/tools.ts`(8 个工具) | `pi.registerTool` | 重写为 **5 个**(`dog_validate`/`create`/`run`/`status`/`cancel`)+ 2 个展示工具(`dog_graph`/`dog_ledger`);`dog_wait`/`dog_bind_agent`/`dog_delegate_agent` 丢弃(DSH 会话绑定专属 / OMP 跑完即返回) |
| `src/dsh/agentic.ts`(subagents.startContinuable + settlement 轮询) | **无对应** → 模型 `task` 派发 + 结算文件 | **换设计**(§4) |
| `src/dsh/debug.ts`(`/api/dog/*`) | — | 删,改 TUI |
| `src/client/*`(React 面板 2241 行) | `ctx.ui` + `renderCall/renderResult` + `/dog` | 重写为 `omp/panel.ts` |
| 脚本库 `scripts/*.js` | 原样(`pi.exec` 跑) | 搬 |
| `docs/agent-guide.md`(472 行) | OMP skill(`dog-acceptance-gates`) | 改写 |
| 存储 `~/.dsh/dog/` | `<项目>/.omp/dog/` | 换位置(项目级,随仓库走) |

---

## 4. 已确认的五个决策

| # | 决策 | 结果 |
|---|---|---|
| 1 | **驱动权** | **模型派活 + 扩展定生死**:`dog_run` 只做调度与判据,模型用原生 `task` 派发;扩展是状态与判据的唯一权威 |
| 2 | **判据内核** | 两类都保留:脚本判据原样(`pi.exec`);agentic 判据保留「instruction + 冻结对象 → 结算文件」契约,执行者换成模型派发的只读 `dog-verifier`;执行叶子用 `task` 的原生 `isolated:true` 隔离 + 自动回并 |
| 3 | **展示层** | 只做 TUI(状态行 + widget + `/dog` 报告卡) |
| 4 | **落地形态** | 先本机直装 `~/.omp/agent/extensions/dog/`,跑通再定仓库 |
| 5 | **存储** | `<项目>/.omp/dog/` |

### 4.1 agentic 判据的最终形状(吸收 task 隔离面之后)

```
① dog_run {graphId}
     ├─ 有 agentic 目标缺结算 → 返回 status:"needs_verification" + 每目标一条 brief(不跑引擎)
     └─ 否则 → 跑引擎:脚本判据 inline;agentic 判据读结算文件
② 模型把 brief.verifierTask 原文发给 task(agent: dog-verifier, 只读工具 + write)
③ 子代理写结算文件 → 回到 ①
```

**机械绑定**(三条全过才认):结算必须绑定 ①`inputSha256`(冻结捕获的字节摘要)②`instructionHash`(判据原文哈希)
③**mtime 晚于派发请求**。任一不符 = `inconclusive`(绝不 pass)。

**冻结对象**:派发时把捕获字节**物化**到 `<dogRoot>/dispatches/<requestId>/object/<target>`
(目录捕获解包成 tar),子代理读的是**引擎判的那份字节**,不是活的工作区。

**信任边界(必须说清)**:结算由子代理写,模型自己也能写文件——**"模型伪造结算"原理上防不住**(DSH 版同样如此)。
上面三条是**绑定**不是防伪;它保证的是"旧字节/别的判据的判决不可能被复用"。

**注意**:`outputSchema` 的结构化结果只回给**模型**,扩展拿不到 `task` 的返回值 → 判据权威只能建立在磁盘文件上。

---

## 5. 反侵入审计(用户提问后逐条核对)

| 用了什么 | 性质 |
|---|---|
| `registerTool` / `registerCommand` / `zod` / `exec` / `sendMessage(triggerTurn:false)` / `ctx.ui.*` / `ctx.cwd` / `hasUI` | 全部文档化上层面 |
| **明确没用** | `pi.pi` 下的 `AgentSession`/`AgentRegistry`/`createAgentSession`(底层)、`ctx.invokeTool`、`ctx.sessionManager` 写面、`concurrency` 透传(非类型化)、HTTP server、后台定时器 |

审计改掉两处:

1. **删掉了 `session_start` 里的孤儿 run 恢复**:同进程多会话(subagent)/多进程同目录时会误杀别人正在跑的 run,
   且引擎的 `prepareRun → supersedePriorRunningRuns` 已覆盖同图历史 run。现在扩展**加载期零副作用**,只在工具调用与 `/dog` 里碰东西。
2. **`dog_run` 的 approval 从 `write` 改成 `exec`**:它会 `pi.exec` 跑判据脚本,按 OMP 档位定义属代码执行层,标低了会绕过 exec 门禁。

另外按"少占界面/少占提示词"收敛:widget 只在 run 未终结或显式请求时挂;工具面 3 个 essential(`create`/`run`/`status`)+ 4 个 discoverable。

---

## 6. 实施结果(as built)

```
~/.omp/agent/extensions/dog/
  index.ts            扩展入口:7 个工具 + /dog 命令 + 面板
  omp/config.ts       项目级配置(storage/workspace/scripts)
  omp/kernels.ts      两个判据内核(pi.exec / 结算文件)
  omp/settlement.ts   派发与结算契约(id 派生、mtime 校验、物化)
  omp/dispatch.ts     派发前置检查(镜像引擎的继承锚点)
  omp/panel.ts        状态行/widget/报告投影
  core/*.ts           原样搬运的 12 个核心文件(3071 行)
  schemas/schema-0.2/ 5 个 JSON Schema(ajv 校验层)
  scripts/*.js        判据脚本库(file-non-empty / slop-phrases)
  agents/dog-verifier.md   只读判据子代理定义
  skills/dog-acceptance-gates/SKILL.md   产品手册(另装为托管 skill)
  package.json + node_modules(ajv/ajv-formats)
```

**类型检查**:`tsc --strict` **0 错误**(配方见 skill `omp-extension-authoring-facts` §10.7)。

---

## 7. 验证证据(真机)

| 项 | 结果 |
|---|---|
| 扩展自动发现 | 新会话顶层出现 `dog_create`/`dog_run`/`dog_status`;另 4 个挂 `xd://` 设备 ✓ |
| 脚本判据闭环 | `dog_create → dog_run → dog_status`:`rootState: success`,evidence `{outcome:"object is non-empty",bytes:15}`(与实际产物一致) ✓ |
| **agentic 判据闭环** | 模型 `task` 派发 `dog-verifier` → 子代理读**冻结副本**、自查 sha256 与绑定值一致 → 写结算 → 引擎判 success(35s) ✓ |
| **证伪(坏样本)** | 产物不含要求的行 → 子代理判 `fail` → leaf `failure` → root 传播「required non-tolerable child leaf failed」 ✓ |
| 继承 | 同图重跑:leaf `inherited`(指向来源 run),证据保留,0 重判 ✓ |
| 派发前置 | `dog_run` 在缺结算时返回 `needs_verification` + 完整 brief(不跑引擎、不污染 run) ✓ |
| TUI 面板 | pty 真终端抓帧:状态行 `dog success ✓↺`、widget 两行(逐节点)、`/dog` 报告卡(逐节点 + 证据) 全部渲染 ✓ |
| 台账 | `dog_ledger` 返回判决身份(scriptDigest)、证据、运行时事件(`result_inherited`) ✓ |
| 冒烟产物 | `/tmp/dog-smoke/.omp/dog/`(图 3 个、run 若干、捕获与结算齐全) |

---

## 8. 移植硬陷阱(踩到会浪费一天)

1. `execute` 参数顺序是 **`(toolCallId, params, signal, onUpdate, ctx)`**——官方 README 示例是错的。
2. **静态** `import "@oh-my-pi/pi-tui"` 可用;**动态** `import()` 一律失败(loader 只重写静态 specifier)。
3. `loadMode` 默认 `discoverable` → 工具被藏进 `xd://`;要顶层必须 `essential`。
4. `pi.zod` 的类型推断传不到 `parameters` → execute 的 `params` 必须手写注解。
5. `AgentToolResult.content` 可变;`evidence`/`details` 里不能有值为 `undefined` 的键。
6. 扩展包内 `skills/` 不被发现(要装托管 skill)。证据同 §2.2。
7. 无热重载(证据同 §2.2);`-e` 与自动发现会重复命中,测试时别混用。`[推断]` 后半句由加载路径推出(`-e` 与 `discoverExtensionPaths` 两条来源合并),未单独设计实验区分。
8. `tar` 是外部依赖(捕获目录、物化对象都用它),与 DSH 版一致。

---

## 9. 待你定的两件事

1. **仓库形态**:现在装在本机(自动生效)。要落成仓库可选:(a) 新仓 `omp-dog`(core 从 dsh-dog 搬,两产品并列) / (b) dsh-dog 单仓双宿主 / (c) 就停在本机直装。
2. **旧 skill 去留**:托管库里还留着 DSH 版的 `dog-v02-agentic-ci`(它的工具名/流程是 DSH 的,在 OMP 会话里会误导)。是把它退役(归档),还是保留给 DSH 会话用?

---

## 10. 明确不做的事

- 不碰 `pi.pi` 下的内部类;不声明 `concurrency`;不起 HTTP 面板;不在加载期做任何有副作用的动作。
- 不为移植重写 `src/core`(零依赖分层是这次移植最大的红利)。
- 不改 OMP 源码、不动 `~/.omp/agent/config.yml` 既有配置。
