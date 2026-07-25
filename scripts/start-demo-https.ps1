param(
    [switch]$Stop,
    [switch]$SkipNatPmp,
    [switch]$RawIpOnly,
    [switch]$HostnameOnly,
    [string]$PublicHost = '',
    [string]$PublicIp = '',
    [string]$ArtifactHost = '',
    [int]$PublicPort = 3100,
    [int]$BackendPort = 3100,
    [int]$ChallengePort = 3102,
    [int]$CertificateWaitSeconds = 120,
    [string]$PublicBind = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.demo-https'
$toolsDir = Join-Path $projectRoot '.tools'
$statePath = Join-Path $runtimeDir 'state.json'
$stateTempPath = Join-Path $runtimeDir 'state.json.tmp'
$caddyPath = Join-Path $toolsDir 'caddy.exe'
$caddyConfigPath = Join-Path $runtimeDir 'Caddyfile'
$caddyVersion = '2.11.4'
$natPmpScript = Join-Path $PSScriptRoot 'keep-nat-pmp-mapping.ps1'
$tsxPath = Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Stop-DemoProcess([int]$processId, [string]$commandMarker = '') {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $true
    }

    if ($commandMarker) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        if ($null -eq $processInfo -or !$processInfo.CommandLine) {
            if ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                return $true
            }
            Write-Warning "Could not verify ownership of process $processId."
            return $false
        }
        $commandLine = [string]$processInfo.CommandLine
        if ($commandLine.IndexOf($commandMarker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Warning "Process $processId no longer belongs to this stand; leaving it running."
            return $true
        }
    }

    try {
        Stop-Process -Id $processId -ErrorAction Stop
    } catch {
        if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            Write-Warning "Could not stop process ${processId}: $($_.Exception.Message)"
            return $false
        }
        return $true
    }
    try {
        [void]$process.WaitForExit(5000)
    } catch {
        Write-Warning "Could not wait for process ${processId}: $($_.Exception.Message)"
    }
    if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        Write-Warning "Process $processId did not exit within five seconds."
        return $false
    }
    return $true
}

function Quote-ProcessArgument([string]$value) {
    return '"' + $value + '"'
}

function Save-StandState([hashtable]$state) {
    $json = $state | ConvertTo-Json
    [System.IO.File]::WriteAllText($stateTempPath, $json, $utf8NoBom)
    Move-Item -LiteralPath $stateTempPath -Destination $statePath -Force
}

function Remove-NatPmpMapping([string]$gateway, [int]$internalPort) {
    $removeArgs = @(
        '-ExecutionPolicy', 'Bypass',
        '-File', $natPmpScript,
        '-Gateway', $gateway,
        '-InternalPort', $internalPort,
        '-ExternalPort', 80,
        '-Remove'
    )
    try {
        $removeOutput = & powershell @removeArgs
        $removeExitCode = $LASTEXITCODE
        foreach ($line in $removeOutput) {
            Write-Host $line
        }
        if ($removeExitCode -ne 0) {
            Write-Warning 'Could not remove the previous NAT-PMP mapping.'
            return $false
        }
    } catch {
        Write-Warning "Could not remove the previous NAT-PMP mapping: $($_.Exception.Message)"
        return $false
    }
    return $true
}

function Stop-PreviousStand {
    if (!(Test-Path -LiteralPath $statePath)) {
        return
    }

    try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } catch {
        throw "could not parse $statePath; refusing unsafe PID cleanup"
    }
    $properties = $state.PSObject.Properties.Name
    $cleanupComplete = $true
    if ($properties -contains 'natPmpPid') {
        if (!(Stop-DemoProcess $state.natPmpPid $natPmpScript)) {
            $cleanupComplete = $false
        }
    }
    if ($properties -contains 'gateway' -and $properties -contains 'challengePort') {
        # A router reboot can forget the lease and reject its zero-lifetime removal.
        # Local process cleanup is still complete, and the next mapping request is
        # authoritative, so a best-effort network cleanup must not block restart.
        [void](Remove-NatPmpMapping $state.gateway $state.challengePort)
    }
    if ($properties -contains 'caddyPid') {
        if (!(Stop-DemoProcess $state.caddyPid $caddyConfigPath)) {
            $cleanupComplete = $false
        }
    }
    if ($properties -contains 'backendPid') {
        if (!(Stop-DemoProcess $state.backendPid 'demo/server.ts')) {
            $cleanupComplete = $false
        }
    }
    if ($cleanupComplete) {
        Remove-Item -LiteralPath $statePath -Force
        return
    }

    throw "could not fully stop the previous HTTPS stand; recovery state was retained at $statePath"
}

