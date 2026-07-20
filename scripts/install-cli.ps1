# harn:assume windows-cli-installer-is-idempotent ref=windows-cli-install-script
$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Entry = Join-Path $Root 'packages\cli\dist\index.js'

if (-not (Test-Path -LiteralPath $Entry)) {
    [Console]::Error.WriteLine('CLI build is missing: run pnpm --filter @codor/cli build first')
    exit 1
}

$BinDir = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$ShimPath = Join-Path $BinDir 'codor.cmd'
$EscapedEntry = $Entry.Replace('"', '""')
Set-Content -LiteralPath $ShimPath -Encoding ASCII -Value "@echo off`r`nnode `"$EscapedEntry`" %*`r`n"

$NormalizedBin = [System.IO.Path]::GetFullPath($BinDir).TrimEnd('\')
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$Present = @($UserPath -split ';' | Where-Object { $_.Trim() -ne '' } | Where-Object {
    try { [System.IO.Path]::GetFullPath($_.Trim()).TrimEnd('\') -eq $NormalizedBin } catch { $false }
}).Count -gt 0

if (-not $Present) {
    $NewPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $BinDir } else { $UserPath.TrimEnd(';') + ';' + $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    Write-Output 'Open a new terminal for the PATH change to take effect.'
}

Write-Output "installed $ShimPath -> $Entry"
# harn:end windows-cli-installer-is-idempotent
