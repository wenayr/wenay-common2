param(
    [Parameter(Mandatory = $true)]
    [string]$Gateway,
    [Parameter(Mandatory = $true)]
    [int]$InternalPort,
    [int]$ExternalPort = 80,
    [int]$LifetimeSeconds = 7200,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Set-NatPmpMapping([int]$lifetime) {
    [byte[]]$request = @(
        0,
        2,
        0,
        0,
        (($InternalPort -shr 8) -band 0xff),
        ($InternalPort -band 0xff),
        (($ExternalPort -shr 8) -band 0xff),
        ($ExternalPort -band 0xff),
        (($lifetime -shr 24) -band 0xff),
        (($lifetime -shr 16) -band 0xff),
        (($lifetime -shr 8) -band 0xff),
        ($lifetime -band 0xff)
    )

    $udp = [System.Net.Sockets.UdpClient]::new()
    try {
        $udp.Connect($Gateway, 5351)
        [void]$udp.Send($request, $request.Length)
        $receive = $udp.ReceiveAsync()
        if (!$receive.Wait(3000)) {
            throw 'NAT-PMP mapping request timed out'
        }

        $response = $receive.Result.Buffer
        if ($response.Length -lt 16 -or $response[1] -ne 130) {
            throw 'NAT-PMP router returned an invalid mapping response'
        }

        $result = ([int]$response[2] -shl 8) + $response[3]
        if ($result -ne 0) {
            throw "NAT-PMP router rejected the mapping with result $result"
        }

        $mappedPort = ([int]$response[10] -shl 8) + $response[11]
        if ($lifetime -ne 0 -and $mappedPort -ne $ExternalPort) {
            throw "NAT-PMP router mapped external port $mappedPort instead of $ExternalPort"
        }

        $grantedLifetime = ([uint32]$response[12] -shl 24) +
            ([uint32]$response[13] -shl 16) +
            ([uint32]$response[14] -shl 8) +
            $response[15]
        Write-Host "NAT-PMP TCP $ExternalPort -> local $InternalPort, lifetime $grantedLifetime seconds"
        return [int]$grantedLifetime
    } finally {
        $udp.Dispose()
    }
}

if ($Remove) {
    [void](Set-NatPmpMapping 0)
    exit 0
}

$hasMapping = $false
while ($true) {
    try {
        $grantedLifetime = Set-NatPmpMapping $LifetimeSeconds
        if ($grantedLifetime -le 0) {
            throw 'NAT-PMP router granted a zero-second mapping lifetime'
        }
        $hasMapping = $true
        $renewAfter = [Math]::Max(1, [Math]::Min(1800, [Math]::Floor($grantedLifetime / 2)))
        Start-Sleep -Seconds $renewAfter
    } catch {
        if (!$hasMapping) {
            throw
        }
        Write-Warning "NAT-PMP renewal failed; retrying in 15 seconds: $($_.Exception.Message)"
        Start-Sleep -Seconds 15
    }
}
