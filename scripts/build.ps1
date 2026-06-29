#requires -Version 7.6

[CmdletBinding()]
param(
    [ValidateSet("Install", "Build", "Test", "Check", "Package", "ReleaseCheck", "All")]
    [string]$Task = "Check"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Invoke-Bun {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & bun @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "bun $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Assert-Prerequisites {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        throw "Bun is required but was not found in PATH."
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git is required but was not found in PATH."
    }

    if (-not (Test-Path -LiteralPath "package.json")) {
        throw "package.json does not exist. Create the TypeScript project before running the build."
    }
}

function Install-Dependencies {
    if (
        (Test-Path -LiteralPath "bun.lock") -or
        (Test-Path -LiteralPath "bun.lockb")
    ) {
        Invoke-Bun -Arguments @("install", "--frozen-lockfile")
        return
    }

    Invoke-Bun -Arguments @("install")
}

function Invoke-Build {
    Invoke-Bun -Arguments @("run", "build")
}

function Invoke-Test {
    Invoke-Bun -Arguments @("run", "test")
}

function Invoke-Check {
    Invoke-Bun -Arguments @("run", "typecheck")
    Invoke-Bun -Arguments @("run", "lint")
    Invoke-Bun -Arguments @("run", "test")
    Invoke-Bun -Arguments @("run", "build")
}

function Invoke-Package {
    Invoke-Bun -Arguments @("run", "package")
}

function Invoke-ReleaseCheck {
    Invoke-Bun -Arguments @("run", "release:local")
}

Assert-Prerequisites

switch ($Task) {
    "Install" { Install-Dependencies }
    "Build" { Invoke-Build }
    "Test" { Invoke-Test }
    "Check" { Invoke-Check }
    "Package" { Invoke-Package }
    "ReleaseCheck" { Invoke-ReleaseCheck }
    "All" {
        Install-Dependencies
        Invoke-Check
    }
}
