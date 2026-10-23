param([switch]$NonInteractive)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'launcher.lock')) { [void][Windows.Forms.MessageBox]::Show('Сначала завершите en-agent.','en-agent');exit 1 }
if (!$NonInteractive -and [Windows.Forms.MessageBox]::Show('Удалить файлы приложения и ярлыки? Данные, игры, настройки и аккаунты сохранятся.','en-agent','YesNo','Question') -ne 'Yes') { return }
$root=[IO.Path]::GetFullPath($PSScriptRoot)
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe uninstall root' }
$registration=(Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json).registrationName
if ($registration -notmatch '^[a-z0-9-]+$') { throw 'Invalid installation registration' }
foreach ($name in @('releases','Launch.ps1','Install.ps1','en-agent.vbs','en-agent.exe','state.json','channel.json')) {
  $target=[IO.Path]::GetFullPath((Join-Path $root $name))
  if (!$target.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe uninstall target' }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) $registration
foreach ($name in @('en-agent.lnk','Удалить en-agent.lnk')) { $target=Join-Path $menu $name; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target } }
Remove-Item -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$registration) -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $root 'installation.json')
Remove-Item -LiteralPath (Join-Path $root 'Uninstall.ps1')
if (!$NonInteractive) { [void][Windows.Forms.MessageBox]::Show(('Данные сохранены в '+$root),'en-agent') }
