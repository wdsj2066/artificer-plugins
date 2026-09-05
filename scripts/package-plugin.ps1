[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PluginId,

    [string]$OutputDir = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pluginDirectory = Join-Path $repositoryRoot (Join-Path 'plugins' $PluginId)
$pluginManifest = Join-Path $pluginDirectory 'plugin.json'

if (-not (Test-Path -LiteralPath $pluginDirectory -PathType Container)) {
    throw "Plugin directory does not exist: $pluginDirectory"
}

if (-not (Test-Path -LiteralPath $pluginManifest -PathType Leaf)) {
    throw "plugin.json does not exist: $pluginManifest"
}

try {
    $manifest = Get-Content -LiteralPath $pluginManifest -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
}
catch {
    throw "Invalid plugin.json at ${pluginManifest}: $($_.Exception.Message)"
}

if ($manifest.id -ne $PluginId) {
    throw "plugin.json id '$($manifest.id)' does not match PluginId '$PluginId'."
}

if ([string]::IsNullOrWhiteSpace([string]$manifest.version)) {
    throw 'plugin.json must contain a non-empty version.'
}

if ([IO.Path]::IsPathRooted($OutputDir)) {
    $resolvedOutputDir = [IO.Path]::GetFullPath($OutputDir)
}
else {
    $resolvedOutputDir = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
}
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("artificer-plugin-{0}" -f [Guid]::NewGuid().ToString('N'))
$stagedPluginDirectory = Join-Path $tempRoot $PluginId
$archivePath = Join-Path $resolvedOutputDir ("{0}-{1}.zip" -f $PluginId, $manifest.version)

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    Copy-Item -LiteralPath $pluginDirectory -Destination $tempRoot -Recurse -Force

    Get-ChildItem -LiteralPath $stagedPluginDirectory -Recurse -Directory -Force |
        Where-Object { $_.Name -eq 'node_modules' } |
        Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $stagedPluginDirectory -Recurse -File -Force |
        Where-Object { $_.Name -eq '.artificer-runtime-entry.mjs' } |
        Remove-Item -Force

    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    Compress-Archive -LiteralPath $stagedPluginDirectory -DestinationPath $archivePath -Force

    $hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
    Write-Output "Package: $archivePath"
    Write-Output "SHA256: $($hash.Hash)"
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}