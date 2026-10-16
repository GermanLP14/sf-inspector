# Empaqueta la extensión en un .zip listo para subir a la Chrome Web Store / Edge Add-ons.
# Uso (desde la carpeta del proyecto):  powershell -ExecutionPolicy Bypass -File .\package.ps1
# Nota: no usa Compress-Archive porque en Windows PowerShell 5.1 guarda las rutas con "\",
# y la Chrome Web Store espera "/".
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$out = Join-Path (Split-Path $root -Parent) "OrgGadget-$version.zip"

# Solo lo que necesita la extensión en tiempo de ejecución.
$include = @("manifest.json", "background.js", "app", "lib", "popup", "styles", "icons")

if (Test-Path $out) { Remove-Item -Force $out }
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $include) {
    $path = Join-Path $root $item
    $files = if (Test-Path $path -PathType Container) { Get-ChildItem $path -Recurse -File } else { Get-Item $path }
    foreach ($file in $files) {
      $entry = $file.FullName.Substring($root.Length + 1).Replace("\", "/")
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  }
} finally {
  $zip.Dispose()
}
Write-Host "Paquete creado: $out (version $version)"
