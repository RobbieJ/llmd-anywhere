# Run on the WINDOWS gaming PC in an elevated PowerShell. One-time setup so
# the vLLM instance inside WSL2 is reachable from the LAN (the Mac's EPP needs
# to scrape its /metrics and Envoy needs to proxy to it).
#
#   .\setup.ps1              # firewall rule + (if not mirrored) portproxy
#   .\setup.ps1 -Port 8002
param([int]$Port = 8002)

$ErrorActionPreference = "Stop"

# 1. Allow inbound traffic to the vLLM port
if (-not (Get-NetFirewallRule -DisplayName "vLLM $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "vLLM $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  Write-Host "firewall: inbound TCP $Port allowed"
} else {
  Write-Host "firewall: rule already present"
}

# 2. Check WSL networking mode. Mirrored mode (Windows 11) makes WSL listeners
#    bind the host's LAN IP directly — nothing else needed. In default NAT
#    mode, forward the port to the WSL VM's virtual IP instead.
$wslconfig = "$env:USERPROFILE\.wslconfig"
$mirrored = (Test-Path $wslconfig) -and ((Get-Content $wslconfig -Raw) -match "networkingMode\s*=\s*mirrored")

if ($mirrored) {
  Write-Host "WSL networking: mirrored — no port forwarding needed"
  Write-Host "note: mirrored mode may also need Hyper-V firewall to allow inbound:"
  Write-Host "  Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow"
} else {
  $wslIp = (wsl hostname -I).Trim().Split(" ")[0]
  if (-not $wslIp) { throw "could not determine WSL IP — is a WSL distro installed and running?" }
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=$wslIp | Out-Null
  Write-Host "portproxy: 0.0.0.0:$Port -> ${wslIp}:$Port  (WSL NAT mode)"
  Write-Host "note: the WSL IP changes across reboots — rerun this script after a reboot,"
  Write-Host "      or switch to mirrored mode in $wslconfig ([wsl2] networkingMode=mirrored)."
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -notmatch "WSL|Loopback|vEthernet" -and $_.IPAddress -notlike "169.254*" } |
  Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "this PC's LAN IP: $lanIp  — on the hub machine, add it to the pool with:"
Write-Host "  ./demo pool add ${lanIp}:$Port `"NVIDIA RTX (WSL2)`""
