param([Parameter(Mandatory=$true)][string]$PackageHome,[Parameter(Mandatory=$true)][string]$OldPackageHome)
$ErrorActionPreference='Stop'
$PackageHome=[IO.Path]::GetFullPath($PackageHome);$OldPackageHome=[IO.Path]::GetFullPath($OldPackageHome)
$expectedVersion=(Get-Content (Join-Path $PackageHome 'state.json') -Raw | ConvertFrom-Json).current
$testBase=Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.local'))) ('setup-upgrade-'+[guid]::NewGuid().ToString('N'))
$destination=Join-Path $testBase 'installed';$registration='en-agent-test-'+[guid]::NewGuid().ToString('N')
$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$registration
$previousLocalAppData=$env:LOCALAPPDATA
try {
  & (Join-Path $OldPackageHome 'Install.ps1') -Destination $destination -RegistrationName $registration -NonInteractive
  $oldVersion=(Get-Content (Join-Path $destination 'state.json') -Raw | ConvertFrom-Json).current
  [void][IO.Directory]::CreateDirectory((Join-Path $destination 'data'))
  [IO.File]::WriteAllText((Join-Path $destination 'data/chat'),'preserved chat and authorization fixture')
  [IO.File]::WriteAllText((Join-Path $destination 'preferences.json'),'{"browser":"yandex","game":"synthetic"}')
  $channel=Get-Content -Raw -LiteralPath (Join-Path $destination 'channel.json') | ConvertFrom-Json
  # 0.0.1 registered only UninstallString, without InstallLocation.
  Remove-ItemProperty -LiteralPath $key -Name InstallLocation -ErrorAction SilentlyContinue
  & (Join-Path $PackageHome 'Install.ps1') -RegistrationName $registration -NonInteractive
  $state=Get-Content (Join-Path $destination 'state.json') -Raw | ConvertFrom-Json
  if ($state.current -ne $expectedVersion -or $state.previous -ne $oldVersion) { throw 'Automatic legacy-path upgrade failed' }
  $backup=$state.backup
  foreach ($attempt in 1..2) {
    if ($attempt -eq 2) { Remove-Item -LiteralPath (Join-Path $destination 'state.json') }
    & (Join-Path $PackageHome 'Install.ps1') -RegistrationName $registration -NonInteractive
    if ([IO.File]::ReadAllText((Join-Path $destination 'data/chat')) -ne 'preserved chat and authorization fixture') { throw 'User data changed' }
    if ([IO.File]::ReadAllText((Join-Path $destination 'preferences.json')) -ne '{"browser":"yandex","game":"synthetic"}') { throw 'Preferences changed' }
    $currentChannel=Get-Content -Raw -LiteralPath (Join-Path $destination 'channel.json') | ConvertFrom-Json
    if ($currentChannel.publicKey -ne $channel.publicKey -or $currentChannel.assetsUrl -ne $channel.assetsUrl) { throw 'Trusted channel changed' }
    if ($currentChannel.manifestUrl -ne $channel.manifestUrl) { throw 'Installed manifest URL changed' }
  }
  if (!(Test-Path -LiteralPath (Join-Path $destination ('backups/'+$backup+'/data/chat')))) { throw 'Backup missing' }
  if ((Get-ItemProperty -LiteralPath $key).InstallLocation -ne $destination) { throw 'Installation path not registered' }
  & (Join-Path $destination 'Uninstall.ps1') -NonInteractive
  # With no registration or state, reuse the standard folder and retain its data.
  $env:LOCALAPPDATA=Join-Path $testBase 'localappdata'
  $destination=Join-Path $env:LOCALAPPDATA 'Programs/en-agent'
  [void][IO.Directory]::CreateDirectory((Join-Path $destination 'data'))
  [IO.File]::WriteAllText((Join-Path $destination 'data/chat'),'retained without metadata')
  & (Join-Path $PackageHome 'Install.ps1') -RegistrationName $registration -NonInteractive
  if ([IO.File]::ReadAllText((Join-Path $destination 'data/chat')) -ne 'retained without metadata') { throw 'Fallback install lost data' }
  if ((Get-Content (Join-Path $destination 'state.json') -Raw | ConvertFrom-Json).current -ne $expectedVersion) { throw 'Default-path repair failed' }
  Write-Output 'PASS: legacy EXE registration discovery, in-place upgrade, repeated setup, missing state repair, default-folder recovery, backups and data preservation'
} finally {
  $env:LOCALAPPDATA=$previousLocalAppData
  if (Test-Path -LiteralPath (Join-Path $destination 'Uninstall.ps1')) { & (Join-Path $destination 'Uninstall.ps1') -NonInteractive }
  $menu=Join-Path ([Environment]::GetFolderPath('Programs')) $registration
  if (Test-Path -LiteralPath $menu) { Remove-Item -LiteralPath $menu }
}
