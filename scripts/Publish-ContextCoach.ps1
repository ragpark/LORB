<#
.SYNOPSIS
  Registers the context-routed coach example and sets its launch context.

.EXAMPLE
  $env:LORB_TOKEN = '<access_token from /auth/session>'
  $env:REPOSITORY_ID = '<uuid>'
  ./scripts/Publish-ContextCoach.ps1

.NOTES
  Requires the module to be present in the deployed Player Shell image at
  /modules/context-coach/. The script hashes what the player serves, so it will
  stop rather than register an object pointing at content that is not there.
#>
[CmdletBinding()]
param(
    [string]$Registry       = 'https://my-pq-registry.cookie.pearsondev.tech',
    [string]$Player         = 'https://my-pq-registry-player.cookie.pearsondev.tech',
    [string]$PlayerBasePath = '/api',
    [string]$RepositoryId   = $env:REPOSITORY_ID,
    [string]$Course         = 'maths-gcse',
    [ValidateSet('calm', 'high-contrast')][string]$Theme = 'calm'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Lorb.Publish.ps1"

$token = Get-LorbToken -Registry $Registry
if (-not $RepositoryId) {
    throw "Set `$env:REPOSITORY_ID to an existing ACTIVE repository, or run Publish-Examples.ps1 first to create one."
}

$modulePath = '/modules/context-coach/index.html'

$sha = Get-ServedDigest -Player $Player -PlayerBasePath $PlayerBasePath -ModulePath $modulePath
Write-Host "==> module digest $($sha.Substring(0, 12))..."

Write-Host '==> Registering the learning object'
$object = Invoke-Lorb -Method POST -Registry $Registry -Token $token `
    -Path '/api/v1/publisher/learning-objects' -Body @{
        repository_id = $RepositoryId
        title         = 'Context-routed coach'
        description   = 'Demonstrates launch context driving styling and relay endpoint selection.'
        duration      = '5 minutes'
        kind          = 'coaching-chatbot'
        module_path   = $modulePath
        semver        = '1.0.0'
        sha256        = $sha
    }

# Under Set-StrictMode, reading a property that is absent throws rather than yielding $null,
# so the presence check has to come first or the guard below can never run.
if ($object.PSObject.Properties.Name -notcontains 'object_id') {
    throw "No object_id in the response: $($object | ConvertTo-Json -Depth 5 -Compress)"
}
$objectId = $object.object_id
Write-Host "object_id = $objectId"

Write-Host "==> Setting the launch context (theme=$Theme course=$Course)"
$revision = Invoke-Lorb -Method PUT -Registry $Registry -Token $token `
    -Path "/api/v1/publisher/learning-objects/$objectId/launch-context" -Body @{
        launch_context = @{
            theme    = $Theme
            settings = @{
                course   = $Course
                cohort   = 'y11'
                adaptive = $true
            }
        }
    }

$versionId = if ($revision.PSObject.Properties.Name -contains 'object_version_id') { $revision.object_version_id } else { '(not reported)' }
Write-Host "new object_version_id = $versionId"
Write-Host ''
Write-Host "==> Done. The module will request endpoint: coach-$Course"
Write-Host '    Configure RELAY_COACH_ENDPOINTS on the registry app to route it to a real provider;'
Write-Host '    with nothing configured the relay answers from its built-in demo coach.'
