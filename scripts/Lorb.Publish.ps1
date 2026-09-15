<#
.SYNOPSIS
  Shared helpers for publishing into a running LORB registry from PowerShell.

.DESCRIPTION
  Dot-source this from the publish scripts:  . "$PSScriptRoot/Lorb.Publish.ps1"

  Deliberately does not use `curl`: in PowerShell that name is an alias for
  Invoke-WebRequest, which takes entirely different arguments, so a bash command
  pasted into PowerShell fails in confusing ways rather than cleanly.
#>

Set-StrictMode -Version Latest

function Get-LorbToken {
    <#  The access token from {Registry}/auth/session. Read from the environment rather than a
        parameter so it does not end up in PowerShell's command history. #>
    param([string]$Registry)
    $token = $env:LORB_TOKEN
    if (-not $token) {
        throw "Set `$env:LORB_TOKEN first. Sign in to $Registry in a browser, open $Registry/auth/session, and copy the access_token value."
    }
    return $token
}

function Invoke-Lorb {
    <#  One authenticated call. Every write needs an Idempotency-Key: the API rejects a request
        without one, and reusing a key with a different body is a conflict, so a fresh GUID per
        call is correct. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST', 'PUT', 'PATCH')][string]$Method,
        [Parameter(Mandatory)][string]$Registry,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Token,
        $Body
    )

    $headers = @{
        'Authorization'    = "Bearer $Token"
        'Idempotency-Key'  = [guid]::NewGuid().ToString()
        'X-Correlation-Id' = [guid]::NewGuid().ToString()
    }

    # Not $args — that is an automatic variable in PowerShell and assigning to it misbehaves.
    $params = @{
        Method  = $Method
        Uri     = "$Registry$Path"
        Headers = $headers
    }

    if ($null -ne $Body) {
        # -Depth matters: ConvertTo-Json defaults to 2 and would silently flatten the nested
        # launch_context.settings object into a type name string.
        $json = $Body | ConvertTo-Json -Depth 10 -Compress
        # Encode explicitly: Windows PowerShell 5.1 would otherwise send this as ISO-8859-1.
        $params.Body        = [System.Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json; charset=utf-8'
    }

    try {
        Invoke-RestMethod @params
    }
    catch {
        # The API answers failures as problem+json; that body is the useful part, and it lives in
        # ErrorDetails rather than the exception message.
        $detail = $null
        if ($_.PSObject.Properties.Name -contains 'ErrorDetails' -and $_.ErrorDetails) {
            $detail = $_.ErrorDetails.Message
        }
        if (-not $detail) { $detail = $_.Exception.Message }
        throw "$Method $Path failed: $detail"
    }
}

function Get-ServedDigest {
    <#  Hashes what the Player Shell actually serves, rather than inventing a value for a field
        called sha256. Throws if the module is not being served, which is the intended behaviour:
        better a refusal than a catalogue entry pointing at a 404. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Player,
        [Parameter(Mandatory)][string]$PlayerBasePath,
        [Parameter(Mandatory)][string]$ModulePath
    )

    $url = "$Player$PlayerBasePath$ModulePath"
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        try {
            Invoke-WebRequest -Uri $url -OutFile $tmp -ErrorAction Stop | Out-Null
        }
        catch {
            throw "Could not fetch $url - has the player been rebuilt with this module? ($($_.Exception.Message))"
        }
        # Get-FileHash returns uppercase; the stored value matches the bash script's lowercase.
        return (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}
