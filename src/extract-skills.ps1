param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=[IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $root) { throw 'Skills extraction requires a fresh directory' }
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $total=0L
  if ($zip.Entries.Count -gt 6000) { throw 'Too many skills entries' }
  # Validate every path and declared size before writing anything.
  foreach ($entry in $zip.Entries) {
    $path=$entry.FullName.Replace('\','/').TrimEnd('/')
    $badSegments=@($path.Split('/') | Where-Object { !$_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)' })
    if (!$path -or $path -match '(^/|[<>:"|?*\x00-\x1f])' -or $badSegments.Count) { throw 'Unsafe skills ZIP path' }
    if (!$names.Add($path)) { throw 'Duplicate skills ZIP path' }
    $kind=($entry.ExternalAttributes -shr 16) -band 61440
    if ($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384) { throw 'Skills ZIP links and special files are forbidden' }
    if (($entry.ExternalAttributes -band 1024) -ne 0) { throw 'Skills ZIP reparse points are forbidden' }
    $total+=$entry.Length
    if ($entry.Length -gt 8388608 -or $total -gt 67108864) { throw 'Skills ZIP size limit exceeded' }
    $target=[IO.Path]::GetFullPath((Join-Path $root $path))
    if (!$target.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Skills ZIP path escapes destination' }
  }
  [void][IO.Directory]::CreateDirectory($root)
  foreach ($entry in $zip.Entries) {
    $target=Join-Path $root $entry.FullName.Replace('\','/')
    if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) { [void][IO.Directory]::CreateDirectory($target); continue }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    $inputStream=$entry.Open()
    try {
      $outputStream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
      try {
        $buffer=New-Object byte[] 65536
        $written=0L
        while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
          $written+=$count
          if ($written -gt $entry.Length -or $written -gt 8388608) { throw 'Skills entry exceeds declared size' }
          $outputStream.Write($buffer,0,$count)
        }
        if ($written -ne $entry.Length) { throw 'Truncated skills entry' }
      } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
  }
} finally { $zip.Dispose() }
