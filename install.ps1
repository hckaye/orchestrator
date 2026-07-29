# PowerShell entry point for Windows.
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir "install.js") @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
