param([Parameter(Mandatory)][string]$Node,[Parameter(Mandatory)][string]$JobParent)
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = $JobParent
& $Node (Join-Path $PSScriptRoot 'runtime-smoke.mjs')
exit $LASTEXITCODE
