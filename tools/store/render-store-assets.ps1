# Renderiza las piezas de la Chrome Web Store desde los HTML de make-store-assets.mjs.
# Capturas y promos: PNG de 24 bits SIN canal alfa (lo exige la tienda). Ícono: PNG con transparencia.
# Uso: powershell -ExecutionPolicy Bypass -File render-store-assets.ps1 <carpeta-html> <carpeta-salida>
param([Parameter(Mandatory)] [string]$HtmlDir, [Parameter(Mandatory)] [string]$OutDir)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$browser = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
New-Item -ItemType Directory -Force $OutDir | Out-Null

$items = [ordered]@{
  "1-home" = "1280x800"; "2-conflict" = "1280x800"; "3-record" = "1280x800"; "4-soql" = "1280x800"; "5-ide" = "1280x800";
  "promo-small" = "440x280"; "promo-marquee" = "1400x560"; "icon-store" = "128x128"
}
$tmp = Join-Path $env:TEMP ("orggadget-store-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
foreach ($name in $items.Keys) {
  $w, $h = $items[$name] -split "x"
  $html = "file:///" + (Join-Path $HtmlDir "$name.html").Replace("\", "/")
  $shot = Join-Path $tmp "$name.png"
  $bg = if ($name -eq "icon-store") { "--default-background-color=00000000" } else { "" }
  cmd /c "`"$browser`" --headless=new --disable-gpu --hide-scrollbars --no-first-run --allow-file-access-from-files --user-data-dir=`"$tmp\p`" $bg --window-size=$w,$h --virtual-time-budget=2000 --screenshot=`"$shot`" `"$html`" >nul 2>nul"
  $dest = Join-Path $OutDir "$name.png"
  if ($name -eq "icon-store") {
    Copy-Item $shot $dest -Force
  } else {
    # Re-guardar como PNG de 24 bits (sin alfa)
    $src = [System.Drawing.Image]::FromFile($shot)
    $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
    $g.Dispose(); $src.Dispose()
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  $img = [System.Drawing.Image]::FromFile($dest)
  "{0,-16} {1}x{2}  {3}" -f "$name.png", $img.Width, $img.Height, $img.PixelFormat
  $img.Dispose()
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
