# SuperAgent for Windows — on-demand Harness Agents

Community fork of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), preserving the upstream source history and MIT license. **`0.1.0-windows.4` stays idle until explicitly started.** Open a **Superagent · 按需启动** conversation, provide a GitHub repository or branch URL in chat, and explicitly request startup. The sidebar shows recent run history and current management controls, with a button to open a Superagent conversation. Orchestrator and worker sessions use Harness built-in Agents.

The launcher accepts `owner/repo`, `/owner/repo`, repository URLs and branch URLs such as `https://github.com/owner/repo/tree/codex/video-editing`. Explicit branches are checked on startup and used for repository reads and new ticket workspaces. The internal router and worker modes are hidden from the new-session picker. Stop the current target before switching repositories or branches.

Native Windows account discovery, PowerShell worker shims and Git preparation are covered by automated tests, including actual local branch cloning. **This remains an experimental research fork:** real GitHub-to-worker end-to-end execution and full upstream Windows test coverage have not been verified. See the Windows guide for the supported environment and remaining limitations.

- [Windows 安装与限制（中文）](README.windows.md)
- [Windows changes and verification](CHANGELOG.windows.md)
- [MIT license](LICENSE)

With Node.js 24, pnpm 11.7.0 and Windows PowerShell 5.1 (or PowerShell 7) available, run from this checkout:

```powershell
powershell -NoProfile -File scripts/build-windows.ps1 -OutputDirectory '.artifacts/windows-bundle-v4'
```

This builds, tests and prepares a new installation directory with its runtime dependencies. It prints the `plugin_manager` arguments for installation inside Harness; it does not edit a Harness profile. Keep the generated directory local and use a fresh directory for each upgrade. If you use Harness's bundled Node/pnpm, see the explicit executable parameters in the Windows guide.

After upgrading a linked bundle on Desktop `0.2.1-rc.5`, fully quit Harness from its application or tray menu and reopen it. A page refresh does not clear the cached client bundle. Cold startup remains idle.

## Upstream research prototype

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

[SETUP.md](SETUP.md) guides installation, explicit startup, repository and branch selection, Policy configuration, and stopping the service. It reuses choices you have already supplied and asks only for information needed by the next action.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
