# =====================================================================
#  deploy_railway.ps1 — wire Quad-Desk (bot + backend + frontend) to Railway
#
#  Prereqs:
#    - railway CLI installed and logged in   (railway whoami)
#    - a Railway plan that allows provisioning (Free plan blocks new projects)
#    - .env present at repo root with the service variables
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File .\deploy_railway.ps1
# =====================================================================

Set-Location -LiteralPath $PSScriptRoot

function Read-DotEnv([string]$Path) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $i = $t.IndexOf("=")
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim()
        # Strip inline comments (e.g. "0.5   # note") — must do this BEFORE
        # trimming quotes, otherwise the comment leaks into numeric values
        # and crashes the bot on float() parsing.
        $v = ($v -replace '\s+#.*$', '').Trim()
        $v = $v.Trim('"')
        $map[$k] = $v
    }
    return $map
}

function Rw {
    param([string[]]$A)
    & railway @A
    if ($LASTEXITCODE -ne 0) { throw "railway $($A -join ' ') failed (exit $LASTEXITCODE)" }
}

function Rw-IfExists {
    param([string[]]$Keys, [string]$Service)
    foreach ($k in $Keys) {
        if ($envMap.ContainsKey($k) -and $envMap[$k] -ne "") {
            Rw @("variable","set","$k=$($envMap[$k])","--service",$Service,"--skip-deploys")
        }
    }
}

$envMap = Read-DotEnv ".env"

Write-Host "`n[1/8] Checking Railway auth..." -ForegroundColor Cyan
Rw @("whoami")

Write-Host "`n[2/8] Project..." -ForegroundColor Cyan
& railway status *> $null
if ($LASTEXITCODE -ne 0) {
    Rw @("init","--name","quad-desk")
} else {
    Write-Host "  already linked."
}

Write-Host "`n[3/8] Services..." -ForegroundColor Cyan
$existing = @()
try {
    $svcJson = & railway service list --json 2>$null | Out-String
    if ($svcJson.Trim()) { $existing = ($svcJson | ConvertFrom-Json) | ForEach-Object { $_.name } }
} catch { }
foreach ($svc in @("bot","backend","frontend")) {
    if ($existing -contains $svc) { Write-Host "  $svc : exists"; continue }
    $out = & railway add --service $svc 2>&1 | Out-String
    Write-Host "  $svc : created"
}

Write-Host "`n[4/8] Dockerfile selection per service..." -ForegroundColor Cyan
Rw @("variable","set","RAILWAY_DOCKERFILE_PATH=Dockerfile","--service","bot","--skip-deploys")
Rw @("variable","set","RAILWAY_DOCKERFILE_PATH=Dockerfile.backend","--service","backend","--skip-deploys")
Rw @("variable","set","RAILWAY_DOCKERFILE_PATH=Dockerfile.frontend","--service","frontend","--skip-deploys")

Write-Host "`n[5/8] Frontend variables (VITE_* baked at build)..." -ForegroundColor Cyan
Rw-IfExists @(
  "VITE_BACKEND_API_KEY","VITE_FIREBASE_API_KEY","VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID","VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID","VITE_FIREBASE_APP_ID",
  "VITE_FIREBASE_MEASUREMENT_ID","VITE_GROQ_API_KEY"
) "frontend"

Write-Host "`n[6/8] Backend variables..." -ForegroundColor Cyan
# backend/main.py REQUIRES BACKEND_API_KEY at startup. Fall back to the
# frontend's key if no dedicated one exists.
$backendApiKey = if ($envMap.ContainsKey("BACKEND_API_KEY")) { $envMap["BACKEND_API_KEY"] } else { $envMap["VITE_BACKEND_API_KEY"] }
if ($backendApiKey) {
    Rw @("variable","set","BACKEND_API_KEY=$backendApiKey","--service","backend","--skip-deploys")
    Rw @("variable","set","ADMIN_API_KEY=$backendApiKey","--service","backend","--skip-deploys")
}
# Pin the HTTP port so the public domain can target it deterministically
Rw @("variable","set","PORT=8080","--service","backend","--skip-deploys")
Rw-IfExists @(
  "GEMINI_API_KEY","NEWS_API_KEY","WHALE_ALERT_API_KEY",
  "BINANCE_API_KEY","BINANCE_API_SECRET","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID"
) "backend"

Write-Host "`n[7/8] Bot variables..." -ForegroundColor Cyan
Rw-IfExists @(
  "BINANCE_API_KEY","BINANCE_API_SECRET","BINANCE_ED25519_PRIVATE_KEY",
  "TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID",
  "BOT_EXCHANGE","BOT_SYMBOL","BOT_SYMBOLS","BOT_TESTNET",
  "BOT_MAX_RISK_PCT","BOT_MAX_DAILY_LOSS_PCT","BOT_MIN_CONFIDENCE",
  "BOT_ANALYSIS_INTERVAL","BOT_ACCOUNT_SIZE","BOT_LEVERAGE","BOT_ULIS_GATE",
  "BOT_PANIC_DROP_PCT","BOT_PANIC_LOOKBACK","BOT_PANIC_LOCK_SECONDS",
  "BOT_SEND_DAILY_LOG_TO_TELEGRAM","FIREBASE_ADMIN_CREDENTIALS"
) "bot"

Write-Host "`n[8/8] Deploying..." -ForegroundColor Cyan
Rw @("up","--service","bot","--detach","--json")
Rw @("up","--service","backend","--detach","--json")

Write-Host "`n  Generating backend domain..." -ForegroundColor Cyan
$backendJson = & railway domain --service backend --port 8080 --json | Out-String
$backendUrl  = ($backendJson | ConvertFrom-Json).domain
if ($backendUrl) {
    if ($backendUrl -notmatch "^https?://") { $backendUrl = "https://$backendUrl" }
    Rw @("variable","set","VITE_API_URL=$backendUrl","--service","frontend","--skip-deploys")
}

Rw @("up","--service","frontend","--detach","--json")

Write-Host "`n  Generating frontend domain + wiring CORS..." -ForegroundColor Cyan
$frontendJson = & railway domain --service frontend --port 80 --json | Out-String
$frontendUrl  = ($frontendJson | ConvertFrom-Json).domain
if ($frontendUrl) {
    if ($frontendUrl -notmatch "^https?://") { $frontendUrl = "https://$frontendUrl" }
    Rw @("variable","set","FRONTEND_URL=$frontendUrl","--service","backend","--skip-deploys")
}

Write-Host "`nDone. Backend: $backendUrl  Frontend: $frontendUrl" -ForegroundColor Green
Write-Host "Watch logs:  railway logs --service bot" -ForegroundColor DarkGray
