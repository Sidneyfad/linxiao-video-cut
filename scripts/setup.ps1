# Windows setup for the video-use skill's Python deps.
# Run from PowerShell:  .\scripts\setup.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

# Find python
$python = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $python) {
    Write-Error "Python not found. Install from https://www.python.org/downloads/ (check 'Add to PATH')."
    exit 1
}

# Warn on missing ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "ffmpeg not found on PATH. Install with: scoop install ffmpeg  (or download from https://ffmpeg.org/)"
}

$venv = "vendor\video-use\.venv"
if (-not (Test-Path $venv)) {
    Write-Host "[setup] creating Python venv at $venv"
    & $python.Path -m venv $venv
}

Write-Host "[setup] installing video-use Python deps"
$pip = Join-Path $venv "Scripts\pip.exe"
& $pip install --quiet --upgrade pip
& $pip install --quiet -e vendor\video-use

Write-Host "[setup] done. Run: npm start"
