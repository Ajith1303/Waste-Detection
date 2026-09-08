# One-command launcher for the Python Detection Service.
# Usage:  powershell -ExecutionPolicy Bypass -File start.ps1
# Keep this window open while the Node backend runs.  The Node backend must also
# have ROBOFLOW_MODE=python (see ../.env).

Write-Host "Starting Waste Detection Python service..." -ForegroundColor Cyan
python detector.py