param([string]$Destination=(Join-Path $env:LOCALAPPDATA 'Programs\en-agent'),[string]$MigrateFrom,[switch]$NonInteractive,[ValidatePattern('^[a-z0-9-]+$')][string]$RegistrationName='en-agent')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$RegistrationName
  if (!$PSBoundParameters.ContainsKey('Destination') -and (Test-Path -LiteralPath $key)) {
    $registered=Get-ItemProperty -LiteralPath $key
    if ($registered.InstallLocation) { $Destination=[string]$registered.InstallLocation }
    elseif ([string]$registered.UninstallString -match '^"([^"\r\n]+\\en-agent\.exe)"\s+--uninstall$') { $Destination=Split-Path $Matches[1] -Parent }
  }
  $Destination=[IO.Path]::GetFullPath($Destination).TrimEnd('\')
  for ($ancestor=$Destination; $ancestor; $ancestor=[IO.Path]::GetDirectoryName($ancestor)) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Установка через файловую ссылку запрещена' }
  }
  $sourceState=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'state.json') -Raw | ConvertFrom-Json
  if ($sourceState.current -notmatch '^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$') { throw 'Invalid package version' }
  $sourceRelease=Join-Path $PSScriptRoot ('releases\'+$sourceState.current)
  & (Join-Path $sourceRelease 'bin\node.exe') (Join-Path $sourceRelease 'launcher\src\verify-installation.mjs') $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw 'Package verification failed' }
  # Use the same per-installation mutex as Launch.ps1, including before Node starts.
  $mutexKey=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Destination.ToLowerInvariant()))).Replace('-','')
  $installMutex=New-Object Threading.Mutex($false,('Local\en-agent-owner-'+$mutexKey))
  try { $ownsInstall=$installMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsInstall=$true }
  if (!$ownsInstall) { throw 'Сначала закройте окно en-agent, затем повторите установку.' }
  $hasExisting=(Test-Path -LiteralPath (Join-Path $Destination 'state.json')) -or (Test-Path -LiteralPath (Join-Path $Destination 'data')) -or (Test-Path -LiteralPath (Join-Path $Destination 'installation.json'))
  if (!$NonInteractive) {
    $action=if ($hasExisting) { 'Обновить или восстановить en-agent' } else { 'Установить en-agent' }
    if ([Windows.Forms.MessageBox]::Show(($action+' для текущего пользователя в '+$Destination+'? Данные, настройки и игры сохранятся.'),'en-agent','OKCancel') -ne 'OK') { return }
  }
  if ($MigrateFrom) {
    $MigrateFrom=[IO.Path]::GetFullPath($MigrateFrom)
    if (!(Test-Path -LiteralPath (Join-Path $MigrateFrom 'state.json'))) { throw 'Не найдена ZIP-установка' }
    if (Test-Path -LiteralPath (Join-Path $MigrateFrom 'launcher.lock')) { throw 'Сначала завершите launcher старой установки' }
    if ($MigrateFrom -eq $Destination -or $Destination.StartsWith($MigrateFrom+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Выберите отдельную папку назначения' }
    foreach ($name in @('data','preferences.json')) { if (Test-Path -LiteralPath (Join-Path $Destination $name)) { throw 'В назначении уже есть данные; выберите пустую папку' } }
    if (Get-ChildItem -LiteralPath $MigrateFrom -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Миграция ссылок не поддерживается' }
  }
  $existingDirectory=Test-Path -LiteralPath $Destination
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  # Private per-user install; credentials themselves remain in Credential Manager.
  if (!$existingDirectory) {
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $Destination -AclObject $acl
  }
  $installer=Join-Path $sourceRelease 'launcher/src/install-bundle.mjs'
  $result=@(& (Join-Path $sourceRelease 'bin/node.exe') $installer $PSScriptRoot $Destination 2>&1)
  if ($LASTEXITCODE -ne 0) { throw ($result -join [Environment]::NewLine) }
  if ($MigrateFrom) { foreach ($name in @('data','preferences.json')) { $source=Join-Path $MigrateFrom $name; if (Test-Path -LiteralPath $source) { if (Test-Path -LiteralPath (Join-Path $Destination $name)) { throw 'В назначении уже есть пользовательские данные; автоматическое слияние запрещено' }; Copy-Item -LiteralPath $source -Destination $Destination -Recurse } } }
  [IO.File]::WriteAllText((Join-Path $Destination 'installation.json'),(@{registrationName=$RegistrationName} | ConvertTo-Json))
  $menu=Join-Path ([Environment]::GetFolderPath('Programs')) $RegistrationName
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  # Shell shortcuts use the ShellLink COM API through a tiny compiled helper, no WSH.
  $shortcutSource=Join-Path $PSScriptRoot 'releases'
  $state=Get-Content (Join-Path $Destination 'state.json') -Raw | ConvertFrom-Json
  if (!('EnAgentShortcut' -as [type])) { Add-Type -Path (Join-Path $Destination ('releases\'+$state.current+'\launcher\windows\Shortcut.cs')) }
  [EnAgentShortcut]::Create((Join-Path $menu 'en-agent.lnk'),(Join-Path $Destination 'en-agent.exe'),'')
  [EnAgentShortcut]::Create((Join-Path $menu 'Удалить en-agent.lnk'),(Join-Path $Destination 'en-agent.exe'),'--uninstall')
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$RegistrationName
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayName -Value 'en-agent' -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayVersion -Value $state.current -Force | Out-Null
  New-ItemProperty -Path $key -Name InstallLocation -Value $Destination -Force | Out-Null
  New-ItemProperty -Path $key -Name UninstallString -Value ('"'+(Join-Path $Destination 'en-agent.exe')+'" --uninstall') -Force | Out-Null
  if (!$NonInteractive) { [void][Windows.Forms.MessageBox]::Show('Установка завершена. Данные сохранены. Откройте en-agent в меню Пуск.','en-agent') }
} catch { if ($NonInteractive) { throw }; [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'en-agent','OK','Error');exit 1 } finally {
  if ($ownsInstall) { $installMutex.ReleaseMutex() }
  if ($installMutex) { $installMutex.Dispose() }
}
