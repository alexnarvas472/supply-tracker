# Sets up Apps Script sync on this PC (run from My App Register > Set up another PC).
# Downloads the sync helper into %USERPROFILE%\AppsScript\_pc-sync, downloads every
# Apps Script project, adds deploy.cmd to each, and starts the background helper.
$ErrorActionPreference = 'Stop'
$base = 'https://alexnarvas472.github.io/supply-tracker/pc-sync/'
$dir  = Join-Path $HOME 'AppsScript\_pc-sync'

Write-Host "`nSetting up Apps Script sync on $env:COMPUTERNAME ...`n"

$py = @('py','python') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } |
      Where-Object { try { (& $_ --version 2>&1 | Out-String) -match 'Python 3' } catch { $false } } | Select-Object -First 1
if (-not $py) { Write-Host "Python 3 is missing. Install it from https://www.python.org/downloads/ (tick 'Add to PATH'), then run this again."; return }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node.js is missing. Install it from https://nodejs.org/, then run this again."; return }
if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  Write-Host "Installing clasp (Google's Apps Script tool)..."
  npm install -g @google/clasp
}
if (-not (Test-Path (Join-Path $HOME '.clasprc.json'))) {
  Write-Host "`nA browser will open: sign in with your Google account and click Allow."
  clasp login
}

New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($f in 'pc_sync.py','deploy.cjs','sync-now.cmd','install-helper.cmd','uninstall-helper.cmd','get-old-versions.cmd') {
  Invoke-WebRequest ($base + $f) -OutFile (Join-Path $dir $f) -UseBasicParsing
}
Write-Host "Sync helper saved to $dir`n"

Write-Host "Downloading all your Apps Script projects (the first time takes a few minutes)..."
& $py (Join-Path $dir 'pc_sync.py')

$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'AppsScript sync helper.vbs'
"CreateObject(""WScript.Shell"").Run ""pyw """"$dir\pc_sync.py"""" --watch"", 0, False" | Set-Content -Encoding ASCII $vbs
Start-Process wscript $vbs
Write-Host "`nDone. The helper now runs in the background and starts with Windows."
Write-Host "Projects: $(Join-Path $HOME 'AppsScript')   Report: $dir\sync-report.txt"
