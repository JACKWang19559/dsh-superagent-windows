# SuperAgent for Windows — installation adaptation

Community fork of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), preserving the upstream source history and MIT license. This repository publishes the Windows Desktop installation work: path validation, PowerShell tool selection, reproducible bundle preparation, display resources and focused checks.

**Experimental: installation and management entry points are verified; the complete native Windows worker execution chain is not supported yet.** Account probes, worker shims and preparation commands still contain Unix assumptions. See the explicit support boundaries before connecting a real repository.

- [Windows 安装与限制（中文）](README.windows.md)
- [Windows changes and verification](CHANGELOG.windows.md)
- [MIT license](LICENSE)

With Node.js 24, pnpm 11.7.0 and Windows PowerShell 5.1 (or PowerShell 7) available, run from this checkout:

```powershell
powershell -NoProfile -File scripts/build-windows.ps1
```

This builds, tests and prepares `.artifacts/windows-bundle` with its runtime dependencies. It prints the `plugin_manager` arguments for installation inside Harness; it does not edit a Harness profile. The generated directory is local to your machine and must not be committed. If you use Harness's bundled Node/pnpm, see the explicit executable parameters in the Windows guide.

## Upstream research prototype

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

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
