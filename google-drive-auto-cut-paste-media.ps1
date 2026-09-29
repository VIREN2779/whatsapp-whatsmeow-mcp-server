$source = 'C:\Users\User\whatsapp-doc-approval\data'
$destination = 'G:\My Drive\OCR In - Ketul\downloaded-images'
$logPath = Join-Path (Split-Path $source -Parent) 'google-drive-media-transfer.log'
$ErrorActionPreference = 'Stop'

function Write-TransferLog {
    param([string]$Message)

    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
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
            $target = Join-Path $destination $relative

            try {
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

                Remove-Item -LiteralPath $sourceFile -Force
                Write-TransferLog "Moved: '$sourceFile' -> '$target'"
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

    Get-ChildItem -LiteralPath $source -Directory -Recurse |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
            if (!(Get-ChildItem -LiteralPath $_.FullName -Force |
                    Select-Object -First 1)) {
                Remove-Item -LiteralPath $_.FullName
            }
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
