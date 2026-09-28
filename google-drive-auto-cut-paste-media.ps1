$source = 'C:\Users\User\whatsapp-doc-approval\data'
$destination = 'G:\My Drive\OCR In - Ketul\downloaded-images'
$logPath = Join-Path (Split-Path $source -Parent) 'google-drive-media-transfer.log'
$ErrorActionPreference = 'Stop'

function Write-TransferLog {
    param([string]$Message)

    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
}

function ConvertTo-GoogleDriveName {
    param(
        [string]$Name,
        [switch]$PreserveExtension
    )

    $safeName = $Name.Normalize([System.Text.NormalizationForm]::FormC)
    $safeName = $safeName.Replace([string][char]0xFFFD, '_')
    $safeName = [System.Text.RegularExpressions.Regex]::Replace(
        $safeName,
        '[\p{Cc}\p{Cf}\p{Cs}]',
        '_'
    )

    foreach ($invalidCharacter in [System.IO.Path]::GetInvalidFileNameChars()) {
        $safeName = $safeName.Replace([string]$invalidCharacter, '_')
    }

    $safeName = $safeName.Trim().TrimEnd('.')
    if ([string]::IsNullOrWhiteSpace($safeName)) {
        return '_'
    }

    if ($safeName -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') {
        $safeName = "_$safeName"
    }

    $maximumLength = 120
    if ($safeName.Length -gt $maximumLength) {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($Name)
            $hash = [System.BitConverter]::ToString($sha256.ComputeHash($nameBytes)).Replace('-', '').Substring(0, 8).ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }

        $extension = ''
        if ($PreserveExtension) {
            $candidateExtension = [System.IO.Path]::GetExtension($safeName)
            if ($candidateExtension.Length -le 20) {
                $extension = $candidateExtension
            }
        }

        $stemLength = $maximumLength - $extension.Length - $hash.Length - 1
        $safeName = $safeName.Substring(0, $stemLength).TrimEnd() + "-$hash$extension"
    }

    return $safeName
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\GoogleDriveAutoCutPasteMedia')
if (!$mutex.WaitOne(0)) {
    exit 0
}

try {
    if (!(Test-Path -LiteralPath $source -PathType Container)) {
        throw "Source folder is unavailable: $source"
    }

    if (!(Test-Path -LiteralPath $destination -PathType Container)) {
        throw "Google Drive destination is unavailable: $destination"
    }

    $transferFailed = $false

    Get-ChildItem -LiteralPath $source -File -Recurse |
        ForEach-Object {
            if ($_.LastWriteTime -gt (Get-Date).AddSeconds(-30)) {
                return
            }

            $sourceFile = $_.FullName
            $sourceLength = $_.Length
            $relative = $sourceFile.Substring($source.Length).TrimStart('\')
            $segments = @($relative.Split(
                    [char[]]@([System.IO.Path]::DirectorySeparatorChar),
                    [System.StringSplitOptions]::RemoveEmptyEntries
                ))
            $safeSegments = for ($segmentIndex = 0; $segmentIndex -lt $segments.Count; $segmentIndex++) {
                ConvertTo-GoogleDriveName `
                    -Name $segments[$segmentIndex] `
                    -PreserveExtension:($segmentIndex -eq $segments.Count - 1)
            }
            $safeRelative = [string]::Join('\', $safeSegments)
            $target = Join-Path $destination $safeRelative

            if ($safeRelative -cne $relative) {
                Write-TransferLog "Sanitized Drive path: '$relative' -> '$safeRelative'"
            }

            try {
                if ((Test-Path -LiteralPath $target -PathType Leaf) -and
                    (Get-Item -LiteralPath $target).Length -eq $sourceLength) {
                    Write-TransferLog "Skipped unchanged: '$sourceFile' -> '$target'"
                    return
                }

                New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) |
                    Out-Null

                $inputStream = [System.IO.File]::Open(
                    $sourceFile,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::Read
                )
                try {
                    $outputStream = [System.IO.File]::Open(
                        $target,
                        [System.IO.FileMode]::Create,
                        [System.IO.FileAccess]::Write,
                        [System.IO.FileShare]::None
                    )
                    try {
                        $inputStream.CopyTo($outputStream)
                        $outputStream.Flush()
                    }
                    finally {
                        $outputStream.Dispose()
                    }
                }
                finally {
                    $inputStream.Dispose()
                }

                if ((Get-Item -LiteralPath $target).Length -ne $sourceLength) {
                    throw "Copied file size does not match the source file."
                }

                Write-TransferLog "Copied: '$sourceFile' -> '$target'"
            }
            catch {
                $transferFailed = $true
                $errorCode = $_.Exception.HResult
                Write-TransferLog "FAILED: '$sourceFile' -> '$target' | TargetLength=$($target.Length) | HResult=$errorCode | $($_.Exception.Message)"
            }
        }

    if ($transferFailed) {
        throw "One or more files failed. See '$logPath'."
    }
}
catch {
    Write-TransferLog "FATAL: $($_.Exception.Message)"
    throw
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
