# Capture what the Electron app itself renders, without depending on window focus.
$ErrorActionPreference = "Continue"

$exe  = Join-Path (Get-Location) "node_modules\electron\dist\electron.exe"
$out  = Join-Path (Get-Location) "app-shot.png"
Remove-Item $out -ErrorAction SilentlyContinue

$before = @(Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$env:CCD_SHOT = $out
$env:CCD_SHOT_DELAY = "4000"

Write-Output "rendering window to $out ..."
& $exe . 2>&1 | ForEach-Object { if ($_ -match "^\[main\]") { Write-Output $_ } }

Remove-Item Env:\CCD_SHOT -ErrorAction SilentlyContinue
Remove-Item Env:\CCD_SHOT_DELAY -ErrorAction SilentlyContinue

if (Test-Path $out) {
  $kb = [math]::Round((Get-Item $out).Length / 1KB)
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($out)
  Write-Output ("captured   : {0}x{1}, {2} KB" -f $img.Width, $img.Height, $kb)
  $img.Dispose()
  Write-Output "RESULT: PASS"
} else {
  Write-Output "RESULT: FAIL - no image produced"
}

Start-Sleep -Seconds 1
$left = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
foreach ($p in $left) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Write-Output ("remaining  : {0}" -f @(Get-Process electron -ErrorAction SilentlyContinue).Count)
