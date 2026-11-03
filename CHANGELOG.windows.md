# Windows adaptation changelog

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

This release does not claim native Windows end-to-end worker support, full upstream Windows test coverage, authenticated browser visual verification, or configured GitHub/Feishu accounts. Unix account probes, worker shims, preparation/service scripts, NTFS permissions and PowerShell heuristic limitations are documented in the [Windows guide](README.windows.md).

Source code is published; machine-specific generated bundles, state databases, credentials, logs and dependency directories are intentionally absent. Build the installation directory locally so its state path matches your machine. `private: true` remains in the package manifest to prevent accidental npm publication; it does not restrict the public GitHub repository.
