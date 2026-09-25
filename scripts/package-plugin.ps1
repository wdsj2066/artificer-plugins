[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PluginId,

    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repositoryRoot 'dist'
}
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
    New-Item -ItemType Directory -Force -Path $stagedPluginDirectory | Out-Null
    Get-ChildItem -LiteralPath $pluginDirectory -Force |
        Where-Object { $_.Name -ne 'node_modules' } |
        Copy-Item -Destination $stagedPluginDirectory -Recurse -Force

    Get-ChildItem -LiteralPath $stagedPluginDirectory -Recurse -Directory -Force |
        Where-Object { $_.Name -eq 'node_modules' } |
        Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $stagedPluginDirectory -Recurse -File -Force |
        Where-Object { $_.Name -like '.artificer-runtime-entry*' } |
        Remove-Item -Force

    $pluginPackageJson = Join-Path $stagedPluginDirectory 'package.json'
    if (Test-Path -LiteralPath $pluginPackageJson -PathType Leaf) {
        $pluginLockFile = Join-Path $stagedPluginDirectory 'package-lock.json'
        if (-not (Test-Path -LiteralPath $pluginLockFile -PathType Leaf)) {
            throw "Plugin package.json requires a package-lock.json: $pluginLockFile"
        }

        if ($IsWindows) {
            & npm.cmd ci --prefix $stagedPluginDirectory --omit=dev --ignore-scripts --no-audit --no-fund
        }
        else {
            & npm ci --prefix $stagedPluginDirectory --omit=dev --ignore-scripts --no-audit --no-fund
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install production dependencies for plugin '$PluginId'."
        }
    }

    if ($manifest.ui) {
        $compilerDirectory = Join-Path $repositoryRoot 'plugins/ui-compiler-vue'
        if (-not (Test-Path -LiteralPath (Join-Path $compilerDirectory 'node_modules/vite') -PathType Container)) {
            if ($IsWindows) {
                & npm.cmd ci --prefix $compilerDirectory --ignore-scripts --no-audit --no-fund
            }
            else {
                & npm ci --prefix $compilerDirectory --ignore-scripts --no-audit --no-fund
            }
            if ($LASTEXITCODE -ne 0) {
                throw 'Failed to install publisher-side Vue compiler dependencies.'
            }
        }
    }

    if ($PluginId -eq 'ui-compiler-vue') {
        $platform = & node -p "process.platform + '-' + process.arch"
        $stagedManifest = Get-Content -LiteralPath (Join-Path $stagedPluginDirectory 'plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $stagedManifest | Add-Member -NotePropertyName packagePlatform -NotePropertyValue $platform -Force
        $stagedManifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $stagedPluginDirectory 'plugin.json') -Encoding UTF8
    }

    & node (Join-Path $PSScriptRoot 'build-plugin-ui.mjs') $stagedPluginDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to build UI for plugin '$PluginId'."
    }

    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    Compress-Archive -LiteralPath $stagedPluginDirectory -DestinationPath $archivePath -Force

    $hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
    Write-Output "Package: $archivePath"
    Write-Output "SHA256: $($hash.Hash)"
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
