# DSH 0.2.2-alpha.2 迁移记录

从 `0.1.6-alpha.1` 升到 `0.2.2-alpha.2`，cordis 4.0.5 → 4.0.6-alpha.1，schemastery 3.18.5 → 3.18.6-alpha.1。cordis 与 schemastery 的版本必须跟 peer 范围一致：4.0.5 上 Loader 的 volatile 提交路径拿不到引用，`settings.describe().value` 会是 `undefined`。

## 已迁移的五处

### 1. 子代理：`startContinuable` → `startActivation`

新接口要求显式的投递策略。验证器用 `delivery: 'caller'`：判定结果走 settlement 文件，父会话不需要被一条后台通知打断。委派开发代理用 `delivery: 'parent'`，与普通子代理一致。

释放从 `drainContinuableChildren(parent, ids)` 换成 `drainChildren(parent, ids)`。

### 2. 作业：`JobSpec.owner` 收窄为 `SessionId`

`dog_wait` 注册后台作业时传 `exec.agent.id`，不再传 `Agent`。

### 3. 设置：`installSection` 删除

0.2.2 的表单由 Loader 从插件声明的 `Config` schema 投影出来，插件不再注入 section。`installDogSettings`、`DOG_SETTINGS_NAMESPACE` 与「entry + 用户覆盖」的合并逻辑一并删除：Loader 已经把 profile 覆盖合并进 entry，`apply` 收到的 `config` 就是生效值。

代价：配置改动会重启插件。旧实现里只有 `maxConcurrentVerifications` 是热读的；要恢复热更新，需要把该字段声明为 `.volatile()` 并改用 `Volatile<number>.get()`，本次没有做。

### 4. 客户端会话：导航方法删除

`ISessions` 现在只剩对象层：`list`、`retain`、`using`、`retainInfo`、`create`、`subagentAddress`、`refreshProjections`、`search`、`fork`、`scope`、`binding`。`open`、`openSubagent`、`refreshSubagents` 与 `list.current` 全部消失。

`sessionNavigation.ts` 改名为「加载」语义：先按目录成员、`byId` 里的子代理行、`subagentAddress` 依次定位，必要时用 `refreshProjections(parent)` 刷新父会话目录，最后 `retain` 目标并等待 `ready`，结束后立即 `release`。

### 5. 待处理交互：`pendingInteractions` → `sessionStatus`

会话状态合并为每会话一条 `SessionStatus`（`running`、`pendingInteraction`、`completionUnread`）。调试器读 `ctx.uiSession.sessionStatus`，`needsInput` 判据变成 `status.pendingInteraction !== undefined`。

## 宿主差异：没有公开的「切换主视图」接口

0.2.2 把主视图选择交给持有 `mainView` 引用的视图插件，Controller 明确不负责导航。已安装的包里没有任何等价的 `sessions.open(sessionId)`，`ctx.layout.selectPanel(null)` 也明确写了不改变当前会话。

因此调试器按钮从「打开会话」改为「加载会话」：成功即完成定位与历史打开，界面保持打开。如果宿主另外装了会话视图插件并暴露切换入口，需要单独接一条可选通路。

## 验证

- `pnpm typecheck`：通过。
- `pnpm vitest run`：47 个测试通过（新增「子代理兜底行定位」「初始打开失败仍释放引用」两条）。
- `pnpm build`：通过。
