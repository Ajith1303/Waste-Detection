$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
if (-not $root) { $root = "C:\Users\ASUS\OneDrive\Desktop\ibm" }

Write-Host ""
Write-Host "=== Smart Waste Dumping Detection - Starting All Services ===" -ForegroundColor Cyan
Write-Host "  Project root: $root"
Write-Host ""

# 1. Python detector (port 8001)
$pyReady = $false
try { Invoke-RestMethod "http://127.0.0.1:8001/health" -TimeoutSec 2 | Out-Null; $pyReady = $true } catch {}
if ($pyReady) {
  Write-Host "[1/3] Python detector already running" -ForegroundColor Green
} else {
  Write-Host "[1/3] Starting Python detector (YOLO-World)..." -ForegroundColor Yellow
  Start-Process python -ArgumentList "detector.py" `
    -WorkingDirectory "$root\backend\python_detector" `
    -WindowStyle Hidden `
    -RedirectStandardOutput "$root\backend\python_detector\detector.run.out.log" `
    -RedirectStandardError  "$root\backend\python_detector\detector.run.err.log" | Out-Null
}

# 2. Node backend (port 5000)
$nodeReady = $false
try { Invoke-RestMethod "http://localhost:5000/api/health" -TimeoutSec 2 | Out-Null; $nodeReady = $true } catch {}
if ($nodeReady) {
  Write-Host "[2/3] Node backend already running" -ForegroundColor Green
} else {
  Write-Host "[2/3] Starting Node backend..." -ForegroundColor Yellow
  Start-Process node -ArgumentList "server.js" `
    -WorkingDirectory "$root\backend" `
    -WindowStyle Hidden `
    -RedirectStandardOutput "$root\backend\server.run.out.log" `
    -RedirectStandardError  "$root\backend\server.run.err.log" | Out-Null
}

# 3. Cloudflare tunnel
$cfdExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cfdExe)) { $cfdExe = "$root\tools\cloudflared.exe" }
$cfdRunning = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($cfdRunning) {
  Write-Host "[3/3] Cloudflare tunnel already running" -ForegroundColor Green
} else {
  Write-Host "[3/3] Starting Cloudflare tunnel..." -ForegroundColor Yellow
  Start-Process $cfdExe -ArgumentList "tunnel","--url","http://localhost:5000","--no-autoupdate" `
    -WindowStyle Hidden `
    -RedirectStandardOutput "$root\backend\tunnel.run.out.log" `
    -RedirectStandardError  "$root\backend\tunnel.run.err.log" | Out-Null
}

# 4. Wait for services to become healthy
Write-Host ""
Write-Host "  Waiting for services to warm up..." -ForegroundColor Cyan
$maxAttempts = 40
for ($i = 1; $i -le $maxAttempts; $i++) {
  if (-not $pyReady)  { try { Invoke-RestMethod "http://127.0.0.1:8001/health" -TimeoutSec 2 | Out-Null; $pyReady  = $true } catch {} }
  if (-not $nodeReady) { try { Invoke-RestMethod "http://localhost:5000/api/health" -TimeoutSec 2 | Out-Null; $nodeReady = $true } catch {} }
  if ($pyReady -and $nodeReady) { break }
  Start-Sleep -Milliseconds 1500
  Write-Host "." -NoNewline -ForegroundColor Gray
}
Write-Host ""

$pyStatus  = if ($pyReady)  { "OK - YOLO-World detector on :8001" } else { "FAILED - check detector.run.err.log" }
$nodeStatus = if ($nodeReady) { "OK - Express + React on :5000" }    else { "FAILED - check server.run.err.log" }
Write-Host ""
Write-Host "  Python  : $pyStatus"  -ForegroundColor $(if ($pyReady)  { "Green" } else { "Red" })
Write-Host "  Backend : $nodeStatus" -ForegroundColor $(if ($nodeReady) { "Green" } else { "Red" })

# 5. Extract tunnel URL
Start-Sleep -Seconds 6
$tunnelLog = ""
foreach ($tl in @("$root\backend\tunnel.run.err.log", "$root\backend\tunnel_run.err.log")) {
  if (Test-Path $tl) { $tunnelLog += Get-Content $tl -ErrorAction SilentlyContinue | Out-String }
}
$tunnelMatch = [regex]::Match($tunnelLog, "https://[a-z0-9-]+\.trycloudflare\.com")
$tunnelUrl = if ($tunnelMatch.Success) { $tunnelMatch.Value } else { "(not found yet - check tunnel.run.err.log)" }

# 6. Print summary
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ALL SERVICES STARTED" -ForegroundColor Green
Write-Host "----------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  PC  Live View  : http://localhost:5000/live" -ForegroundColor White
Write-Host "  Phone URL     : $tunnelUrl" -ForegroundColor White
Write-Host "----------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  Phone A: open URL, select Main Gate Dustbin, click Start" -ForegroundColor Gray
Write-Host "  Phone B: open URL, select Park Side Dustbin, click Start" -ForegroundColor Gray
Write-Host "  PC: open http://localhost:5000/live to watch both feeds" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""