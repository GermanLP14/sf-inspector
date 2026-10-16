# Renderiza los PNG del ícono (16/32/48/128) desde los SVG, con fondo transparente,
# usando Edge o Chrome en modo headless. Uso (desde la raíz del repo):
#   node tools/icon/make-icon.mjs tools/icon
#   powershell -ExecutionPolicy Bypass -File tools/icon/render-icons.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$browser = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw "No se encontró Edge ni Chrome" }

# Tamaño → SVG (los tamaños chicos usan versiones simplificadas para que se lean bien)
$sizes = @{ 16 = "icon-tiny.svg"; 32 = "icon-small.svg"; 48 = "icon.svg"; 128 = "icon.svg" }
$tmp = Join-Path $env:TEMP ("orggadget-icons-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
foreach ($size in $sizes.Keys) {
  $svg = Get-Content (Join-Path $PSScriptRoot $sizes[$size]) -Raw
  $html = Join-Path $tmp "icon$size.html"
  "<!doctype html><html><body style='margin:0;background:transparent'><div style='width:${size}px;height:${size}px'>" +
    ($svg -replace '<svg ', "<svg width='$size' height='$size' ") + "</div></body></html>" | Set-Content -Encoding utf8 $html
  $png = Join-Path $root "icons\icon$size.png"
  $prof = Join-Path $tmp "p$size"
  $url = "file:///" + $html.Replace("\", "/")
  # Vía cmd: Edge escribe en stderr y Windows PowerShell 5.1 lo trataría como error.
  cmd /c "`"$browser`" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir=`"$prof`" --default-background-color=00000000 --window-size=$size,$size --screenshot=`"$png`" `"$url`" >nul 2>nul"
  Start-Sleep -Milliseconds 300
  Write-Host "icon$size.png"
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
