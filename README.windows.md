# Superagent Windows 按需启动

这是 [DeepSeek Harness SuperAgent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)的社区 fork，发布在 [JACKWang19559/dsh-superagent-windows](https://github.com/JACKWang19559/dsh-superagent-windows)。保留上游源码、提交历史、版权与 [MIT 许可证](LICENSE)，不是 DeepSeek 官方 Windows 产品。

**`0.1.0-windows.3` 默认待机。** 在新建会话时选择 **Superagent · 按需启动**，填写 GitHub 仓库名或分支链接并明确启动后，才检查账号、连接 GitHub 和运行仓库编排。执行器使用 Harness 内置 Agent。主 Session 和执行器预设仅供内部创建，从新建会话的模式菜单隐藏。

## 使用方式

1. 在 Harness 新建会话，选择 **Superagent · 按需启动**（预设 id 为 `superagent`）。选择、重新打开会话或查看侧栏只读取本地状态，不会检查 GitHub 或启动后台工作。
2. 填写 `owner/repo`（也接受 `/owner/repo`）、`https://github.com/owner/repo`，或 `https://github.com/owner/repo/tree/分支名`。例如 `https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing` 会选择完整分支 `codex/video-editing`；不带分支时使用仓库默认分支。请复制分支根页链接，去掉查询参数和锚点；`/tree/` 后的整个路径都作为分支，不猜测其中的目录。启动时才使用本机原生 `gh.exe` 当前登录账号检查仓库读写权限及指定分支是否存在。
3. 在控制台明确说“启动 `owner/name` 的 Superagent”，或打开左侧 **Superagent** 管理页，填写仓库并点 **启动 Superagent**。控制台工具要求该会话已经由用户选择“完整访问权限”；它只检查权限，不会代为提升。面板启动按钮旁会说明：**执行会话使用完整文件访问权限，并使用当前 gh 登录账号。**
4. 若显示“需要完成设置”，根据面板的具体错误处理 gh 登录、仓库访问或运行环境，再在面板重新检查。运行后，在 **设置 › 来源 › GitHub** 的 Policy 中填写“能发起工作的 GitHub 账号”，并按需要调整评估规则；允许名单不会自动替用户填写。
5. 从已允许的账号，在该仓库的 Issue 或评论中发出符合策略的请求。面板显示触发、评估、工单和工作会话；实际接单仍受 Policy 控制。先观察一个范围明确的请求，再决定是否扩大来源和规则。

所选会话是**控制台**，实际调度主会话和工作会话分别创建。“打开主 Session”进入真实调度会话；控制台的一条聊天消息不会自动转成工单。GitHub CLI 用于仓库和账号访问，工作由 Harness 内置 Agent 执行，不接入外部 Codex/Claude CLI。

启动后同步 GitHub 通知、讨论及仓库元数据。源码不在选择预设时克隆：新目标初始化时会配置默认 `prepare`，每个新工单首次准备目录时执行 `gh repo clone`，从所选分支（未指定时为默认分支）创建 `agent/<工单名>`。明确指定但不存在的分支会报错，不回退默认分支。评估时读取的仓库文件也使用该分支。GitHub Issue/PR 的接单范围仍由仓库 Policy 决定。

工作环境的 `DSH_SUPERAGENT_GITHUB_BASE_BRANCH` 保存选定的基准分支，未指定时为空；新 PR 应将它作为 `--base`。已有目标的自定义 `prepare` 会保留，自定义命令也应读取该变量。分支名通过环境参数传递，不拼进可执行脚本文本。

一次只运行一个仓库与分支。点 **停止此仓库**，或在控制台明确要求停止，会取消该目标的 GitHub 轮询、监听和工作 Agent；完成后回到待机。切换仓库或分支前先停止当前目标。关闭管理面板不会停止后台工作；Harness 或插件冷重启后总是待机，即使已记住上次仓库和分支，也需要再次明确启动。飞书来源仍默认禁用。

## 准备环境和安装包

需要 Git、GitHub CLI、Windows PowerShell 5.1（也支持 PowerShell 7）、Node.js 24、pnpm 11.7.0，以及已配置模型服务的 DeepSeek Harness Desktop。Windows 来源 CLI 必须是原生 `.exe` 或 `.com`；`.cmd`、`.bat`、`.ps1` 不能作为来源 CLI 配置。GitHub 账号与 push 权限只在明确启动后检查。

获取源码后，在仓库目录打开 PowerShell。下面显式使用新版独立输出目录；使用 PowerShell 7 时可以把 `powershell` 换为 `pwsh`：

```powershell
git clone https://github.com/JACKWang19559/dsh-superagent-windows.git
Set-Location dsh-superagent-windows
powershell -NoProfile -File scripts/build-windows.ps1 `
  -OutputDirectory '.artifacts/windows-bundle-v3'
```

脚本依次安装锁定的源码依赖（禁用安装脚本），运行类型检查和选定的 Windows 回归，构建并验证打包器，再生成本地安装目录、安装生产依赖，最后实际导入 Host、按需控制台、GitHub、飞书 ESM 入口并检查状态目录配置。它输出交给 Harness `plugin_manager` 的安装参数，不修改 Profile。

若使用 Harness 自带的 Node/pnpm，先通过 `load_workspace_dependencies` 获取路径，再传给脚本：

```powershell
powershell -NoProfile -File scripts/build-windows.ps1 `
  -NodePath 'C:\path\to\node.exe' `
  -PnpmScript 'C:\path\to\pnpm.mjs' `
  -OutputDirectory 'C:\Tools\Superagent\bundle-v3' `
  -StateDirectory 'C:\Tools\Superagent\state'
```

这些占位路径需替换为本机实际位置。脚本仅临时调整自身进程 PATH，不修改系统 PATH。若省略输出参数，脚本的默认目录仍是 `.artifacts/windows-bundle`；已有该目录时会拒绝覆盖，升级应明确指定新的版本目录。

已有新版构建产物时，只生成安装包：

```powershell
pnpm bundle:windows --output .artifacts/windows-bundle-v3 --state-dir 'C:\Tools\Superagent\state'
pnpm --dir .artifacts/windows-bundle-v3 install --prod --ignore-scripts
node scripts/check-bundle-import.mjs .artifacts/windows-bundle-v3
```

**生成目录必须安装自己的生产依赖。** Harness 本地目录安装使用链接；代码的 bare ESM imports 需要该目录里的依赖，不能借用源码祖先目录的开发版本。生成包只保留运行依赖和兼容目标所需的四个 peers，导入检查会拒绝缺少本地依赖的包。打包器也会在创建输出前拒绝缺少 `on-demand.js` 或按需插件中英文本地化资源的产物。

## 在 Harness 中安装和升级

让当前 Harness 的代理使用构建脚本输出的绝对目录调用 `plugin_manager`，例如：

```json
{
  "action": "install_bundle",
  "target": "C:\\Tools\\Superagent\\bundle-v3"
}
```

不要手动编辑 Profile 的包清单或 Cordis patch，也不要在 Profile 目录运行 pnpm。以安装器的 `application`、`warnings` 和 `nextStep` 为准；`applied` 表示 Host 安装已应用，仍应验证页面实际加载的客户端。首次安装后刷新当前 Harness 窗口，在新会话中选择新增预设；已有会话保留其原预设版本。

**Windows Desktop 将同名插件升级到另一个本地目录后，需要完整退出 Harness 再重新打开。** Desktop `0.2.1-rc.5` 的 Host 会缓存客户端文件路径及内容，桌面进程还保留启动资源清单；单纯刷新页面不能清除这些缓存。使用应用菜单或托盘里的“退出”，不要只关闭窗口（可能只是隐藏到托盘）。重开后，待机页面应显示仓库输入框和“启动 Superagent”按钮。

若后台 `/orchestrator/control` 返回 `idle`，页面却仍显示旧版概览标签和“dsh-superagent 没有响应”，先核对实际 `/plugins/` 客户端文件是否含有 `/orchestrator/control`。待机时旧 `/orchestrator/api/state` 返回 404 属于正常行为；不要为了消除旧页面的报错而启动仓库。

本地安装通过链接引用生成目录，**保留该目录及其依赖，不要在已链接目录中重新 build 或覆盖文件**。升级前停止当前仓库并备份状态目录，在新的 `bundle-v3`（以后使用新的版本号）目录生成包，再通过插件管理器安装。停用、卸载和升级都使用插件管理器。安装包、依赖和状态数据均不提交到 Git。

## 仓库状态与旧版数据

Windows 默认根状态目录为 `%LOCALAPPDATA%\dsh-superagent`，位于安装包外；也可通过构建参数指定原生绝对路径。显式启动后，每个仓库使用独立目录：

```text
<stateDir>/
  launcher.json
  repositories/
    <仓库与可选分支的 SHA-256 前 32 位>/
      orchestrator.sqlite
      work/
      ...
```

`launcher.json` 只记住仓库名和可选分支，不保存凭据，也不表示自动启动。仓库名比较时忽略大小写，分支名区分大小写。未指定分支时仍使用旧版仓库 hash；显式分支使用“仓库小写名 + NUL + 完整分支名”的独立 hash，包括显式填写默认分支名的情况。各目标的工单、策略、模型设置、检查点和工作目录独立保存，不会自动复制另一分支的设置或恢复其任务。停止后数据保留，旧版仅含仓库名的记忆文件仍可读取。

**旧版根目录下的 `orchestrator.sqlite` 不会自动迁移，也不会被新版改写。** 即使升级沿用同一 `stateDir`，新版仍从 `repositories/<hash>` 读取仓库数据。不要将旧数据库直接覆盖到新仓库目录；旧历史需保留备份，迁移应另行检查后处理。

运行环境按每条命令和 Session 注入，不再修改 Harness 主进程的 PATH/git 全局环境。仓库目录隔离用于分开数据；工作会话使用完整文件访问权限，目录本身不是权限沙箱。

## 检查范围与故障定位

```powershell
pnpm check:windows
```

这运行选定的 Windows 检查，不代表上游所有 Unix 集成测试都已在 Windows 通过。检查包含按需生命周期、Launcher UI、Windows 执行适配、预设/资源、路径与既有核心测试；runtime 测试仍使用限定筛选。实际安装目录的导入检查由完整构建脚本在准备生产依赖后执行。

| 项目 | 当前边界 |
| --- | --- |
| 兼容目标 | Harness Desktop `0.2.1-rc.5`；Node.js 24；pnpm `11.7.0` |
| 生成包 peers | Cordis `4.0.5`、Schemastery `3.18.5`、DSH LLM/Scope `0.2.1-rc.5` |
| 新版源码检查 | 全部 Runtime 94 项、输入解析 40 项、Launcher 26 项、菜单 14 项、原生 Windows 执行 16 项通过；部署、仓库读取、文档与模型工具检查，以及类型检查和 Host/Client 构建通过 |
| 安装检查 | 通过 Plugin Manager 安装到新的版本目录，以 `application: applied`、无激活警告和本地控制接口 `idle` 为检查点；这些检查不需要启动目标仓库 |
| 页面验证边界 | 已实时核对 Client Slot 契约，并以真实 SlotCore/React 测试菜单过滤及选择。独立浏览器没有 Desktop 登录态；升级后需完整退出并重开 Desktop，实际菜单与输入框显示仍需在该窗口确认 |
| 外部业务验证 | 尚未以本版完成真实 GitHub 工单到 Windows Worker 的端到端验收 |

状态排查优先使用 `/orchestrator/control`：带 `x-orchestrator-request: 1` 的 GET 只读取本地状态，待机时始终可用。POST 同路径可请求 `start`、`stop` 或 `status`；面板和控制台工具调用同一个 Host 操作。控制接口校验请求标记和浏览器来源，可以用本机命令检查状态。Harness GUI 本身有登录认证；没有 Desktop 登录态的独立浏览器不能完成页面验收。

运行状态为 `running` 或 `needs-setup` 且面板可用时，再查看 `/orchestrator/api/state` 和设置/工单页。`idle` 期间旧管理 API 未挂载属于正常现象。若仓库访问失败，确认**当前 gh 登录账号**及 push 权限；若 `gh` 不可用，在终端安装或登录后再通过面板明确重试。查看页面和状态不会偷偷探测 GitHub。

## 保留的限制

- 上游 [Unix 服务脚本](scripts/dsh-superagent) 依赖 `fcntl`、Unix `ps`、tmux 和 umask，不是本版 Windows 启动入口。本版通过已有 Harness Host 管理生命周期。
- `Start-Sleep` / `sleep` 检查是启发式正则，不是完整 PowerShell 解析器或安全边界；前台等待时限单独生效。
- Unix mode/chmod 不能证明 Windows NTFS ACL 的私有性；Unix 权限位测试在 Windows 跳过，不据此声称目录只有所有者可访问。
- 本版已补充 PATH/PATHEXT、原生 CLI 检查、PowerShell shim 与 prepare 路径，但自动测试不等于真实仓库执行验收。需要专用操作系统账号等部署隔离时，可参考 [部署文档](docs/006-deployment.md) 的原则；其中常驻服务和全局环境的旧流程以本文为准。

仓库不包含本机数据库、凭据、浏览器状态、个人路径或预生成的机器专用 bundle。本版没有替读者配置外部账号、发送消息或创建 PR。原始代码版权归 DeepSeek Harness Team，Windows 适配及复用的原创锤子图标采用仓库 MIT 许可证；完整许可证随生成包保留。
