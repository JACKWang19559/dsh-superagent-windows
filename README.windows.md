# SuperAgent Windows 安装适配

这是 [DeepSeek Harness SuperAgent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)的社区 fork，发布在 [JACKWang19559/dsh-superagent-windows](https://github.com/JACKWang19559/dsh-superagent-windows)。保留上游源码、提交历史、版权与 [MIT 许可证](LICENSE)，不是 DeepSeek 官方 Windows 产品。

**本版本完成的是 Windows Desktop 插件安装与管理入口适配。完整的原生 Windows Worker 执行链路尚不支持，不能直接当作生产自动化服务使用。** 以下步骤可以复现安装准备；配置真实仓库前，请先阅读本文末尾的已知限制。

## 已完成的工作

- 配置接受 Windows 盘符路径、UNC 路径、含空格/中文的路径，并保留 Unix 绝对路径支持。
- 主会话按实际存在的继承工具生成允许表，支持只有 `pwsh`、没有 `bash` 的 Windows Profile。
- `pwsh` 使用与 `bash` 一致的前台等待时限策略；对常见直接 sleep 命令做启发式检查。
- 提供 PowerShell 构建入口、参数化安装包生成器、生产依赖准备及实际 ESM 导入检查。
- 提供图标、GitHub/飞书来源插件的中英文显示资源，以及 Windows 专用的相关回归检查与 GitHub Actions。
- 所有本机路径在本地生成包时写入；仓库不分发账号配置、数据库或个人安装记录。

## 已验证环境与边界

| 项目 | 范围 |
| --- | --- |
| 操作系统 | Windows，本地 Desktop 安装 |
| Harness | `0.2.1-rc.5` |
| Node.js | 本地验证 `24.21.0`；建议 Node.js 24 |
| pnpm | 源码构建锁定 `11.7.0` |
| 运行时 peers | Cordis `4.0.5`、Schemastery `3.18.5`、DSH LLM/Scope `0.2.1-rc.5` |
| 安装 | 插件管理器最终返回 `application: applied`、无警告 |
| 管理入口 | 运行中 Client 的侧栏与主面板注册 active；管理 API 可读 |
| 业务状态 | 未配置目标仓库时为 `repositoryUnset` / `setupPending`，没有运行或排队的任务 |
| 未完成验收 | 真实 GitHub/飞书任务、完整 Windows Worker、页面点击和图标截图验收 |

上游 `engines.dsh` 的版本范围不等于每个版本都经过验证。本 fork 的生成包 peers 对齐上述已验证版本，不使用版本豁免。源码开发依赖保留上游版本；生成包另外用已安装的 rc.5 peers 做真实导入检查。

## 准备环境

需要 Git、Windows PowerShell 5.1（也支持 PowerShell 7）、Node.js 24、pnpm 11.7.0，以及已运行的 DeepSeek Harness Desktop。获取源码后，在仓库目录打开 PowerShell。使用 PowerShell 7 时，也可将下面命令的 `powershell` 换为 `pwsh`。

```powershell
git clone https://github.com/JACKWang19559/dsh-superagent-windows.git
Set-Location dsh-superagent-windows
powershell -NoProfile -File scripts/build-windows.ps1
```

脚本依次执行：

1. 用锁文件安装源码构建依赖，禁用依赖安装脚本。
2. 运行类型检查、选定的 Windows 相关回归、构建和打包器测试。
3. 在 `.artifacts/windows-bundle` 生成完整的本地安装包。
4. 在生成目录安装生产依赖与已验证的 Harness peers，禁用依赖安装脚本。
5. 实际导入生成的 Host/GitHub/飞书 ESM 入口，并检查原生状态目录配置。
6. 输出交给 Harness `plugin_manager` 的安装参数。

如果使用 Harness 自带的 Node/pnpm，可在 Harness 中先调用 `load_workspace_dependencies` 获取实际路径，再传入脚本。以下路径是占位示例，需替换为工具返回值：

```powershell
powershell -NoProfile -File scripts/build-windows.ps1 `
  -NodePath 'C:\path\to\node.exe' `
  -PnpmScript 'C:\path\to\pnpm.mjs'
```

无需把这些路径写进仓库或修改系统 PATH。脚本只在执行期间调整自身进程的 PATH，并在结束时恢复。

## 输出目录与状态目录

默认安装包目录为仓库内被 Git 忽略的 `.artifacts/windows-bundle`。Windows 的默认状态目录为 `%LOCALAPPDATA%\dsh-superagent`；它在安装包外，首次插件启动时才创建数据库。

可自定义目录：

```powershell
powershell -NoProfile -File scripts/build-windows.ps1 `
  -OutputDirectory 'C:\Tools\SuperAgent\bundle-v1' `
  -StateDirectory 'C:\Tools\SuperAgent\state'
```

脚本拒绝覆盖任何已存在的输出目录，也拒绝把状态目录放进安装包。准备新版本时使用新的输出目录，不要覆盖已被 Harness 链接使用的目录。

若已有构建产物，只生成包：

```powershell
pnpm bundle:windows --output .artifacts/windows-bundle-v2 --state-dir 'C:\Tools\SuperAgent\state'
pnpm --dir .artifacts/windows-bundle-v2 install --prod --ignore-scripts
node scripts/check-bundle-import.mjs .artifacts/windows-bundle-v2
```

**必须安装生成目录的运行依赖。** Harness 的本地目录安装使用链接，不会替这个目录补齐全部 bare ESM imports。本次安装曾因缺少 `zod` 和 Schemastery 加载失败，补齐依赖后重新激活才成功。生产清单只保留实际运行依赖及四个匹配的 peers，不包含源码开发依赖。

## 在 Harness 中安装

构建脚本会输出类似下面的参数。请让当前 Harness 的代理使用 `plugin_manager` 调用它，`target` 必须是你实际生成的绝对路径：

```json
{
  "action": "install_bundle",
  "target": "C:\\Tools\\SuperAgent\\bundle-v1"
}
```

不要手动编辑 Profile 的包清单或 Cordis patch，也不要在 Profile 目录运行 pnpm。以安装器返回的 `application`、`warnings` 和 `nextStep` 判断结果。`applied` 才表示已应用；遇到 `failed` 先处理诊断，遇到重启要求则按提示重启。

安装后，从左侧栏选择 **Superagent（锤子图标）**。入口尚未出现时刷新当前窗口。未配置 GitHub 仓库时显示等待配置是正常状态；飞书来源默认禁用。

本地安装通过链接引用生成目录，请保留目录及其依赖。卸载、停用和升级使用 Harness 插件管理器；升级前备份状态目录，并保持 `stateDir` 指向原有数据位置。不要把生成目录或状态目录提交到 Git。

## 检查与故障定位

```powershell
pnpm check:windows
```

这是 **选定的 Windows 相关检查**，不是把上游全部 Unix 集成测试宣称为 Windows 已通过。它包括核心引擎、策略、数据库、HTTP、Effects、客户端、bundle patch、路径校验、主会话工具限制和打包器检查。实际生产依赖的导入检查由完整构建脚本在生成包安装依赖后执行。

验证安装时可以检查：

- Host `Config.listConfigs` 中的 `dsh-superagent` 条目。
- Client `Slots.listSubTree` 中 `sidebar.panellist` 与 `main` 的 `dsh-superagent` 注册。
- 当前 Harness 地址的 `/orchestrator/api/state`，按接口要求带 `x-orchestrator-request: 1` 请求头，并遵守现有登录认证。

原始本地安装的独立浏览器没有 Desktop 登录态，因此只验证了运行时注册和管理接口，没有宣称通过页面点击或图标截图验收。

## 已知限制：配置真实仓库前必须处理

- 账号探测的 executable 查找尚未完整处理 Windows `PATHEXT`；`gh` 不会自动等同于 `gh.exe`，`.cmd` / `.ps1` 也不能简单当作原生可执行文件直接 spawn。
- GitHub/飞书账号探测仍调用 Unix `env`。
- Worker shim 仍是无扩展名的 `#!/bin/sh` 文件，用冒号拆分/拼接 PATH；准备命令仍使用 `sh -c`。仅安装 Git Bash 不能证明整个流程兼容。
- 上游 `scripts/dsh-superagent` 服务脚本依赖 `fcntl`、Unix `ps`、tmux 和 umask，不是原生 Windows 服务入口。
- `Start-Sleep` / `sleep` 检查是启发式正则，可能误判带分号的字符串，也可能漏掉别名、括号、子表达式或引号调用；它不是完整 PowerShell 解析器或安全边界。前台超时策略仍单独生效。
- Unix mode/chmod 不能证明 Windows NTFS ACL 的私有性。对应 Unix 权限位测试在 Windows 跳过，没有由此声称 Windows 目录已做仅所有者访问控制。
- 成功配置业务后，上游会修改进程级 PATH/git 环境，Worker 使用 `danger-full-access`。不同工作目录不是权限沙箱。请保留上游的专用 Profile/OS 账号部署原则，见 [部署文档](docs/006-deployment.md)。

后续业务接入需指定 GitHub `owner/repository`、自动化账号和允许触发任务的用户，并继续适配上述执行链。飞书接入是可选步骤。本版本没有为任何读者配置外部账号、发送消息或自动创建 PR。

## 开源内容与许可证

仓库包含上游完整源码及本次适配代码、安装资源、文档和检查配置。仓库不包含本机 SQLite/锁、ACL 恢复资料、浏览器状态、个人路径、`node_modules` 或预生成的机器专用 bundle。

原始代码版权归 DeepSeek Harness Team；Windows 适配由该社区 fork 维护，新增图标和打包资源同样采用仓库的 MIT 许可证。完整许可证随生成包保留。
