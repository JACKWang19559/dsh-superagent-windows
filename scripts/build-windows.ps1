#Requires -Version 5.1
<#
Build and check the Windows installation adaptation, then prepare its local runtime dependencies.
This script never edits a Harness profile. Install the resulting directory through plugin_manager.
#>
[CmdletBinding()]
param(
    [string]$NodePath,
    [string]$PnpmScript,
    [string]$OutputDirectory,
    [string]$StateDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($NodePath) {
    $nodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
} else {
    $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
}
if ($PnpmScript) {
    $pnpmModule = (Resolve-Path -LiteralPath $PnpmScript).Path
} else {
    $pnpmCommand = (Get-Command pnpm -ErrorAction Stop).Source
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.artifacts/windows-bundle' }
if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory = Join-Path $projectRoot $OutputDirectory }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "Refusing to overwrite $OutputDirectory. Use a new -OutputDirectory for a new build."
}

function Invoke-ProjectPnpm {
    param([string]$Directory, [string[]]$Arguments)
    $pnpmArguments = @('--dir', $Directory) + $Arguments
    if ($PnpmScript) {
        & $nodeExecutable $pnpmModule @pnpmArguments
    } else {
        & $pnpmCommand @pnpmArguments
    }
    if ($LASTEXITCODE -ne 0) { throw "pnpm failed with exit code $LASTEXITCODE in $Directory" }
}

$previousPath = $env:PATH
try {
    $env:PATH = (Split-Path -Parent $nodeExecutable) + [System.IO.Path]::PathSeparator + $previousPath
    $nodeVersion = & $nodeExecutable -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Node.js version.' }
    $nodeSemVer = [version]$nodeVersion
    if (-not (($nodeSemVer.Major -eq 22 -and $nodeSemVer.Minor -ge 19) -or $nodeSemVer.Major -ge 24)) {
        throw "Node.js ^22.19.0 or >=24 is required; found $nodeVersion. Node.js 24 is recommended."
    }
    Invoke-ProjectPnpm -Directory $projectRoot -Arguments @('install', '--frozen-lockfile', '--ignore-scripts')
    # Invoke each phase directly so a bundled pnpm.mjs does not require a global pnpm shim on PATH.
    foreach ($phase in @('typecheck', 'test:windows', 'build', 'test:windows-bundle')) {
        Invoke-ProjectPnpm -Directory $projectRoot -Arguments @('run', $phase)
    }
    $prepareArguments = @((Join-Path $PSScriptRoot 'prepare-windows-bundle.mjs'), '--output', $OutputDirectory)
    if ($StateDirectory) { $prepareArguments += @('--state-dir', $StateDirectory) }
    & $nodeExecutable @prepareArguments
    if ($LASTEXITCODE -ne 0) { throw "Bundle preparation failed with exit code $LASTEXITCODE" }
    Invoke-ProjectPnpm -Directory $OutputDirectory -Arguments @('install', '--prod', '--ignore-scripts')
    & $nodeExecutable (Join-Path $PSScriptRoot 'check-bundle-import.mjs') $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw "Bundle import check failed with exit code $LASTEXITCODE" }
    Write-Output 'Bundle ready. In Harness, install it with the following plugin_manager arguments:'
    @{ action = 'install_bundle'; target = $OutputDirectory } | ConvertTo-Json
    Write-Output 'Keep this directory: local installation links it. GitHub account/repository setup is a separate step.'
} finally {
    $env:PATH = $previousPath
}
