# Installs or updates CLI Assistant in Raycast for Windows.
#
#   From a clone (builds from source; needs Node.js):
#     powershell -ExecutionPolicy Bypass -File .\install.ps1
#   Without a clone (downloads the latest release; no Node.js needed):
#     irm https://raw.githubusercontent.com/umitaltintas/raycast-cli-assistant/main/install.ps1 | iex
#
# The extension goes into Raycast's extensions folder and is registered as a
# development extension, the way `ray develop` does it, but without a watcher
# left running. Running it again updates it; chats and settings are kept.
# Works in Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is slow with it on 5.1

$Repo = 'umitaltintas/raycast-cli-assistant'
$Name = 'claude-cli' # "name" in package.json; the Raycast extension id
$Dest = Join-Path $HOME ".config\raycast\extensions\$Name"
# Release installs report this folder to Raycast as the source folder (cwd).
$HomeDir = Join-Path $env:LOCALAPPDATA 'raycast-cli-assistant'
# CLI_ASSISTANT_ASSET_URL is for testing only.
$AssetUrl = $env:CLI_ASSISTANT_ASSET_URL

function Bold($s) { Write-Host $s -ForegroundColor White }
function Ok($s) { Write-Host "  + $s" -ForegroundColor Green }
function Warn($s) { Write-Host "  ! $s" -ForegroundColor Yellow }
function Die($s) { Write-Host "  x $s" -ForegroundColor Red; throw $s }

Bold 'Installing CLI Assistant'

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Die 'This script is for Windows; on macOS use install.sh.' }

if (Get-AppxPackage -Name 'Raycast.Raycast' -ErrorAction SilentlyContinue) {
  Ok 'Raycast found'
} elseif (Test-Path 'Registry::HKEY_CLASSES_ROOT\raycast') {
  Ok 'Raycast found'
} else {
  Die 'Raycast not found: https://raycast.com/windows'
}

# Either CLI is enough; a missing one doesn't stop the install, the extension
# explains what to do on first use. Same lookup as the extension: known
# folders first, then PATH; only .exe (npm's .cmd shims don't count).
function Find-Exe($candidates, $name) {
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command "$name.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

$claude = Find-Exe @((Join-Path $HOME '.local\bin\claude.exe')) 'claude'
if (-not $claude) {
  Warn 'Claude Code not found (optional). Install, in PowerShell: irm https://claude.ai/install.ps1 | iex'
} else {
  & $claude auth status *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'Claude Code installed and signed in' }
  else { Warn 'Claude Code is installed but not signed in. In a terminal: claude, then /login' }
}

