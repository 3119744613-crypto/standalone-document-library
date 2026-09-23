$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Please install Node.js 24 or newer and reopen PowerShell.'
}
& node -e 'process.exit(parseInt(process.versions.node)<24?1:0)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or newer is required.' }
& node server.mjs
exit $LASTEXITCODE
