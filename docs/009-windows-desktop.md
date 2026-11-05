# Windows 桌面端接入

这条路线保留官方 DeepSeek Harness 桌面应用，通过插件增加 Superagent 面板、本地任务入口，以及 GitHub／飞书任务协作。第一阶段仍围绕一个 github.com 仓库；模型、普通聊天和插件安装使用 DSH 自身的机制。

## 当前支持与边界

- Windows 原生路径、PowerShell 准备命令与代理 CLI 环境。
- 桌面面板发起任务、查看回复、在原任务中追加要求和停止任务。
- 复用已有 GitHub／飞书 Source、Policy、Router、Worker、SQLite 和可靠消息队列。
- 代理账号环境限定在托管执行 scope，普通桌面会话继续使用自己的环境。
- 托管 Session 遵循 DSH 的默认／已保存权限；插件不会在恢复时强制切换成 `danger-full-access`。在需要时，由你在 DSH 中明确选择对应 Session 的权限。

关闭窗口可能只是隐藏应用；**完全退出**会停止本机 Host，休眠也会暂停本机执行。重开后可恢复已持久化任务。电脑离线期间继续处理、跨设备 daemon、完整长期记忆和独立语义 Watchdog 需要额外架构，尚未包含。

## 先核对桌面运行时

在桌面应用菜单选择“管理 dsh 命令…”，安装它自带的命令，然后打开新终端：

```bash
dsh --version
```

当前开发环境的安装版为 `0.2.1-rc.5`。仓库要求的运行时范围见 `package.json`；以后升级仍需重新验证。桌面应用自带运行时和 pnpm，构建本插件所需的 Node／pnpm 则属于开发环境。

先检查当前已有插件：

```bash
dsh plugin --profile desktop list --depth 0
```

如果已有 `dsh-superagent`，先核对其版本与本地链接目录，并在独立测试 home 中验证候选包。不同 Windows 分支可能具有不同入口、配置和数据库约定，切换前先比较并备份。

本次检查到的日常安装是社区 Windows 分支 `0.1.0-windows.6`，当前工作树基于上游原型 `0.1.0`。两者包名相同，同一 profile 不能把它们当成两个插件并排安装。候选版应先用独立 `DSH_HOME`、Electron user-data 目录及 `stateDir` 试用；现有日常安装未被本次工作替换。

| 项目 | 既有 Windows.6 | 当前候选 |
| --- | --- | --- |
| 入口 | 按需启动控制台、启动历史、项目会话内 Superagent 标签 | 全局 Superagent 侧栏、明确的新任务和跟进输入 |
| 运行时机 | 冷启动待机，明确启动后接入选定仓库 | 配置完成后恢复本机 Runtime 和持久化工作 |
| 仓库与分支 | 选择仓库／基准分支，按目标切换 | 一个配置好的 GitHub 仓库；自定义 checkout 由 prepare 决定 |
| 数据布局 | 根目录的 launcher/history，以及 `repositories/<hash>/orchestrator.sqlite` | `<stateDir>/orchestrator.sqlite`，不自动发现或迁移仓库子目录 |
| 会话入口 | 公开 `superagent` 预设及 `on-demand` 子插件 | `dsh-superagent-router`／`dsh-superagent-worker`；不提供旧控制台入口 |
| 执行权限 | 旧流程要求并设置 Full access | 保留 DSH 默认／已保存权限，由操作者批准 |

这不是日常 Windows 分支的直接升级包。不要把旧根状态目录交给候选后就认为历史任务已经迁移；两版的数据库 schema 同为 11，也不能证明目录、配置和会话入口兼容。旧 GitHub 来源配置的 `branch` 字段会被候选的严格来源 schema 拒绝，来源会停用；删除字段也不会保留旧基准分支语义。已有公开 `superagent` 控制台会话缺少候选提供的同名预设，不能直接继续使用。

本指南采用**完全退出 Host 后切换**的方式。热替换时仍存活的旧 Agent 会保留旧 shell scope，可能缺少新版的代理环境；仅关闭窗口或停止旧 Runtime 不足以消除这条路径。冷恢复同名 Router／Worker 预设会重新挂载当前定义，与保留旧 Agent 的热替换不同。旧自定义技能也应检查：候选将 Ticket／Source 的 `DSH_SUPERAGENT_*` 值写入 Worker 提示词，prepare 则获得真实环境变量，不再自动给每条托管 shell 命令补齐这些业务变量。

