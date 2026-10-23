param([string]$Destination=(Join-Path $env:LOCALAPPDATA 'Programs\en-agent'),[string]$MigrateFrom,[switch]$NonInteractive,[ValidatePattern('^[a-z0-9-]+$')][string]$RegistrationName='en-agent')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  $Destination=[IO.Path]::GetFullPath($Destination)
  for ($ancestor=$Destination; $ancestor; $ancestor=[IO.Path]::GetDirectoryName($ancestor)) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Установка через файловую ссылку запрещена' }
  }
  $sourceState=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'state.json') -Raw | ConvertFrom-Json
  if ($sourceState.current -notmatch '^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$') { throw 'Invalid package version' }
  $sourceRelease=Join-Path $PSScriptRoot ('releases\'+$sourceState.current)
  & (Join-Path $sourceRelease 'bin\node.exe') (Join-Path $sourceRelease 'launcher\src\verify-installation.mjs') $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw 'Package verification failed' }
  if (!$NonInteractive) {
    if ([Windows.Forms.MessageBox]::Show(('Установить en-agent для текущего пользователя в '+$Destination+'? Данные существующей ZIP-установки можно перенести на следующем шаге.'),'en-agent','OKCancel') -ne 'OK') { return }
    if ([Windows.Forms.MessageBox]::Show('Перенести данные из существующей ZIP-установки? Она должна быть закрыта. Исходная папка сохранится.','Миграция','YesNo') -eq 'Yes') {
      $picker=New-Object Windows.Forms.FolderBrowserDialog
      if ($picker.ShowDialog() -ne 'OK') { return }; $MigrateFrom=$picker.SelectedPath
    }
  }
  if (Test-Path -LiteralPath (Join-Path $Destination 'state.json')) { throw 'Установка уже существует. Используйте автообновление.' }
  if ($MigrateFrom) {
    $MigrateFrom=[IO.Path]::GetFullPath($MigrateFrom)
    if (!(Test-Path -LiteralPath (Join-Path $MigrateFrom 'state.json'))) { throw 'Не найдена ZIP-установка' }
    if (Test-Path -LiteralPath (Join-Path $MigrateFrom 'launcher.lock')) { throw 'Сначала завершите launcher старой установки' }
    if ($MigrateFrom -eq $Destination -or $Destination.StartsWith($MigrateFrom+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Выберите отдельную папку назначения' }
    foreach ($name in @('data','preferences.json')) { if (Test-Path -LiteralPath (Join-Path $Destination $name)) { throw 'В назначении уже есть данные; выберите пустую папку' } }
    if (Get-ChildItem -LiteralPath $MigrateFrom -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Миграция ссылок не поддерживается' }
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  # Private per-user install; credentials themselves remain in Credential Manager.
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  Set-Acl -LiteralPath $Destination -AclObject $acl
  foreach ($name in @('releases','state.json','channel.json','Launch.ps1','en-agent.exe','Install.ps1','Uninstall.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $Destination -Recurse -Force }
  if ($MigrateFrom) { foreach ($name in @('data','preferences.json')) { $source=Join-Path $MigrateFrom $name; if (Test-Path -LiteralPath $source) { if (Test-Path -LiteralPath (Join-Path $Destination $name)) { throw 'В назначении уже есть пользовательские данные; автоматическое слияние запрещено' }; Copy-Item -LiteralPath $source -Destination $Destination -Recurse } } }
  [IO.File]::WriteAllText((Join-Path $Destination 'installation.json'),(@{registrationName=$RegistrationName} | ConvertTo-Json))
  $menu=Join-Path ([Environment]::GetFolderPath('Programs')) $RegistrationName
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  # Shell shortcuts use the ShellLink COM API through a tiny compiled helper, no WSH.
  $shortcutSource=Join-Path $PSScriptRoot 'releases'
  $state=Get-Content (Join-Path $Destination 'state.json') -Raw | ConvertFrom-Json
  Add-Type -Path (Join-Path $Destination ('releases\'+$state.current+'\launcher\windows\Shortcut.cs'))
  [EnAgentShortcut]::Create((Join-Path $menu 'en-agent.lnk'),(Join-Path $Destination 'en-agent.exe'),'')
  [EnAgentShortcut]::Create((Join-Path $menu 'Удалить en-agent.lnk'),(Join-Path $Destination 'en-agent.exe'),'--uninstall')
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$RegistrationName
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayName -Value 'en-agent' -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayVersion -Value $state.current -Force | Out-Null
  New-ItemProperty -Path $key -Name UninstallString -Value ('"'+(Join-Path $Destination 'en-agent.exe')+'" --uninstall') -Force | Out-Null
  if (!$NonInteractive) { [void][Windows.Forms.MessageBox]::Show('Установлено. Откройте en-agent в меню Пуск.','en-agent') }
} catch { if ($NonInteractive) { throw }; [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'en-agent','OK','Error');exit 1 }
