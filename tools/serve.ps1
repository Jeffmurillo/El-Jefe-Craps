# Minimal static file server: http://localhost:8777/
param([int]$Port=8777)
$root = Split-Path -Parent $PSScriptRoot
$l = New-Object System.Net.HttpListener; $l.Prefixes.Add("http://localhost:$Port/"); $l.Start()
Write-Host "Craps running at http://localhost:$Port/  (Ctrl+C to stop)"
$types=@{".html"="text/html";".js"="text/javascript";".mjs"="text/javascript";".css"="text/css";".json"="application/json";".png"="image/png";".jpg"="image/jpeg";".svg"="image/svg+xml";".wav"="audio/wav";".mp3"="audio/mpeg";".hdr"="application/octet-stream";".glb"="model/gltf-binary";".woff2"="font/woff2"}
while ($l.IsListening) { $c=$l.GetContext(); try { $p=[Uri]::UnescapeDataString($c.Request.Url.AbsolutePath.TrimStart('/')); if(!$p){$p="index.html"}
  $f=Join-Path $root $p; if((Test-Path $f -PathType Leaf) -and ([IO.Path]::GetFullPath($f).StartsWith($root))){ $b=[IO.File]::ReadAllBytes($f); $e=[IO.Path]::GetExtension($f).ToLower(); $c.Response.ContentType= $(if($types[$e]){$types[$e]}else{"application/octet-stream"}); $c.Response.Headers.Add("Cache-Control","no-cache"); $c.Response.OutputStream.Write($b,0,$b.Length)} else {$c.Response.StatusCode=404}
 } catch {} finally { $c.Response.Close() } }
