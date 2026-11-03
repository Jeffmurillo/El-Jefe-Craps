# Usage: powershell -ExecutionPolicy Bypass -File tools\shot.ps1 -Url "index.html?shot=overview" -Out ".review\shots\x.png" [-W 1600] [-H 900] [-Wait 9000]
# Headless Edge (SwiftShader WebGL) screenshot of a project page over file:// (local ES modules allowed).
# Each call uses its own browser profile, so parallel calls are safe. DOM dumping is NOT available: render results visibly.
param([string]$Url="index.html",[string]$Out=".review\shots\shot.png",[int]$W=1600,[int]$H=900,[int]$Wait=9000)
$root = Split-Path -Parent $PSScriptRoot
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = Join-Path $env:TEMP ("crapsshot_" + [guid]::NewGuid().ToString("N"))
if ($Url -notmatch '^(file|http)') { $Url = "file:///" + ($root.Replace([char]92,[char]47) + "/" + $Url) }
if (-not [IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $root $Out }
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$args2 = @("--headless=new","--user-data-dir=$prof","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--allow-file-access-from-files","--hide-scrollbars","--mute-audio","--force-device-scale-factor=1","--virtual-time-budget=$Wait","--window-size=$($W+24),$($H+93)","--screenshot=$Out",$Url)
# headless=new reports a viewport 24x93 px smaller than --window-size (phantom window chrome), which
# left black bars on the right/bottom. Open the window larger so the page viewport is exactly WxH, then crop.
$p = Start-Process -FilePath $edge -ArgumentList $args2 -Wait -PassThru -NoNewWindow
if (Test-Path $Out) {
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Bitmap]::FromFile($Out)
  if ($src.Width -gt $W -or $src.Height -gt $H) {
    $dst = $src.Clone((New-Object System.Drawing.Rectangle 0, 0, ([Math]::Min($W, $src.Width)), ([Math]::Min($H, $src.Height))), $src.PixelFormat)
    $src.Dispose(); $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
  } else { $src.Dispose() }
  "saved $Out"
} else { "FAILED to capture $Out" }
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
