# Chamber on your own Windows computer (T-0226). Free and open source (AGPL-3.0-only), Copyright (C) 2026 GhostPort Technologies.
#
#   In PowerShell:  irm https://chamber.ghostporttechnologies.com/self-host.ps1 | iex
#
# What it does: checks for Node.js 22.13 or newer, downloads the source of the version that runs on
# chamber.ghostporttechnologies.com, unpacks it in %LOCALAPPDATA%\Chamber (app = the code, data = your workspaces), writes
# start-chamber.cmd there and starts Chamber for this computer only, at http://localhost:4242, then opens it in your browser.
# It needs no administrator rights, installs nothing else and sends nothing anywhere. Run it again to update: the code is
# replaced, your data and settings stay. Other folder or port: set $env:CHAMBER_DIR or $env:CHAMBER_PORT before running it.

& {                                                                          # one block, so nothing here is left behind in your PowerShell window
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'                                   # the progress bar makes downloads in Windows PowerShell 5 very slow
  $From = 'https://chamber.ghostporttechnologies.com'
  $Dir  = if ($env:CHAMBER_DIR) { $env:CHAMBER_DIR } else { Join-Path $env:LOCALAPPDATA 'Chamber' }
  $Port = if ($env:CHAMBER_PORT) { [int]$env:CHAMBER_PORT } else { 4242 }
  if ($Port -lt 1024 -or $Port -gt 65535) { Write-Host 'Chamber: pick a port from 1024 to 65535.' -ForegroundColor Red; return }

  # 1. Node.js 22.13 or newer (Chamber's database is the SQLite built into Node)
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host 'Chamber needs Node.js 22.13 or newer, and this computer has none.' -ForegroundColor Yellow
    Write-Host 'Install it with:  winget install OpenJS.NodeJS.LTS   (or from https://nodejs.org/en/download)'
    Write-Host 'Then open a NEW PowerShell window and run this again.'
    return
  }
  $v = (& node -p 'process.versions.node').Trim(); $nv = $v.Split('.')
  if ([int]$nv[0] -lt 22 -or ([int]$nv[0] -eq 22 -and [int]$nv[1] -lt 13)) {
    Write-Host "Chamber needs Node.js 22.13 or newer; this computer has $v." -ForegroundColor Yellow
    Write-Host 'Update it with:  winget upgrade OpenJS.NodeJS.LTS   (or from https://nodejs.org/en/download), then run this again.'
    return
  }
  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Write-Host 'Chamber: tar is missing (it comes with Windows 10 version 1803 and later).' -ForegroundColor Red; return }

  # 2. The code: the version that runs at $From (its /source download, the same files as on GitHub)
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('chamber-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading Chamber from $From ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "$From/source" -OutFile (Join-Path $tmp 'chamber.tar.gz') -UseBasicParsing
    tar -xzf (Join-Path $tmp 'chamber.tar.gz') -C $tmp
    if ($LASTEXITCODE -ne 0) { throw 'the download is not a readable archive' }
    if (-not (Test-Path (Join-Path $tmp 'chamber\server.js'))) { throw 'the download does not look like Chamber' }
    $data = Join-Path $Dir 'data'; $app = Join-Path $Dir 'app'; $pidFile = Join-Path $Dir 'chamber.pid'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    if (Test-Path $pidFile) {                                                # a copy started by this script before is stopped first
      $old = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
      if ($old -and $old.ProcessName -eq 'node') { Write-Host "Stopping the running copy ($($old.Id)) ..."; Stop-Process -Id $old.Id -Force; [void]$old.WaitForExit(15000) }
      Remove-Item $pidFile -Force
    }
    if (Test-Path $app) { if (Test-Path "$app.old") { Remove-Item -Recurse -Force "$app.old" }; Rename-Item $app 'app.old' }
    Move-Item (Join-Path $tmp 'chamber') $app
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

  # 3. Settings and a start file: written once, then left alone (edit start-chamber.cmd to change them)
  $cmdFile = Join-Path $Dir 'start-chamber.cmd'
  if (-not (Test-Path $cmdFile)) {
    @(
      '@echo off',
      'rem Start Chamber (self-hosted). Written by self-host.ps1; change the settings below and start it again.',
      'set CHAMBER_ACCOUNTS=1',
      'set CHAMBER_SELF_HOSTED=1',
      'set CHAMBER_HOST=127.0.0.1',
      "set CHAMBER_PORT=$Port",
      "set CHAMBER_PUBLIC_URL=http://localhost:$Port",
      "set `"CHAMBER_DATA=$data\chamber.json`"",
      "set `"CHAMBER_REVIEWS=$data\reviews.json`"",
      "set `"CHAMBER_TICKETS_FILE=$data\tickets.json`"",
      "set `"CHAMBER_TICKETS_CLI=$app\tickets-cli.js`"",
      "cd /d `"$app`"",
      'node --disable-warning=ExperimentalWarning server.js'
    ) | Set-Content -Path $cmdFile -Encoding OEM                                  # what cmd.exe reads
  } else {
    Write-Host "Keeping your settings in $cmdFile."
    $m = Select-String -Path $cmdFile -Pattern '^set CHAMBER_PORT=(\d+)' | Select-Object -Last 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }

  # 4. Start it in the background (a hidden window) and open it in the browser
  $env:CHAMBER_ACCOUNTS = '1'; $env:CHAMBER_SELF_HOSTED = '1'; $env:CHAMBER_HOST = '127.0.0.1'; $env:CHAMBER_PORT = "$Port"
  $env:CHAMBER_PUBLIC_URL = "http://localhost:$Port"; $env:CHAMBER_DATA = Join-Path $data 'chamber.json'; $env:CHAMBER_REVIEWS = Join-Path $data 'reviews.json'
  $env:CHAMBER_TICKETS_FILE = Join-Path $data 'tickets.json'; $env:CHAMBER_TICKETS_CLI = Join-Path $app 'tickets-cli.js'
  $p = Start-Process -FilePath $node.Source -ArgumentList '--disable-warning=ExperimentalWarning', 'server.js' -WorkingDirectory $app -WindowStyle Hidden -PassThru
  $p.Id | Set-Content $pidFile
  $ok = $false
  for ($i = 0; $i -lt 50 -and -not $ok; $i++) {
    Start-Sleep -Milliseconds 200
    try { $ok = ((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).ok -eq $true) } catch { }
  }
  if (-not $ok) { Write-Host "Chamber did not come up. Double-click $cmdFile to start it in a window and see why." -ForegroundColor Red; return }
  Write-Host ''
  Write-Host "Chamber is running. Opening http://localhost:$Port : create your account there; the first account owns the workspace." -ForegroundColor Green
  Write-Host "  Your data:  $data"
  Write-Host "  Stop it:    Stop-Process -Id (Get-Content '$pidFile')      Start again: double-click $cmdFile"
  Write-Host '  Update:     run the same command again; your data and settings stay.'
  Write-Host '  It listens on this computer only. To use it from other devices, put it behind HTTPS first: see SELF-HOSTING.md.'
  Start-Process "http://localhost:$Port"
}
