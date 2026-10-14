# Launch the Electron app, prove the in-process server is live, then shut it down.
$ErrorActionPreference = "Continue"
$exe = Join-Path (Get-Location) "node_modules\electron\dist\electron.exe"

if (-not (Test-Path $exe)) { Write-Output "FAIL: electron.exe not found"; exit 1 }
Write-Output ("electron.exe : {0} MB" -f [math]::Round((Get-Item $exe).Length / 1MB, 1))

$before = @(Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

Write-Output "launching..."
$p = Start-Process -FilePath $exe -ArgumentList "." -WorkingDirectory (Get-Location) -PassThru
Start-Sleep -Seconds 12

$alive = -not $p.HasExited
Write-Output ("main pid     : {0}" -f $p.Id)
Write-Output ("still alive  : {0}" -f $alive)
if ($p.HasExited) { Write-Output ("exit code    : {0}" -f $p.ExitCode) }

$procs = @(Get-Process electron -ErrorAction SilentlyContinue)
Write-Output ("electron procs: {0} (was {1})" -f $procs.Count, $before.Count)

# main process window title proves a BrowserWindow opened
$mainProc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if ($mainProc) {
  Write-Output ("window title : '{0}'" -f $mainProc.MainWindowTitle)
}

# is the embedded agent server listening?
$ports = @()
foreach ($proc in $procs) {
  $c = Get-NetTCPConnection -State Listen -OwningProcess $proc.Id -ErrorAction SilentlyContinue
  if ($c) { $ports += ($c | Select-Object -ExpandProperty LocalPort) }
}
$ports = $ports | Sort-Object -Unique
Write-Output ("listening    : {0}" -f $(if ($ports) { ($ports -join ", ") } else { "(none)" }))

$hit = $false
foreach ($port in $ports) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/api/providers" -UseBasicParsing -TimeoutSec 6
    $j = $r.Content | ConvertFrom-Json
    Write-Output ("  port {0} -> HTTP {1}, providers: {2}" -f $port, $r.StatusCode, ($j.providers.id -join ","))
    $ui = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 6
    Write-Output ("  port {0} -> UI {1} KB" -f $port, [math]::Round($ui.RawContentLength / 1KB))
    $hit = $true
  } catch {
    Write-Output ("  port {0} -> {1}" -f $port, $_.Exception.Message)
  }
}

# clean shutdown of every electron process we started
Write-Output "shutting down..."
foreach ($proc in (Get-Process electron -ErrorAction SilentlyContinue)) {
  if ($before -notcontains $proc.Id) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
$left = @(Get-Process electron -ErrorAction SilentlyContinue).Count
Write-Output ("remaining    : {0}" -f $left)

Write-Output ""
if ($alive -and $hit -and $left -eq 0) { Write-Output "RESULT: PASS - desktop app booted, served the UI, and closed cleanly" }
elseif ($alive -and $hit) { Write-Output "RESULT: PASS (some processes lingered)" }
else { Write-Output "RESULT: FAIL" }