$npmOpenAI = Join-Path $env:APPDATA 'npm\node_modules\@openai'
$codexExe = $null
if (Test-Path $npmOpenAI) {
  $codexExe = Get-ChildItem $npmOpenAI -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
$codex = Find-Exe @((Join-Path $HOME '.local\bin\codex.exe'), $codexExe) 'codex'
if (-not $codex) {
  Warn 'Codex not found (optional). Install: npm i -g @openai/codex'
} else {
  & $codex login status *> $null
  if ($LASTEXITCODE -eq 0) { Ok "Codex installed and signed in ($codex)" }
  else { Warn "Codex is installed but not signed in. In a terminal: & '$codex' login" }
}

if (-not ($claude -or $codex)) { Warn 'Install at least one of Claude Code or Codex to use the extension.' }

# Claude Code's Bash tool (Tools option) runs in Git Bash; PowerShell works without it.
$gitBash = $env:CLAUDE_CODE_GIT_BASH_PATH
if (-not $gitBash) {
  $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($git) { $gitBash = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe' }
}
if ($gitBash -and (Test-Path $gitBash)) { Ok "Git Bash found ($gitBash)" }
else { Warn "Git Bash not found (optional): Claude Code's Bash tool needs Git for Windows; its PowerShell tool works without it." }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cli-assistant-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $pkg = Join-Path $tmp 'pkg'
  $src = $PSScriptRoot
  $fromSource = $src -and (Test-Path (Join-Path $src 'src')) -and (Test-Path (Join-Path $src 'package.json')) -and -not $AssetUrl

  if ($fromSource) {
    # Build the checkout this script lives in.
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Die 'Node.js (npm) is needed to build from source: https://nodejs.org' }
    Push-Location $src
    try {
      if (-not (Test-Path 'node_modules\.bin\ray.cmd')) {
        Write-Host '  Installing dependencies (npm ci)...'
        & npm.cmd ci --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { Die 'npm ci failed.' }
      }
      & 'node_modules\.bin\ray.cmd' build -e dist -o $pkg -I | Out-Null
      if ($LASTEXITCODE -ne 0) { Die "Build failed; run: npx ray build -e dist -o `"$pkg`"" }
    } finally { Pop-Location }
    $version = 'source'
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
      $described = & git.exe -C $src describe --tags --always --dirty 2>$null
      if ($LASTEXITCODE -eq 0 -and $described) { $version = "$described (source)" }
    }
    $cwd = $src
    Ok "Built $version"
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $AssetUrl) {
      # releases/latest/download can lag behind a new release for a few
      # minutes; ask the API for the tag first (as install.sh does).
      $AssetUrl = "https://github.com/$Repo/releases/latest/download/cli-assistant.tar.gz"
      try {
        $tag = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
        if ($tag) { $AssetUrl = "https://github.com/$Repo/releases/download/$tag/cli-assistant.tar.gz" }
      } catch {}
    }
    $tgz = Join-Path $tmp 'pkg.tar.gz'
    try { Invoke-WebRequest $AssetUrl -OutFile $tgz -UseBasicParsing } catch { Die "Download failed: $AssetUrl" }
    New-Item -ItemType Directory -Path $pkg | Out-Null
    # Windows' own bsdtar; a Git or MSYS tar on PATH can't take C:\ paths.
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $tgz -C $pkg
    if ($LASTEXITCODE -ne 0) { Die 'Could not unpack the downloaded package.' }
    $version = '?'
    if (Test-Path (Join-Path $pkg 'VERSION')) { $version = (Get-Content (Join-Path $pkg 'VERSION') -Raw).Trim() }
    New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
    Copy-Item (Join-Path $pkg 'package.json') (Join-Path $HomeDir 'package.json') -Force
    Set-Content (Join-Path $HomeDir 'VERSION') $version
    $cwd = $HomeDir
    Ok "Downloaded $version"
  }

  $manifest = Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json
  if ($manifest.name -ne $Name) { Die 'The package is not the expected extension.' }
  if (-not ($manifest.platforms -contains 'Windows')) { Die 'This version of the extension does not support Windows.' }

  # A `ray develop` left running would overwrite the install on its next
  # rebuild; stop it, as `ray develop` itself does on start.
  $pidFile = Join-Path $Dest 'cli.pid'
  if (Test-Path $pidFile) {
    $devPid = (Get-Content $pidFile -Raw).Trim()
    $dev = Get-Process -Id $devPid -ErrorAction SilentlyContinue
    if ($dev -and $dev.ProcessName -eq 'node') {
      & taskkill.exe /PID $devPid /T /F *> $null
      Ok "Stopped the running 'ray develop' (PID $devPid)"
    }
  }

  New-Item -ItemType Directory -Path (Split-Path $Dest) -Force | Out-Null
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  Copy-Item $pkg $Dest -Recurse
  Set-Content (Join-Path $Dest 'VERSION') $version
  Ok "Files installed ($Dest)"

  # The link `ray develop` opens after a build: registers or reloads the
  # extension as a development extension.
  Start-Process ("raycast://cli/$Name/build-success?cwd=" + [uri]::EscapeDataString($cwd) + '&info=')
  Ok 'Registered with Raycast'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Bold 'Done. Search for "CLI Assistant" commands in Raycast.'
Write-Host @'
  Next steps:
  - Set your Primary Language: Raycast Settings > Extensions > CLI Assistant
  - Make Ask AI a fallback command, and give hotkeys to Translate and Replace
    or Fix Spelling and Grammar
  - To update, run this script again
  - To uninstall, press Ctrl+K on any of its commands in Raycast > Uninstall Extension
'@