function Install-Caddy {
    if (Test-Path -LiteralPath $caddyPath) {
        return
    }

    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    $archivePath = Join-Path $toolsDir 'caddy.zip'
    $download = "https://github.com/caddyserver/caddy/releases/download/v$caddyVersion/caddy_${caddyVersion}_windows_amd64.zip"
    Write-Host "Downloading Caddy $caddyVersion..."
    Invoke-WebRequest -Uri $download -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsDir -Force
    Remove-Item -LiteralPath $archivePath -Force
}

function Assert-PortFree([int]$port) {
    $owner = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $owner) {
        throw "port $port is already owned by process $($owner.OwningProcess)"
    }
}

function Find-LanAddress {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
    $address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '169.254.*' } |
        Select-Object -First 1 -ExpandProperty IPAddress
    if (!$address) {
        throw 'could not determine the LAN address used by the default route'
    }
    return $address
}

function Find-Gateway([string]$bindAddress) {
    $interface = Get-NetIPAddress -IPAddress $bindAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $interface) {
        throw "could not find the network interface for $bindAddress"
    }

    $gateway = Get-NetRoute -DestinationPrefix '0.0.0.0/0' |
        Where-Object { $_.InterfaceIndex -eq $interface.InterfaceIndex } |
        Sort-Object RouteMetric |
        Select-Object -First 1 -ExpandProperty NextHop
    if (!$gateway) {
        throw 'could not determine the default gateway'
    }
    return $gateway
}

function Wait-HttpsCertificate(
    [System.Diagnostics.Process]$caddy,
    [string]$hostName,
    [int]$port,
    [string]$bindAddress,
    [int]$timeoutSeconds
) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -eq $curl) {
        throw 'curl.exe is required to verify certificate readiness'
    }

    $url = "https://${hostName}:${port}/"
    $connectTo = "${hostName}:${port}:${bindAddress}:${port}"
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $oldErrorAction = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $curl.Source '--silent' '--fail' '--output' 'NUL' '--connect-timeout' '3' '--max-time' '5' '--noproxy' '*' '--connect-to' $connectTo $url 2>$null
            $curlExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $oldErrorAction
        }
        if ($curlExitCode -eq 0) {
            return
        }
        if ($caddy.HasExited) {
            throw 'Caddy exited while waiting for the certificate'
        }
        Start-Sleep -Seconds 2
    }

    throw "certificate was not ready after $timeoutSeconds seconds; inspect $runtimeDir\caddy.err.log"
}

if ($Stop) {
    Stop-PreviousStand
    Write-Host 'External HTTPS stand stopped.'
    exit 0
}

$publicHostSpecified = $PSBoundParameters.ContainsKey('PublicHost')
$publicIpSpecified = $PSBoundParameters.ContainsKey('PublicIp')
if (!$publicHostSpecified -and !$publicIpSpecified) {
    $PublicIp = '77.40.53.96'
    $PublicHost = '77-40-53-96.sslip.io'
} elseif (!$publicHostSpecified -and
    $PublicIp -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
    $PublicHost = ($Matches[1..4] -join '-') + '.sslip.io'
} elseif (!$publicIpSpecified -and
    $PublicHost -match '^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$') {
    $PublicIp = $Matches[1..4] -join '.'
}

