# Publishes the Portfolio app on this computer's tailnet with Tailscale Serve.
#
# Run in PowerShell on the Windows machine that should host it:
#
#   irm https://raw.githubusercontent.com/ferglitch7/claude-usage-widget/claude/serene-davinci-syt3d3/docs/tools/serve-tailscale.ps1 | iex
#
# It downloads the app into %USERPROFILE%\portfolio and serves that folder over
# HTTPS on a port that no other "tailscale serve" entry is using, so existing
# projects are left alone. Running it again updates the files and keeps the
# same address.
#
# If Python is installed it also turns on automatic copies: a small local
# server keeps each device's positions under %USERPROFILE%\portfolio-data and
# starts with Windows (a shortcut in the Startup folder). Without Python the
# app works the same, just without copies.
#
# Run it again to update the app: it downloads and copies the files again, and
# restarts the backup server only when its script changed or it is down.
# Nothing runs on its own: every update is this command, run by you.
#
# Undo:  tailscale serve --https=<port> off     (the port is in portfolio\.serve-port)
#        delete "Portfolio backup.lnk" from the Startup folder (shell:startup)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'ferglitch7/claude-usage-widget'
  $branch = 'claude/serene-davinci-syt3d3'
  $dest = Join-Path $HOME 'portfolio'
  $dataDir = Join-Path $HOME 'portfolio-data'
  $portFile = Join-Path $dest '.serve-port'
  $apiPort = 8765

  if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw 'No encuentro "tailscale" en el PATH. Abre una terminal nueva o instala Tailscale.'
  }

  # 1. Download the branch and copy its docs/ folder (the app) into place.
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('portfolio-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'
  Write-Host 'Descargando la app...'
  Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp
  $docs = Get-ChildItem -Path $tmp -Directory |
    ForEach-Object { Join-Path $_.FullName 'docs' } |
    Where-Object { Test-Path (Join-Path $_ 'index.html') } |
    Select-Object -First 1
  if (-not $docs) { throw 'La descarga no trae docs\index.html.' }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item -Path (Join-Path $docs '*') -Destination $dest -Recurse -Force

  # 2. HTTPS port: the one used last time, otherwise the first one that is free.
  $port = 0
  if (Test-Path $portFile) { $port = [int]((Get-Content $portFile -Raw).Trim()) }
  if (-not $port) {
    $used = @()
    try {
      $cfg = (& tailscale serve status --json | Out-String | ConvertFrom-Json)
      if ($cfg -and $cfg.TCP) { $used = @($cfg.TCP.PSObject.Properties.Name) }
    } catch { }
    $port = @(8443, 10000, 4443) | Where-Object { $used -notcontains "$_" } | Select-Object -First 1
    if (-not $port) { throw 'Los puertos 8443, 10000 y 4443 ya los usa otro "tailscale serve".' }
  }

  # 3. Serve the folder on the tailnet. --bg keeps it running across reboots.
  Write-Host "Publicando en el puerto $port..."
  & tailscale serve --bg "--https=$port" $dest
  if ($LASTEXITCODE -ne 0) { throw "tailscale serve termino con codigo $LASTEXITCODE." }
  Set-Content -Path $portFile -Value $port

  # 4. Automatic copies (optional). Any failure here leaves the app itself working.
  $copies = $false
  try {
    # A real Python 3: "py" (the launcher) or "python". The Store placeholder prints nothing useful.
    $exe = $null; $pre = ''
    $cmd = Get-Command py -ErrorAction SilentlyContinue
    if ($cmd -and ((& py -3 -c "print(7)") -eq '7')) {
      $w = Get-Command pyw -ErrorAction SilentlyContinue
      $exe = if ($w) { $w.Source } else { $cmd.Source }
      $pre = '-3 '
    }
    if (-not $exe) {
      $cmd = Get-Command python -ErrorAction SilentlyContinue
      if ($cmd -and ((& python -c "print(7)") -eq '7')) {
        $w = Join-Path (Split-Path $cmd.Source) 'pythonw.exe'
        $exe = if (Test-Path $w) { $w } else { $cmd.Source }
      }
    }
    if (-not $exe) { throw 'no hay Python 3 instalado' }

    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $script = Join-Path $dataDir 'backup_server.py'
    $newScript = Join-Path $dest 'server\backup_server.py'
    $changed = -not (Test-Path $script) -or ((Get-FileHash $script).Hash -ne (Get-FileHash $newScript).Hash)
    Copy-Item -Path $newScript -Destination $script -Force
    $argLine = "$pre`"$script`" --port $apiPort --dir `"$dataDir`""

    # Start with Windows: a shortcut in the user's Startup folder (no admin needed).
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Portfolio backup.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $exe
    $sc.Arguments = $argLine
    $sc.WorkingDirectory = $dataDir
    $sc.WindowStyle = 7
    $sc.Save()

    $running = $false
    try { $running = (Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/health" -TimeoutSec 2).app -eq 'portfolio-backup' } catch { }
    if ($changed -or -not $running) {
      # Restart so an updated script takes effect (or start it if it is down).
      Get-CimInstance Win32_Process -Filter "Name like 'py%'" |
        Where-Object { $_.CommandLine -like '*backup_server.py*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $dataDir -WindowStyle Hidden
    }

    $up = $false
    foreach ($i in 1..20) {
      Start-Sleep -Milliseconds 300
      try { if ((Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/health" -TimeoutSec 2).app -eq 'portfolio-backup') { $up = $true; break } } catch { }
    }
    if (-not $up) { throw "el servidor de copias no respondio en el puerto $apiPort" }

    & tailscale serve --bg "--https=$port" --set-path=/api "http://127.0.0.1:$apiPort"
    if ($LASTEXITCODE -ne 0) { throw "tailscale serve (api) termino con codigo $LASTEXITCODE" }
    $copies = $true
  } catch {
    Write-Host "Copia automatica no activada: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  # 5. Remove the hourly self-update that earlier versions installed. It ran a
  # script downloaded from GitHub every hour, which would let anyone able to
  # change that branch run code on this machine. Updates are manual now.
  try {
    & schtasks.exe /Query /TN 'Portfolio update' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      & schtasks.exe /Delete /TN 'Portfolio update' /F | Out-Null
      Write-Host 'Tarea "Portfolio update" eliminada.' -ForegroundColor Green
    }
  } catch { }
  $oldVbs = Join-Path $dataDir 'update.vbs'
  if (Test-Path $oldVbs) { Remove-Item -Path $oldVbs -Force -ErrorAction SilentlyContinue }

  # The serve command above already printed the address; repeat it on one line.
  $name = $null
  try { $name = (& tailscale status --json | Out-String | ConvertFrom-Json).Self.DNSName } catch { }
  Write-Host ''
  if ($name) {
    Write-Host "Portfolio listo:  https://$($name.TrimEnd('.')):$port/" -ForegroundColor Green
  } else {
    Write-Host "Portfolio listo en el puerto $port. Direccion: tailscale serve status" -ForegroundColor Green
  }
  if ($copies) { Write-Host "Copia automatica activa. Datos en $dataDir" -ForegroundColor Green }
}
