param([Parameter(Mandatory)][string]$Node)
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (!$env:LOCALAPPDATA) { throw 'The non-elevated test user has no LocalAppData directory' }
& $Node (Join-Path $PSScriptRoot 'runtime-smoke.mjs')
exit $LASTEXITCODE
