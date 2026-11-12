param([string]$ManagerUrl = 'http://PCA:6060', [string]$WorkerId = $env:COMPUTERNAME, [string]$Roles = 'default', [switch]$Offscreen)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:AF_MANAGER_URL = $ManagerUrl
$env:AF_WORKER_ID = $WorkerId
$env:AF_WORKER_ROLES = $Roles
$env:HEADLESS = if ($Offscreen) { 'offscreen' } else { 'false' }
& npm.cmd run worker
