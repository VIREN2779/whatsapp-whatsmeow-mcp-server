$source = 'C:\Users\User\whatsapp-doc-approval\data'
$destination = 'G:\My Drive\OCR In - Ketul\downloaded-images'
$ErrorActionPreference = 'Stop'

if (!(Test-Path -LiteralPath $source -PathType Container)) {
    throw "Source folder is unavailable: $source"
}

if (!(Test-Path -LiteralPath 'G:\My Drive' -PathType Container)) {
    throw 'Google Drive is unavailable.'
}

Get-ChildItem -LiteralPath $source -File -Recurse |
    ForEach-Object {
        if ($_.LastWriteTime -gt (Get-Date).AddSeconds(-30)) {
            return
        }

        $relative = $_.FullName.Substring($source.Length).TrimStart('\')
        $target = Join-Path $destination $relative

        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) |
            Out-Null

        Copy-Item -LiteralPath $_.FullName -Destination $target -Force

        if (Test-Path -LiteralPath $target -PathType Leaf) {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }

Get-ChildItem -LiteralPath $source -Directory -Recurse |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object {
        if (!(Get-ChildItem -LiteralPath $_.FullName -Force |
                Select-Object -First 1)) {
            Remove-Item -LiteralPath $_.FullName
        }
    }
