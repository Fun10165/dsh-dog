# DSH 0.2.2-alpha.2 迁移对照

升级对象：`@deepseek-ai/*` 从 `0.1.6-alpha.1` 到 `0.2.2-alpha.2`（cordis 4.0.5、schemastery 3.18.5）。
状态：依赖已安装，`pnpm typecheck` 报 5 处不兼容，均在下表；未改动业务代码。

## 1. 客户端会话导航：`ISessions` 的导航方法消失

旧：`sessions.open / openSubagent / refreshSubagents / subagentAddress`，以及 `UiSession.pendingInteractions`。

新：会话改由 slot 作用域的标准 props 提供——`useSessions`、`useSessionStatus`、`useSessionAccess`、`sessionId`、`useSession`；服务侧入口是 `ctx.uiSession`。待处理交互从 `pendingInteractions` 挪到 `useSessionStatus(sessionId).pendingInteraction`，类型名从 `SessionPendingInteractionSnapshot` 变为 `SessionPendingInteractionMap`。

受影响：`src/client/index.tsx`、`src/client/sessionNavigation.ts`、`src/client/agentTelemetry.ts`、`src/client/DogDebugger.tsx`。

方向：这是向更高层封装的迁移——不再直接驱动 Session Controller，而是消费 slot 提供的标准 props 与访问控制（`useSessionAccess`）。

## 2. 子代理：`startContinuable` / `drainContinuableChildren` 消失

新：`SubagentRuntime.startActivation(spec)`（返回 `SubagentActivation`，可带 `childId`）；释放改用 `drainChildren(parent, childIds)` 或 `drainDescendants(parents)`。另有 `listChildren` / `listDescendants` / `prompt` / `interruptByParent` 可直接用，不必自己记子会话。

受影响：`src/dsh/agentic.ts`（两处启动、一处释放）。

方向：把「自己维护 activeVerifiers 映射」换成 `listChildren(parentSessionId)` 的持久目录，减少自管状态。

## 3. 设置：`SettingsForms.installSection` 消失

新：设置页由 Loader 从插件 `Config` schema 生成，插件侧用 `settings.configure({ auto }, owner)` 声明页面策略，读写走 `describe / update / replace / mutate`。

受影响：`src/dsh/settings.ts`（`installDogSettings`）。

方向：插件导出 Schemastery `Config`，删掉 `installSection` 的 base+source 注入；活配置从 Cordis 读取。

## 4. 作业：`JobSpec.owner` 由 `Agent` 变为 `SessionId`

旧：把 `Agent` 传给 `owner`。新：只接受会话 id 字符串。

受影响：`src/dsh/tools.ts`（`dog_wait` 的后台作业）。

## 5. 终态集合

`infeasible` 为 dsh-dog 独有，omp-dog 没有。按「以 omp-dog 为准」的对齐决定，迁移时删除。

## 迁移顺序建议

1. 服务侧三处（子代理、设置、作业）——改动小，先做。
2. 客户端四处——按 slot props 重写，删掉 `sessionNavigation.ts` 里的导航封装，改用 `useSessions` 与 `useSessionAccess`。
3. 迁移完成后再落 DDoG（`dog_init` / `dog_expand`，项目目录存储，阈值可配置、默认照抄 omp）。