Desktop 拥有 `desktop` profile。CLI 操作该 profile 前，先启动一次桌面应用完成初始化，再完全退出。使用桌面端自带的 `dsh`，避免用另装的 npm 版 dsh 管理桌面 profile。官方约定见 [Desktop 内置命令运行时](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md#bundled-command-runtime)。

## 隔离试用环境

下面的启动和管理命令以 **Git Bash** 为例，路径换成本机位置。`DSH_HOME` 只传给该次命令；配合独立 user-data 目录，可与日常安装区分。先启动一次试用应用，完成 profile 初始化后从应用菜单完全退出：

```bash
DSH_HOME='D:/AgentData/superagent-trial-home' 'D:/deepseek-harness/DeepSeek Harness.exe' --user-data-dir='D:/AgentData/superagent-trial-ui'
```

后续安装命令必须继续带同一个试用 `DSH_HOME`。重新启动也使用上面的命令；模型和插件状态使用试用环境自己的配置，日常密钥与历史不会自动复制。插件 `stateDir` 另设为例如 `D:/AgentData/superagent-trial-state`。

## 构建和安装

在本仓库目录安装依赖、检查并打包。Windows 终端中已安装 pnpm 时可直接使用 pnpm；以下 Git Bash 命令也适用于尚未全局安装它的环境。若直接使用本次交付的候选包，采用交付记录给出的包路径；下面是自己重建的示例，每次改动后将 `local-1` 换成新的编号。

```bash
npx --yes pnpm@11.7.0 install --frozen-lockfile
```

```bash
npx --yes pnpm@11.7.0 check
```

```bash
mkdir -p .artifacts
```

```bash
npx --yes pnpm@11.7.0 pack --out .artifacts/dsh-superagent-windows-local-1.tgz
```

保留当前日常安装的配置和已有状态备份，在试用应用完全退出后安装生成的本地 tarball。重复构建同一版本时，使用新的 tarball 文件名或升级包版本：本次验证发现，相同 `file:` 路径可能继续命中 pnpm 的旧内容缓存，`--force` 也未刷新它。把下面的 exe／包绝对路径替换成实际路径；这个命令的目标仍是独立试用 home：

```bash
DSH_HOME='D:/AgentData/superagent-trial-home' 'D:/deepseek-harness/resources/runtime/cli/bin/dsh.cmd' plugin --profile desktop add "file:D:/path/to/dsh-superagent/.artifacts/dsh-superagent-windows-local-1.tgz"
```

用前面的试用启动命令重新打开应用，在插件配置中为 `dsh-superagent` 指定独立的绝对 `stateDir`，例如 `D:/AgentData/superagent-trial-state`，再打开侧栏的 Superagent 面板。不要用 POSIX 部署文档的创建 profile 命令覆盖已有 desktop profile。

## 配置一个真实任务闭环

1. **模型：** 沿用 DSH 的模型配置；Eval 和 Execution 可分别选择路由／研判模型与执行模型。
2. **GitHub：** 设置 `owner/name` 和代理账号 CLI。当前启动检查仍要求仓库和写权限；即使只从桌面发起任务，也需先完成 GitHub 配置。
3. **账号：** 为代理使用独立的 GitHub CLI 配置。可以将下列内容保存成 `gh-agent.ps1`，把路径换成实际值；手动通过这个脚本执行 `auth login`，代理账号凭据不写入聊天或提示词。

```powershell
$ErrorActionPreference = 'Stop'
# Direct native argv encoding also preserves quotes, empty arguments and trailing backslashes in Windows PowerShell 5.
function ConvertTo-NativeArgument([AllowEmptyString()][string]$value) {
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = 'C:\Program Files\GitHub CLI\gh.exe'
$start.UseShellExecute = $false
$start.Arguments = (@($args) | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
$start.EnvironmentVariables['GH_CONFIG_DIR'] = 'D:\AgentData\github-agent'
$start.EnvironmentVariables.Remove('GH_TOKEN')
$start.EnvironmentVariables.Remove('GITHUB_TOKEN')
$child = [Diagnostics.Process]::Start($start)
try { $child.WaitForExit(); $status = $child.ExitCode } finally { $child.Dispose() }
exit $status
```

可在专用 PowerShell 子进程中完成这个账号的登录；`RemoteSigned` 只作用于该进程，组织设置的策略仍适用：

```bash
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "D:/AgentData/gh-agent.ps1" auth login
```

4. **Policy：** 本地入口的操作者是服务端固定的 `local:owner`。首次注册时启用该身份；将本地来源的 allowed 列表清空可以撤销权限，插件不会自动加回。GitHub 和飞书分别设置允许发起任务的人。
5. **Execution：** 设置工作目录和 PowerShell prepare 命令，为每个 Ticket 准备独立 checkout／worktree。相关变量仍使用 `DSH_SUPERAGENT_*`，在 PowerShell 中通过 `$env:DSH_SUPERAGENT_DIR` 等名称读取。Git 命令失败必须保留非零退出码。
6. **交付：** 先选一个小修复进行测试，保留人工验收，关闭自动合并。

下面是创建独立 checkout 的 PowerShell prepare 示例。每个 Ticket 使用自己的 `DSH_SUPERAGENT_DIR`；来自 PR 的任务还会取回该 PR 的 head。自定义基准分支应在自己的 prepare 中明确处理。

```powershell
$parent = Split-Path -Parent $env:DSH_SUPERAGENT_DIR
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$url = 'https://github.com/' + $env:DSH_SUPERAGENT_GITHUB_REPOSITORY + '.git'
git clone --quiet -- $url $env:DSH_SUPERAGENT_DIR
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) {
  git -C $env:DSH_SUPERAGENT_DIR fetch --quiet origin $env:DSH_SUPERAGENT_GITHUB_PR_HEAD
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  git -C $env:DSH_SUPERAGENT_DIR checkout --quiet --detach FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

`observe` 只记录推断出的主动工作，不阻止白名单用户的明确请求执行；要停止接单处理，使用面板的暂停执行功能。

账号探测、后续 GitHub／飞书业务调用和飞书实时事件消费者共用 Windows 启动适配。实时事件流不套用单次命令的 90 秒运行期限。stdout／stderr 在分帧时限制单行最多 1 MiB；每条事件处理完成后再继续读取，慢接收方会产生背压。取消会结束读取并释放积压，保留 ready 检查及停用／卸载时的清理。完整匹配的简单 Node 启动器、已支持的无自定义 flags／环境变量的 npm `cmd-shim` 模板，以及插件自身的启动器会转换成原生 argv，不将消息文字再交给 CMD 解析。普通批处理只支持受限语法和安全参数子集，并保守限制在 7000 字符内；未知模板、`CALL ... %*`、DelayedExpansion 或复杂文本会明确报错。需要传递任意消息文本的自定义包装器应采用原生 `.exe` 或本文的 `.ps1` 方式。

管理侧 CLI 的取消与超时会清理本次仍在运行的前台父子进程链，并限制等待输出管道的时间。自定义 CLI 主动脱离父链另起后台程序不在这个清理保证内；托管 Worker 的后台 jobs 继续由 DSH 管理。

## 桌面使用方式

打开 Superagent 面板，输入一项明确任务并提交。请求经已有的 Source／Policy／Ticket 链路进入 Router，再交给 Worker；输入框不会把普通聊天直接改造成 Router。

在任务详情中追加要求或查看已持久化的代理回复。运行多个任务时，检查它们的执行目录和 Worker 并发上限。已有 GitHub 任务也可在满足原授权和本地授权时从桌面跟进；结束的任务不能借此重新开始未授权工作。

GitHub 的后续评论、CI 和飞书话题通过现有 Thread 订阅送入对应任务。飞书初期建议仅在指定群接收 @，使用 bot-only CLI 和短白名单，稳定后再打开少量主动规则。

## 桌面认证与环境隔离

`0.2.1-rc.5` Desktop 从 `dsh-app://app/` 加载客户端。其官方代理先校验应用来源，再移除 Origin／Host 并附带 Host 的认证信息转发请求。因此插件继续使用相对 API、回环 Host 检查和 `x-orchestrator-request`，不需要放宽到任意 Origin 或开放监听地址。

托管 shell preset 提供独立的 subprocess scope，将代理 PATH／Git 设置显式传给子进程；子代理也使用受控 preset。Windows 托管子进程使用进程级 `RemoteSigned` 来运行本机生成的 PowerShell 包装器，环境变量先按大小写无关规则合并；普通会话和宿主进程不受影响，不修改 CurrentUser／LocalMachine 策略。显式的 `-ExecutionPolicy` 和组织组策略仍优先；需要签名的环境应提供符合该策略的包装器。

会话与凭据包装只提供默认调用约束，不构成操作系统隔离。需要更强隔离时使用专用 Windows 账号或执行环境。

## 运行验证

自动测试包括真实 Cordis／Loader／preset 的激活、初始化中卸载和重载、本地提交与去重、授权撤销、首次跨来源跟进及停止路由、回复持久化、PowerShell 参数与退出码、CLI 超时和取消、普通进程环境不变。npm 测试依赖当前固定在仓库声明的 alpha 版本，不能单凭这些测试声称桌面 `rc.5` 的完整 AI 任务已验收。可选的 `DSH_TEST_ELECTRON` 环境变量指向已安装 Desktop exe 时，原生 Windows 测试还会以其子进程 Node 模式验证包装器；它不会启动日常 profile。测试结果以执行时的报告为准。

可用仓库的 Desktop smoke driver 在独立测试 home 中启动已安装应用，检查页面 DOM、点击侧栏、验证真实认证 API 并保存页面文本。先运行一次初始化测试 profile；通过该测试 home 安装插件并设置测试 stateDir 后，再加 `--expect-superagent` 验证。`--screenshot` 可选，部分 Electron 窗口的 Chromium 截图接口会超时；全新测试环境的官方欢迎／登录层也可能遮挡原生主窗，因此 DOM／API 检查不等同于视觉验收。driver 不复制你的模型密钥或账户配置，真实 GitHub／飞书端到端验收需另行完成。

```bash
node scripts/desktop-smoke.mjs --app "D:/deepseek-harness/DeepSeek Harness.exe" --expect-superagent
```

跨信道验收应在明确的测试仓库／测试群中进行：桌面或飞书发起 → 独立 Worker 修改并测试 → GitHub PR／CI 跟进 → 原入口收到结果。最后完全退出再重开，检查任务恢复和人为停止标记。

## 升级和回退

等 Worker 停稳后，备份 `<stateDir>/orchestrator.sqlite` 与插件配置，重新构建 tarball，再通过桌面自带 CLI 更新。新版数据库无法由旧版打开时，回退必须使用升级前的数据库备份。

卸载插件使用桌面官方插件管理器或自带 CLI，保留状态目录直到确认不再需要恢复。不要删掉整个 `desktop` profile。
