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
# Undo:  tailscale serve --https=<port> off     (the port is in portfolio\.serve-port)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'ferglitch7/claude-usage-widget'
  $branch = 'claude/serene-davinci-syt3d3'
  $dest = Join-Path $HOME 'portfolio'
  $portFile = Join-Path $dest '.serve-port'

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

  # The serve command above already printed the address; repeat it on one line.
  $name = $null
  try { $name = (& tailscale status --json | Out-String | ConvertFrom-Json).Self.DNSName } catch { }
  Write-Host ''
  if ($name) {
    Write-Host "Portfolio listo:  https://$($name.TrimEnd('.')):$port/" -ForegroundColor Green
  } else {
    Write-Host "Portfolio listo en el puerto $port. Direccion: tailscale serve status" -ForegroundColor Green
  }
}
