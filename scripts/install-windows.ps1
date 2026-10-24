# Download the latest VSCode Portal extension from GitHub Releases and install it into VS Code on Windows. In PowerShell:
#   irm https://raw.githubusercontent.com/nabeelmumtaz92/vscode-portal/main/scripts/install-windows.ps1 | iex
# Re-run to update. On Windows you get Prompt (Claude Code), Files/Editor, Changes and Terminal;
# Screen, Mac mode and Always on need a Mac.
$ErrorActionPreference = 'Stop'

$Code = (Get-Command code -ErrorAction SilentlyContinue).Source
if (-not $Code) {
  $Code = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Code) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'VS Code is required: install it from https://code.visualstudio.com, then re-run.' }
  Write-Host 'Installing VS Code...'
  winget install --id Microsoft.VisualStudioCode -e --accept-source-agreements --accept-package-agreements | Out-Host
  $Code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
  if (-not (Test-Path $Code)) { throw 'VS Code was installed but its command line tool was not found: open a new PowerShell window and re-run.' }
}

$Release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'vscode-portal-installer' } https://api.github.com/repos/nabeelmumtaz92/vscode-portal/releases/latest
$Asset = $Release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $Asset) { throw "Release $($Release.tag_name) has no .vsix attached (on the Mac run scripts/release-vsix.sh)." }
$Vsix = Join-Path $env:TEMP $Asset.name
Write-Host "Downloading VSCode Portal $($Release.tag_name)..."
Invoke-WebRequest -UseBasicParsing $Asset.browser_download_url -OutFile $Vsix

& $Code --install-extension $Vsix --force
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and
    -not (Get-ChildItem "$HOME\.vscode\extensions\anthropic.claude-code-*" -ErrorAction SilentlyContinue)) {
  & $Code --install-extension anthropic.claude-code
  Write-Host 'Installed the Claude Code extension too: open it in VS Code once and sign in.'
}
Remove-Item $Vsix -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Installed. In VS Code run 'Developer: Reload Window', then click 'Portal' in the status bar."
