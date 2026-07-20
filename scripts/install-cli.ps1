# harn:assume global-cli-install-is-idempotent ref=per-user-cli-install-script-ps1

# Resolve repo root from the script's own location ($PSScriptRoot\..)
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

# Entrypoint path
$Entry = Join-Path $Root "packages\cli\dist\index.js"

if (-not (Test-Path $Entry)) {
    [Console]::Error.WriteLine("CLI build is missing: run corepack pnpm --filter @codor/cli build first")
    exit 1
}

# Target directory
$BinDir = Join-Path $env:USERPROFILE ".local\bin"
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
}

# Write codor.cmd shim
$ShimPath = Join-Path $BinDir "codor.cmd"
$ShimContent = @"
@echo off
node "$Entry" %*
"@

Set-Content -Path $ShimPath -Value $ShimContent -Force

# If the target dir is not in the user PATH, append it
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$NormalizedBinDir = [System.IO.Path]::GetFullPath($BinDir).TrimEnd('\')
$Found = $false

if ($UserPath) {
    $PathParts = $UserPath -split ';'
    foreach ($Part in $PathParts) {
        if ($Part.Trim() -ne "") {
            # Quoted or %VAR% entries are legal in PATH but invalid for GetFullPath.
            try {
                $NormalizedPart = [System.IO.Path]::GetFullPath($Part.Trim()).TrimEnd('\')
            } catch {
                continue
            }
            if ($NormalizedPart -eq $NormalizedBinDir) {
                $Found = $true
                break
            }
        }
    }
}

if (-not $Found) {
    if ([string]::IsNullOrEmpty($UserPath)) {
        $NewPath = $BinDir
    } else {
        if ($UserPath.EndsWith(';')) {
            $NewPath = $UserPath + $BinDir
        } else {
            $NewPath = $UserPath + ';' + $BinDir
        }
    }
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    Write-Host "Please open a new terminal for the change to take effect."
}

# Print success
Write-Output "installed $ShimPath -> $Entry"

# harn:end global-cli-install-is-idempotent
