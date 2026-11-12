param([int]$Port = 6060)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:PORT = [string]$Port
& npm.cmd run manager