$literalHostIp = $null
if ($PublicHost -and [System.Net.IPAddress]::TryParse($PublicHost, [ref]$literalHostIp)) {
    if (!$publicIpSpecified) {
        $PublicIp = $PublicHost
    }
    $PublicHost = ''
}
if ($RawIpOnly -and $HostnameOnly) {
    throw 'RawIpOnly and HostnameOnly cannot be used together'
}
if ($RawIpOnly) {
    $PublicHost = ''
}
if ($HostnameOnly) {
    $PublicIp = ''
}
$enablePublicHost = [bool]$PublicHost
$enablePublicIp = [bool]$PublicIp
if (!$enablePublicHost -and !$enablePublicIp) {
    throw 'PublicHost and PublicIp cannot both be empty'
}
if ($enablePublicIp) {
    $parsedPublicIp = $null
    if (![System.Net.IPAddress]::TryParse($PublicIp, [ref]$parsedPublicIp) -or
        $parsedPublicIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "PublicIp must be a literal IPv4 address, got: $PublicIp"
    }
}
if (!$ArtifactHost) {
    if ($PublicHost -match '\.sslip\.io$') {
        $ArtifactHost = 'artifact.' + $PublicHost
    } elseif ($PublicIp) {
        $ArtifactHost = 'artifact.' + ($PublicIp -replace '\.', '-') + '.sslip.io'
    } else {
        throw 'ArtifactHost is required when PublicHost is not an sslip.io hostname'
    }
}
if ($ArtifactHost -match '[:/]' -or
    [System.Uri]::CheckHostName($ArtifactHost) -ne [System.UriHostNameType]::Dns) {
    throw "ArtifactHost must be a DNS hostname without a scheme or port, got: $ArtifactHost"
}
if ($ArtifactHost -eq $PublicHost) {
    throw 'ArtifactHost must differ from PublicHost so sandboxed artifacts stay cross-origin'
}
$artifactOrigin = "https://${ArtifactHost}:${PublicPort}"
$appOrigins = @(
    "http://localhost:${BackendPort}"
    "http://127.0.0.1:${BackendPort}"
)
if ($enablePublicHost) {
    $appOrigins += "https://${PublicHost}:${PublicPort}"
}
if ($enablePublicIp) {
    $appOrigins += "https://${PublicIp}:${PublicPort}"
}
$publicUrl = "https://${PublicHost}:${PublicPort}/"
if ($enablePublicIp) {
    $publicUrl = "https://${PublicIp}:${PublicPort}/"
}
if ($ChallengePort -eq $PublicPort -or $ChallengePort -eq $BackendPort) {
    throw 'ChallengePort must differ from PublicPort and BackendPort'
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Stop-PreviousStand
Assert-PortFree $PublicPort
if ($BackendPort -ne $PublicPort) {
    Assert-PortFree $BackendPort
}
Assert-PortFree $ChallengePort
Install-Caddy
if (!$PublicBind) {
    $PublicBind = Find-LanAddress
}
$gateway = ''
if (!$SkipNatPmp) {
    $gateway = Find-Gateway $PublicBind
}

Push-Location $projectRoot
try {
    npm run demo:build
    if ($LASTEXITCODE -ne 0) {
        throw 'demo build failed'
    }
} finally {
    Pop-Location
}

$hostnameConfig = ''
if ($enablePublicHost) {
    $hostnameConfig = @"

https://${PublicHost}:${PublicPort} {
    bind ${PublicBind}
    encode zstd gzip
    tls {
        issuer acme {
            alt_http_port ${ChallengePort}
            disable_tlsalpn_challenge
        }
    }
    reverse_proxy 127.0.0.1:${BackendPort}
}
"@
}

$rawIpConfig = ''
if ($enablePublicIp) {
    $rawIpConfig = @"

https://${PublicIp}:${PublicPort} {
    bind ${PublicBind}
    encode zstd gzip
    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory {
            profile shortlived
            alt_http_port ${ChallengePort}
            disable_tlsalpn_challenge
        }
    }
    reverse_proxy 127.0.0.1:${BackendPort}
}
"@
}

$artifactConfig = @"

