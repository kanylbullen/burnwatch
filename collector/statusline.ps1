# burnwatch collector - Claude Code statusLine command (Windows).
#
# Install by adding to %USERPROFILE%\.claude\settings.json:
#   "statusLine": {
#     "type": "command",
#     "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\path\\to\\statusline.ps1"
#   }
#
# Configure with BURNWATCH_URL and BURNWATCH_TOKEN user environment variables,
# or a burnwatch.env file beside this script holding KEY=VALUE lines.
#
# THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 reads a BOM-less file
# as the legacy ANSI code page, so a literal non-ASCII character here comes out
# as mojibake - or worse, ends a string early. Non-ASCII output is built from
# code points at runtime instead.

$ErrorActionPreference = 'SilentlyContinue'

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Environment first, then the optional file beside the script.
$url = $env:BURNWATCH_URL
$token = $env:BURNWATCH_TOKEN
$envFile = Join-Path $here 'burnwatch.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') {
      if ($matches[1] -eq 'BURNWATCH_URL' -and -not $url) { $url = $matches[2] }
      if ($matches[1] -eq 'BURNWATCH_TOKEN' -and -not $token) { $token = $matches[2] }
    }
  }
}
if (-not $url) { $url = 'http://127.0.0.1:8787' }
$url = $url.TrimEnd('/')

$payload = $raw | ConvertFrom-Json

# --- report ----------------------------------------------------------------
#
# curl.exe, called synchronously. It ships with Windows 10+ and costs about
# 10 ms against a daemon on the LAN, which is cheaper than the ~700 ms of
# spawning it detached through Start-Process.
#
# Do NOT reach for System.Net.Http.HttpClient here: Windows PowerShell 5.1 does
# not load that assembly, so `[System.Net.Http.HttpClient]::new()` throws
# "Unable to find type" - and inside a try/catch that failure is invisible,
# leaving a collector that prints a perfect status line and never reports.
#
# The breaker stops a dead daemon from taxing every render with a timeout.

$breaker = Join-Path $env:TEMP 'burnwatch-breaker'
$skip = $false
if (Test-Path $breaker) {
  $age = (Get-Date) - (Get-Item $breaker).LastWriteTime
  if ($age.TotalSeconds -lt 60) { $skip = $true }
}

if (-not $skip) {
  # Written as a file rather than piped: PowerShell 5.1 pipes to native
  # commands using $OutputEncoding, which defaults to ASCII and would mangle
  # any non-ASCII path in the payload.
  $sid = if ($payload.session_id) { $payload.session_id } else { 'default' }
  $tmp = Join-Path $env:TEMP ("burnwatch-" + ($sid -replace '[^a-zA-Z0-9\-]', '') + ".json")
  [IO.File]::WriteAllText($tmp, $raw, (New-Object System.Text.UTF8Encoding $false))

  $args = @(
    '-sS', '-f', '-m', '2', '-X', 'POST', "$url/ingest",
    '-H', 'content-type: application/json',
    '-H', "x-burnwatch-host: $env:COMPUTERNAME",
    '--data-binary', "@$tmp"
  )
  if ($token) { $args += @('-H', "authorization: Bearer $token") }

  & curl.exe @args 2>$null | Out-Null
  # -f turns an HTTP 4xx/5xx into a non-zero exit, so a wrong token trips the
  # breaker too instead of failing silently forever.
  if ($LASTEXITCODE -eq 0) {
    if (Test-Path $breaker) { Remove-Item $breaker -Force }
  } else {
    New-Item -Path $breaker -ItemType File -Force | Out-Null
  }
}

# --- display ---------------------------------------------------------------

function Get-Pct($window) {
  $v = $payload.rate_limits.$window.used_percentage
  if ($null -ne $v) { "$([math]::Floor($v))%" } else { '--' }
}

$parts = @(
  $payload.model.display_name,
  (Split-Path -Leaf $payload.workspace.current_dir),
  "5h $(Get-Pct 'five_hour')",
  "7d $(Get-Pct 'seven_day')"
) | Where-Object { $_ }

# MIDDLE DOT built from its code point, and the stream forced to UTF-8: the
# console here reports code page ibm850, which would otherwise mangle it.
$sep = '  ' + [char]0x00B7 + '  '
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write(($parts -join $sep))
