param([Parameter(Mandatory=$true)][string]$PackageHome)
$ErrorActionPreference='Stop'
$PackageHome=[IO.Path]::GetFullPath($PackageHome)
$base=Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.local'))) ('installer-test-'+[guid]::NewGuid().ToString('N'))
$destination=Join-Path $base 'installed';$old=Join-Path $base 'old-zip'
$registration='en-agent-test-'+[guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path (Join-Path $old 'data') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $old 'state.json'),'{"current":"0.4.2"}')
[IO.File]::WriteAllText((Join-Path $old 'preferences.json'),'{"browser":"msedge","game":"synthetic"}')
[IO.File]::WriteAllText((Join-Path $old 'data\synthetic-chat'),'synthetic preserved data')
& (Join-Path $PackageHome 'Install.ps1') -Destination $destination -MigrateFrom $old -NonInteractive -RegistrationName $registration
if (!(Test-Path -LiteralPath (Join-Path $destination 'en-agent.exe'))) { throw 'EXE missing' }
if ((Get-Content -LiteralPath (Join-Path $destination 'data\synthetic-chat') -Raw) -ne 'synthetic preserved data') { throw 'Migration lost data' }
if (!(Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$registration))) { throw 'Uninstall registration missing' }
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) $registration
if (!(Test-Path -LiteralPath (Join-Path $menu 'en-agent.lnk'))) { throw 'Shortcut missing' }
& (Join-Path $destination 'Uninstall.ps1') -NonInteractive
if (Test-Path -LiteralPath (Join-Path $destination 'releases')) { throw 'Application files remain' }
if (Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$registration)) { throw 'Registration remains' }
foreach ($folder in @($destination,$old)) { if ((Get-Content -LiteralPath (Join-Path $folder 'data\synthetic-chat') -Raw) -ne 'synthetic preserved data') { throw 'Uninstall removed data' } }
if (Test-Path -LiteralPath (Join-Path $menu 'en-agent.lnk')) { throw 'Shortcut remains' }
Remove-Item -LiteralPath $menu
Write-Output 'PASS: per-user install, ZIP data migration, Start Menu shortcut, Windows registration, uninstall preserves source and user data'
