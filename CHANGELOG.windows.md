# Windows adaptation changelog

## 0.1.0-windows.4 — 2026-11-03

Repository input and explicit startup move into the public Superagent conversation. The sidebar replaces its idle repository form with recent run history and a **New Superagent conversation** action using Harness's public navigation API. Creating or opening a conversation does not send messages, start work, or change permissions. Current repository management and stop controls remain available.

A bounded local journal retains the latest 30 starts with repository, exact branch, timestamps, lifecycle state, and known console/orchestrator session ids. The caller's console id comes from tool execution context. The history view and the tool's new `history` action share the Host service; reads never scan ticket databases, probe GitHub, or start a Runtime. Cold startup marks unfinished records interrupted and remains idle. History storage errors are reported without blocking worker shutdown or silently replacing corrupt data. Earlier versions' launches are not reconstructed.

Upgrade into a fresh bundle directory and fully quit/reopen Desktop `0.2.1-rc.5` to load the new client and preset revision. Existing conversation revisions remain unchanged; use a new Superagent conversation for the updated guidance and history tool action.

## 0.1.0-windows.3 — 2026-11-03

The new-session mode picker hides the internal router and worker presets while keeping them registered for Harness's own session creation. The public **Superagent · 按需启动** entry and other modes remain available. The UI delegates to the shipped picker through its public Slot, retaining descriptions, keyboard handling and selection behavior.

Repository input now accepts `owner/repo`, `/owner/repo`, GitHub repository URLs and branch URLs such as `https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing`. The complete suffix is the branch, preserving slashes and case. Explicit branches are verified on startup; missing branches do not fall back to the default. Assessment file reads use the selected ref, and the default prepare command clones it before creating `agent/<ticket-name>`. Workers receive `DSH_SUPERAGENT_GITHUB_BASE_BRANCH` for clone and new-PR base selection. Windows clone arguments use array splatting so PowerShell preserves the `--` separator through the worker shim.

State and settings are separate for each repository/explicit branch. Repository names are compared case-insensitively and branches case-sensitively. Unspecified branches retain their existing repository state path, and legacy launcher memory remains readable. The active branch is locked until stop; the last branch is remembered without auto-starting. Existing custom prepare commands remain operator-owned.

Validation includes shared input/schema checks, Launcher and Runtime integration, branch API/error and repository-read checks, preset Slot lifecycle tests, and real local Git cloning through the native Windows worker shim. These checks do not start the user's repository or create GitHub tasks. Desktop `0.2.1-rc.5` requires a full application quit and reopen after changing the linked bundle directory; a page refresh does not clear its cached client bundle path.

## 0.1.0-windows.2 — 2026-11-03

Adds **Superagent · 按需启动** (`superagent`) to the Harness session preset picker. Cold startup is idle; installation, selection, reopening, and status reads do not start repository work. An explicit start with GitHub `owner/name` checks the existing gh account and push access, then activates synchronization and the separate orchestrator/worker Sessions using Harness built-in Agents.

### Included

- Shared Host start/status/stop operations for the console tool and management panel. One repository may be active; stop cancels polling/listeners and running workers. Cold restarts require another explicit start, even when the last repository is remembered.
- Console start requires the user's session already to have Full access. The UI states the worker permission and account impact beside its start button. The plugin never elevates the control session's permissions.
- Separate hashed state directories per repository. The historical root database remains untouched and is not automatically migrated. New repository defaults prepare each new Ticket with `gh repo clone` and an `agent/<ticket-name>` branch; existing executor settings remain intact.
- GitHub Policy allowlists remain operator-configured in the panel. Startup chat does not create a Ticket, and the executor does not use external Codex/Claude CLI.
- Native Windows CLI discovery through PATH/PATHEXT, PowerShell command shims and preparation, and per-command/Session environment injection instead of changing the Harness host's global PATH/git environment.
- Exported `on-demand` plugin entry, English/Chinese display metadata and the existing MIT-licensed icon. Packaging requires the new entry and metadata before creating output; ESM import checks include it.
- Launcher lifecycle/UI and Windows execution checks added to the first `test:windows` group, retaining the prior runtime test filter. Windows setup instructions now describe explicit startup and a fresh versioned installation directory.

