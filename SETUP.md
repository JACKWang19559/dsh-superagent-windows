# SETUP

Instructions for an agent helping its operator install and use `0.1.0-windows.5`. The current entry is **Superagent · 按需启动** (`superagent`) in the Harness session preset picker. It is an on-demand control console; the separate orchestrator and worker Sessions use Harness built-in Agents.

Use the [Windows guide](README.windows.md) as the authoritative installation and startup procedure for this version. The numbered [architecture documents](docs/000-philosophy.md) remain useful background, but their older always-running Unix service and process-global environment instructions do not describe this entry.

## Keep startup explicit

A cold start remains idle. Installing the bundle, selecting the preset, opening a session, or reading status must not start repository work. Do not probe GitHub accounts, synchronize repositories, create a Runtime, or submit a Ticket merely to demonstrate that the preset exists. A remembered repository name is a convenience, not permission to resume work after a restart.

Carry out the operator's actual request and reuse repository names or other choices already given. Ask only for missing information needed by the next action. Installing or inspecting the bundle is separate from an instruction to start a repository. Never ask for a token in chat; the operator manages the existing `gh` login in their own terminal.

## 1. Prepare and install when requested

Read the preparation and installation sections of the [Windows guide](README.windows.md). The host needs a configured Harness model provider, Git, a native GitHub CLI, PowerShell, and the documented Node/pnpm versions. Do not offer Codex or Claude CLI as an executor or install either as a dependency.

Build into a new independent directory such as `.artifacts/windows-bundle-v5`. The [build script](scripts/build-windows.ps1) performs selected checks, creates the package, installs its production dependencies without install scripts, and runs real ESM import checks. It prints the absolute directory for the Harness `plugin_manager` install call.

Keep `stateDir` outside the bundle. Never rebuild or overwrite a directory already linked by an installed bundle. Stop the active repository and back up the state before an upgrade, create a fresh versioned installation directory, and use the plugin manager. Do not manually edit a profile package manifest or patch. Follow the installer's `application`, `warnings`, and `nextStep` results; a prepared directory alone is not an installed bundle.

Use a new session to verify the public preset after installing a changed revision. Existing sessions retain the revision they selected. Desktop `0.2.1-rc.5` caches the linked client bundle: after an upgrade that changes client code, fully quit Harness through the application or tray menu and reopen it. A page refresh is insufficient. A Host-only fix with identical client artifacts (windows.4 → windows.5) needs no client reload when installation reports `application: applied`. The new-session picker hides the internal router and worker modes while keeping them registered for internal use.

## 2. Start the chosen repository

Reuse the operator's chosen `owner/repo`, `/owner/repo`, GitHub repository URL, or `https://github.com/owner/repo/tree/branch` URL. Pass the complete input as `repository`; preserve the entire branch suffix, including slashes and case. Ask for the target only if missing. Start only on the operator's explicit request. Startup discovers the existing native `gh` executable and checks its current login, push access and any selected branch. A missing branch fails instead of falling back to the default. The user does not need a separate token form or a new automation account to use the launcher.

Repository input and startup take place in the Superagent conversation. The sidebar's **New Superagent conversation** button selects the public `superagent` preset without sending a message or starting work; its idle view shows recent history instead of an input form.

Use `superagent_control` with `action: start` and the requested `repository`. **The user must already have selected Full access for that console session.** The tool checks this requirement; do not change the session's permissions on their behalf. The caller's console id is recorded automatically, never supplied as a model argument.

Use `action: history` for the latest 30 startup records, including repository, branch, timestamps, state and known console/orchestrator ids. It is local and read-only, including in a read-only session. Opening an old conversation does not authorize resuming its repository.

Use `action: status` to read local launch status without probing GitHub. Report `idle`, `starting`, `running`, `needs-setup`, `stopping`, or `error` as returned. If setup is incomplete, explain the reported problem and direct the operator to the panel to fix the CLI/account/repository setting and retry the check. Do not call a setup failure a running worker.

Only one repository and branch may be active. Stop the current target before changing the repository or branch, including correcting an invalid branch URL. The control session is not the orchestrator; the panel's Open main Session action uses the real orchestrator id returned by the Host.

## 3. Configure who may request work

Once the management panel is available, the operator configures **Settings › Sources › GitHub**, including its Policy field **GitHub accounts that may originate work**. Do not silently infer or populate the allowlist from the current login. Source observation choices and assessment rules remain in the panel.

New target state includes a default prepare command. When a newly admitted Ticket first needs its workspace, it clones the selected branch (or the repository default when omitted), then creates `agent/<ticket-name>`. Existing custom prepare commands are retained; they should read `DSH_SUPERAGENT_GITHUB_BASE_BRANCH` when selecting the base. Workers receive the same variable for new PRs' `--base`. Customize preparation only when the project requires it.

Requests enter through configured GitHub sources and must pass the Policy. A message to the startup console is not a submitted Ticket. For an explicitly authorized live trial, an allowed GitHub account can mention the agent's signed-in account with a narrow request on an Issue or comment; then inspect its trigger, assessment, Ticket, and worker Session. Do not publish a test comment, create an Issue/PR, or enable Feishu just to complete installation.

## 4. Stop and preserve state

On the operator's stop request, use `superagent_control` with `action: stop`, or direct them to the panel's Stop this repository button. Stop cancels repository polling/listeners and running worker Agents. Wait for the returned stopped/idle status before describing it as complete. Closing the panel does not stop the repository.

Harness/plugin cold restarts always return to idle. Do not add a reminder, scheduled start, service wrapper, or automatic resume as part of this setup.

The independent `history.json` journal retains the latest 30 startup records. Interrupted records have no invented completion time. Earlier launches are not reconstructed from ticket databases. History read/write problems are visible and must not prevent stopping workers; preserve a corrupt journal before repairing it.

Each repository and optional explicit branch has its own `repositories/<hash>` directory under `stateDir`. The hash is the first 32 hexadecimal characters of SHA-256 of the lowercased `owner/repo`, plus NUL and the exact branch when specified. Omitted branches retain the existing repository hash. Settings, checkpoints, Tickets and workspaces stay separate across targets. The launcher record remembers the repository and optional branch without auto-resuming. **The historical root database is preserved without automatic migration or rewriting.** Keeping the old `stateDir` does not import its old database into this layout.

Worker environment settings are applied per command and Session, not to the Harness host's global PATH/git environment. The per-repository directories separate data; execution uses Full access and is not a filesystem sandbox.

## 5. Verify and hand over

For a source change, run the checks appropriate to its scope. The [Windows guide](README.windows.md) documents `pnpm check:windows`; the full build entry also verifies actual generated-package imports after installing its production dependencies. Passing metadata or fixture tests does not verify an installed plugin.

For an installed bundle, verify the bundle/preset activation, then cold-idle behavior in a new session. The local `/orchestrator/control` GET endpoint remains available while idle; use the required `x-orchestrator-request: 1` header and the existing Harness authentication. The full `/orchestrator/api/state` endpoint is available only while a repository Runtime is active and its panel is ready.

Report what was actually verified: build/test results, installer result, current launch phase, and any unverified step. Do not claim browser clicks, icon rendering, or real GitHub execution from source tests alone. If Client Inspect times out or no authenticated browser session is available, record that limitation.

Hand over the existing Harness address, the Superagent preset/sidebar entry, the selected repository and status, how to stop it, and the remaining setup or Policy action. Do not create the legacy hourly reminder or start the [upstream Unix service](scripts/dsh-superagent) for this version.
