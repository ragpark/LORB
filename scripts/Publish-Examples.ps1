<#
.SYNOPSIS
  Creates a repository and publishes the three bundled example learning objects.

.DESCRIPTION
  The deployed catalogue is empty by design: the seed file is gated on
  SEED_EXAMPLE_CONTENT, and the Runtime API refuses to start with that flag set
  when NODE_ENV=production. So examples arrive the way real content does -
  through the Publisher API, which is what this exercises.

.EXAMPLE
  $env:LORB_TOKEN = '<access_token from /auth/session>'
  ./scripts/Publish-Examples.ps1
#>
[CmdletBinding()]
param(
    [string]$Registry       = 'https://my-pq-registry.cookie.pearsondev.tech',
    [string]$Player         = 'https://my-pq-registry-player.cookie.pearsondev.tech',
    [string]$PlayerBasePath = '/api',
    [string]$RepositoryId   = $env:REPOSITORY_ID
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Lorb.Publish.ps1"

$token = Get-LorbToken -Registry $Registry

if (-not $RepositoryId) {
    Write-Host '==> Creating the repository'
    try {
        $repository = Invoke-Lorb -Method POST -Registry $Registry -Token $token `
            -Path '/api/v1/admin/repositories' -Body @{
                slug         = 'default'
                display_name = 'Default repository'
            }
        if ($repository.PSObject.Properties.Name -notcontains 'repository_id') {
            throw "No repository_id in the response: $($repository | ConvertTo-Json -Depth 5 -Compress)"
        }
        $RepositoryId = $repository.repository_id
    }
    catch {
        if ($_.Exception.Message -match 'REPOSITORY_SLUG_TAKEN') {
            Write-Host 'A repository with that slug already exists. List the existing ones with:'
            Write-Host "  Invoke-RestMethod -Uri '$Registry/api/v1/admin/repositories' -Headers @{ Authorization = 'Bearer ' + `$env:LORB_TOKEN }"
            Write-Host '  then re-run this script with -RepositoryId <uuid>'
            throw 'Repository slug already taken.'
        }
        throw
    }
}
Write-Host "repository_id = $RepositoryId"

# Creating a repository makes you its repository_owner, so the publishes below need no further grant.

$examples = @(
    @{
        Title       = 'Maths foundations: ratios and proportion'
        Description = 'A native-web-package activity with a single completion checkpoint.'
        Duration    = '20 minutes'
        Kind        = 'native-web-package'
        ModulePath  = '/module/index.html'
    },
    @{
        Title       = 'Reflective Practice Studio'
        Description = 'A React web experience that emits xAPI statements for delivery to the learning record store.'
        Duration    = '8 minutes'
        Kind        = 'react-xapi-experience'
        ModulePath  = '/modules/reflective-practice-studio/index.html'
    },
    @{
        Title       = 'Career Coach Check-in'
        Description = 'A chatbot-style coaching tool that guides a learner through a short reflective conversation.'
        Duration    = '5 minutes'
        Kind        = 'coaching-chatbot'
        ModulePath  = '/modules/career-coach-chat/index.html'
    }
)

foreach ($example in $examples) {
    $sha = Get-ServedDigest -Player $Player -PlayerBasePath $PlayerBasePath -ModulePath $example.ModulePath
    Write-Host "==> $($example.Title)  (sha256 $($sha.Substring(0, 12))...)"

    $object = Invoke-Lorb -Method POST -Registry $Registry -Token $token `
        -Path '/api/v1/publisher/learning-objects' -Body @{
            repository_id = $RepositoryId
            title         = $example.Title
            description   = $example.Description
            duration      = $example.Duration
            kind          = $example.Kind
            module_path   = $example.ModulePath
            semver        = '1.0.0'
            sha256        = $sha
        }
    Write-Host "    object_id = $($object.object_id)"
}

Write-Host ''
Write-Host '==> Catalogue now holds:'
$catalogue = Invoke-Lorb -Method GET -Registry $Registry -Token $token -Path '/api/v1/publisher/learning-objects'
if ($catalogue.PSObject.Properties.Name -contains 'items') {
    $catalogue.items | Select-Object object_id, title, kind, status | Format-Table -AutoSize
} else {
    $catalogue | ConvertTo-Json -Depth 5
}