### Validation and upgrade boundary

Typecheck and Host/Client builds passed. The Windows entry passed 555 tests, with one Unix permission-bit test skipped and 88 Runtime tests excluded by that entry's explicit filter. A separate run passed all 93 Runtime tests, including real Cordis source mounting before effect replay, on-demand worker startup/shutdown, repository binding, scoped shell execution, and recovery after a shutdown error. Bundle-preparation/import-check fixtures passed all 9 tests. Shared native deployment/follow-up fixtures passed 21 tests. These automated checks do not create a real GitHub task; validate the generated bundle's installed production dependencies separately. The preceding release's installation evidence below applies only to `windows.1`.

The final `0.1.0-windows.2` bundle was installed on Harness Desktop `0.2.1-rc.5` through Plugin Manager, which returned `applied` without activation warnings. Its production dependencies and actual ESM imports passed. Host inspection confirmed `preset-superagent`, and the live control endpoint returned `phase: idle`, `executor: harness`, no repository, and no master Session. Source entry plugins remain active while dormant; only their injected listener children wait for the repository runtime.

Client Inspect timed out, and the independent browser reached the Harness authentication page, so live page clicks, theme rendering and displayed icons are not claimed as verified. Real GitHub-to-Windows-worker end-to-end execution also remains outside this validation. See the [Windows guide](README.windows.md) for compatibility targets and the remaining NTFS/PowerShell/service-script limitations.

Stop the active repository and back up state before upgrading. Build into a new directory such as `bundle-v2`, install through the Harness plugin manager, and keep the linked directory and its dependencies. Do not rebuild over the old linked installation or copy the old root database into a new repository directory.

## 0.1.0-windows.1 — 2026-11-03

First public community release of the Windows Desktop installation work, based on upstream commit `6337fc8` from [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). The upstream source history, MIT license and research-only status are preserved.

### Included

- Windows drive/UNC deployment paths, retaining POSIX paths.
- Main Session tool restrictions resolved from available inherited tools, including a pwsh-only profile.
- Shared foreground timeout policy for bash/pwsh and a heuristic for common direct PowerShell sleep commands.
- Parameterized bundle preparation with preflight checks, refusal to overwrite an existing output, and separation of state from installed code.
- PowerShell build entry, production-dependency installation and real ESM import smoke checks.
- Exported icon and English/Chinese source metadata; license and documentation included in the generated package.
- Focused Windows tests and GitHub Actions, including Unicode/space paths, CRLF patch input, missing build artifacts, output preservation and exclusion of local operational data.

### Validation and support boundary

The preceding local installation was activated on Harness Desktop `0.2.1-rc.5` with Node.js `24.21.0`. Plugin Manager reported `applied` without warnings. The live sidebar/main registrations and the management state endpoint were verified with deployment still waiting for a GitHub repository. The public build scripts reproduce dependency preparation without the original workstation's directory layout.

The public build entry completed locally under Windows PowerShell 5.1: typecheck, build, 499 selected tests, production dependency installation and actual bundle imports passed. One Unix permission-bit test was skipped on Windows; the runtime test command selects three cases and leaves the other 89 outside this focused run. Packaging checks also reject missing local production dependencies/peers instead of accidentally borrowing the checkout's development dependencies.

This release did not claim native Windows end-to-end worker support, full upstream Windows test coverage, authenticated browser visual verification, or configured GitHub/Feishu accounts. Its known gaps included Unix account probes, worker shims and preparation/service scripts; the [Windows guide](README.windows.md) now describes the current on-demand behavior and remaining NTFS/PowerShell/service-script limitations.

Source code is published; machine-specific generated bundles, state databases, credentials, logs and dependency directories are intentionally absent. Build the installation directory locally so its state path matches your machine. `private: true` remains in the package manifest to prevent accidental npm publication; it does not restrict the public GitHub repository.