https://${ArtifactHost}:${PublicPort} {
    bind ${PublicBind}
    encode zstd gzip
    tls {
        issuer acme {
            alt_http_port ${ChallengePort}
            disable_tlsalpn_challenge
        }
    }
    route {
        @artifact path /artifact-open/*
        reverse_proxy @artifact 127.0.0.1:${BackendPort}
        @artifactHealth path /
        respond @artifactHealth 204
        respond 404
    }
}
"@

$defaultSniConfig = ''
if ($enablePublicIp) {
    $defaultSniConfig = "    default_sni $PublicIp"
}

$caddyConfig = @"
{
    admin off
    auto_https disable_redirects
$defaultSniConfig
}
${hostnameConfig}
${rawIpConfig}
${artifactConfig}
"@
[System.IO.File]::WriteAllText($caddyConfigPath, $caddyConfig, $utf8NoBom)
& $caddyPath fmt '--overwrite' $caddyConfigPath
if ($LASTEXITCODE -ne 0) {
    throw 'could not format the generated Caddyfile'
}

$nodePath = (Get-Command node).Source
$backendOut = Join-Path $runtimeDir 'backend.out.log'
$backendErr = Join-Path $runtimeDir 'backend.err.log'
$caddyOut = Join-Path $runtimeDir 'caddy.out.log'
$caddyErr = Join-Path $runtimeDir 'caddy.err.log'
$natPmpOut = Join-Path $runtimeDir 'nat-pmp.out.log'
$natPmpErr = Join-Path $runtimeDir 'nat-pmp.err.log'

$oldStart = $env:DEMO_PORT_START
$oldEnd = $env:DEMO_PORT_END
$oldHost = $env:DEMO_HOST
$oldArtifactOrigin = $env:DEMO_ARTIFACT_ORIGIN
$oldAppOrigins = $env:DEMO_APP_ORIGINS
$env:DEMO_PORT_START = [string]$BackendPort
$env:DEMO_PORT_END = [string]$BackendPort
$env:DEMO_HOST = '127.0.0.1'
$env:DEMO_ARTIFACT_ORIGIN = $artifactOrigin
$env:DEMO_APP_ORIGINS = ConvertTo-Json -InputObject $appOrigins -Compress
try {
    $backendArgs = @{
        FilePath = $nodePath
        ArgumentList = @((Quote-ProcessArgument $tsxPath), 'demo/server.ts')
        WorkingDirectory = $projectRoot
        RedirectStandardOutput = $backendOut
        RedirectStandardError = $backendErr
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    $backend = Start-Process @backendArgs
} finally {
    $env:DEMO_PORT_START = $oldStart
    $env:DEMO_PORT_END = $oldEnd
    $env:DEMO_HOST = $oldHost
    $env:DEMO_ARTIFACT_ORIGIN = $oldArtifactOrigin
    $env:DEMO_APP_ORIGINS = $oldAppOrigins
}

Start-Sleep -Seconds 1
if ($backend.HasExited) {
    $details = Get-Content -LiteralPath $backendErr -Raw
    throw $details
}

$natPmp = $null
try {
    if (!$SkipNatPmp) {
        $natPmpArgs = @{
            FilePath = (Get-Command powershell).Source
            ArgumentList = @(
                '-ExecutionPolicy', 'Bypass',
                '-File', (Quote-ProcessArgument $natPmpScript),
                '-Gateway', $gateway,
                '-InternalPort', $ChallengePort,
                '-ExternalPort', 80
            )
            WorkingDirectory = $projectRoot
            RedirectStandardOutput = $natPmpOut
            RedirectStandardError = $natPmpErr
            WindowStyle = 'Hidden'
            PassThru = $true
        }
        $natPmp = Start-Process @natPmpArgs
        Start-Sleep -Seconds 1
        if ($natPmp.HasExited) {
            $details = Get-Content -LiteralPath $natPmpErr -Raw
            throw $details
        }
    } else {
        Write-Host "NAT-PMP disabled. Forward external TCP 80 to ${PublicBind}:${ChallengePort} manually."
    }
} catch {
    $startupError = $_
    $cleanupComplete = $true
    if ($null -ne $natPmp) {
        if (!(Stop-DemoProcess $natPmp.Id)) {
            $cleanupComplete = $false
        }
        if (!(Remove-NatPmpMapping $gateway $ChallengePort)) {
            $cleanupComplete = $false
        }
    }
    if (!(Stop-DemoProcess $backend.Id)) {
        $cleanupComplete = $false
    }
    if (!$cleanupComplete) {
        $recoveryState = @{
            challengePort = $ChallengePort
            publicUrl = $publicUrl
            localUrl = "http://localhost:${BackendPort}/"
            artifactUrl = $artifactOrigin + '/'
        }
        if ($enablePublicHost) {
            $recoveryState['publicHostUrl'] = "https://${PublicHost}:${PublicPort}/"
        }
        if ($enablePublicIp) {
            $recoveryState['publicIpUrl'] = "https://${PublicIp}:${PublicPort}/"
        }
        if ($null -ne (Get-Process -Id $backend.Id -ErrorAction SilentlyContinue)) {
            $recoveryState['backendPid'] = $backend.Id
        }
        if ($null -ne $natPmp) {
            $recoveryState['gateway'] = $gateway
            if ($null -ne (Get-Process -Id $natPmp.Id -ErrorAction SilentlyContinue)) {
                $recoveryState['natPmpPid'] = $natPmp.Id
            }
        }
        try {
            Save-StandState $recoveryState
        } catch {
            Write-Warning 'Could not persist recovery state after a NAT-PMP startup failure.'
        }
    }
    throw $startupError
}

$caddyArgs = @{
    FilePath = $caddyPath
    ArgumentList = @('run', '--config', (Quote-ProcessArgument $caddyConfigPath), '--adapter', 'caddyfile')
    WorkingDirectory = $projectRoot
    RedirectStandardOutput = $caddyOut
    RedirectStandardError = $caddyErr
    WindowStyle = 'Hidden'
    PassThru = $true
}
$caddy = $null
try {
    $caddy = Start-Process @caddyArgs

    $state = @{
        backendPid = $backend.Id
        caddyPid = $caddy.Id
        challengePort = $ChallengePort
        publicUrl = $publicUrl
        localUrl = "http://localhost:${BackendPort}/"
        artifactUrl = $artifactOrigin + '/'
    }
    if ($enablePublicHost) {
        $state['publicHostUrl'] = "https://${PublicHost}:${PublicPort}/"
    }
    if ($enablePublicIp) {
        $state['publicIpUrl'] = "https://${PublicIp}:${PublicPort}/"
    }
    if ($null -ne $natPmp) {
        $state['natPmpPid'] = $natPmp.Id
        $state['gateway'] = $gateway
    }
    Save-StandState $state
} catch {
    $startupError = $_
    $cleanupComplete = $true
    if ($null -ne $caddy) {
        if (!(Stop-DemoProcess $caddy.Id)) {
            $cleanupComplete = $false
        }
    }
    if ($null -ne $natPmp) {
        if (!(Stop-DemoProcess $natPmp.Id)) {
            $cleanupComplete = $false
        }
        if (!(Remove-NatPmpMapping $gateway $ChallengePort)) {
            $cleanupComplete = $false
        }
    }
    if (!(Stop-DemoProcess $backend.Id)) {
        $cleanupComplete = $false
    }
    Remove-Item -LiteralPath $stateTempPath -Force -ErrorAction SilentlyContinue
    if ($cleanupComplete) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    } elseif (!(Test-Path -LiteralPath $statePath)) {
        $recoveryState = @{
            challengePort = $ChallengePort
            publicUrl = $publicUrl
            localUrl = "http://localhost:${BackendPort}/"
            artifactUrl = $artifactOrigin + '/'
        }
        if ($enablePublicHost) {
            $recoveryState['publicHostUrl'] = "https://${PublicHost}:${PublicPort}/"
        }
        if ($enablePublicIp) {
            $recoveryState['publicIpUrl'] = "https://${PublicIp}:${PublicPort}/"
        }
        if ($null -ne (Get-Process -Id $backend.Id -ErrorAction SilentlyContinue)) {
            $recoveryState['backendPid'] = $backend.Id
        }
        if ($null -ne $caddy -and $null -ne (Get-Process -Id $caddy.Id -ErrorAction SilentlyContinue)) {
            $recoveryState['caddyPid'] = $caddy.Id
        }
        if ($null -ne $natPmp) {
            $recoveryState['gateway'] = $gateway
            if ($null -ne (Get-Process -Id $natPmp.Id -ErrorAction SilentlyContinue)) {
                $recoveryState['natPmpPid'] = $natPmp.Id
            }
        }
        try {
            Save-StandState $recoveryState
        } catch {
            Write-Warning 'Startup cleanup was incomplete and recovery state could not be written.'
        }
    }
    throw $startupError
}

try {
    Start-Sleep -Seconds 3
    $natPmpExited = $null -ne $natPmp -and $natPmp.HasExited
    if ($backend.HasExited -or $caddy.HasExited -or $natPmpExited) {
        $details = @()
        if (Test-Path -LiteralPath $backendErr) { $details += Get-Content -LiteralPath $backendErr -Raw }
        if (Test-Path -LiteralPath $caddyErr) { $details += Get-Content -LiteralPath $caddyErr -Raw }
        if ($natPmpExited -and (Test-Path -LiteralPath $natPmpErr)) { $details += Get-Content -LiteralPath $natPmpErr -Raw }
        $message = $details -join [Environment]::NewLine
        if (!$message) {
            $message = 'one of the HTTPS stand processes exited during startup'
        }
        throw $message
    }

    if ($enablePublicHost) {
        Wait-HttpsCertificate $caddy $PublicHost $PublicPort $PublicBind $CertificateWaitSeconds
    }
    if ($enablePublicIp) {
        Wait-HttpsCertificate $caddy $PublicIp $PublicPort $PublicBind $CertificateWaitSeconds
    }
    Wait-HttpsCertificate $caddy $ArtifactHost $PublicPort $PublicBind $CertificateWaitSeconds
    if ($backend.HasExited) {
        throw 'the Node backend exited while the HTTPS endpoints were being checked'
    }
    if ($null -ne $natPmp -and $natPmp.HasExited) {
        throw 'the NAT-PMP keeper exited while the certificate was being checked'
    }
} catch {
    Stop-PreviousStand
    throw
}

if ($enablePublicIp) {
    Write-Host "Direct public-IP certificate is ready: https://${PublicIp}:${PublicPort}/"
}
if ($enablePublicHost) {
    Write-Host "Public hostname certificate is ready: https://${PublicHost}:${PublicPort}/"
}
Write-Host "Sandbox artifact certificate is ready: ${artifactOrigin}/"
Write-Host "Local HTTP stand: http://localhost:${BackendPort}/"
Write-Host "Required app forwarding: external TCP ${PublicPort} -> ${PublicBind}:${PublicPort}"
Write-Host "Logs: $runtimeDir"
