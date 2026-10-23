param([string]$HomeDirectory = (Join-Path $env:LOCALAPPDATA 'en-agent'), [switch]$ResumeLastGame)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
public static class EnAgentLauncherWindow {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public static Mutex Owner;
  public static EventWaitHandle Focus;
  public static bool Acquire(string home) {
    var sid=WindowsIdentity.GetCurrent().User;
    string key=BitConverter.ToString(SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(home.ToLowerInvariant()))).Replace("-","");
    var ms=new MutexSecurity(); ms.AddAccessRule(new MutexAccessRule(sid,MutexRights.FullControl,AccessControlType.Allow));
    var es=new EventWaitHandleSecurity(); es.AddAccessRule(new EventWaitHandleAccessRule(sid,EventWaitHandleRights.FullControl,AccessControlType.Allow));
    bool created;
    Focus=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\en-agent-focus-"+key,out created,es);
    Owner=new Mutex(false,"Local\\en-agent-owner-"+key,out created,ms);
    bool acquired;try{acquired=Owner.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}
    if(!acquired)Focus.Set();
    return acquired;
  }
}
'@
$consoleWindow = [EnAgentLauncherWindow]::GetConsoleWindow()
if ($consoleWindow -ne [IntPtr]::Zero) { [void][EnAgentLauncherWindow]::ShowWindow($consoleWindow,0) }
function Read-LauncherLog([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return '' }
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } catch [IO.IOException] { return '' }
}
function Write-LauncherPreferences($Value) {
  $temporary=$preferences+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
  if (Test-Path -LiteralPath $preferences) { [IO.File]::Replace($temporary,$preferences,$null) }
  else { [IO.File]::Move($temporary,$preferences) }
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
[System.Windows.Forms.Application]::EnableVisualStyles()
try {
  $HomeDirectory = [IO.Path]::GetFullPath($HomeDirectory)
  $ownsLauncher = [EnAgentLauncherWindow]::Acquire($HomeDirectory)
  if (!$ownsLauncher) { return }
  $focusTimer = New-Object System.Windows.Forms.Timer
  $focusTimer.Interval = 250
  $focusTimer.Add_Tick({
    if ([EnAgentLauncherWindow]::Focus.WaitOne(0)) {
      foreach ($window in [System.Windows.Forms.Application]::OpenForms) {
        [void][EnAgentLauncherWindow]::ShowWindow($window.Handle,9)
        [void][EnAgentLauncherWindow]::SetForegroundWindow($window.Handle)
        $window.Activate()
      }
    }
  })
  $focusTimer.Start()
  $state = Get-Content -LiteralPath (Join-Path $HomeDirectory 'state.json') -Raw | ConvertFrom-Json
  if ($state.current -notmatch '^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$') { throw 'Некорректная установленная версия.' }
  $bundle = Join-Path $HomeDirectory ('releases\' + $state.current)
  $node = Join-Path $bundle 'bin\node.exe'
  $manifest = Get-Content -LiteralPath (Join-Path $bundle 'release.json') -Raw | ConvertFrom-Json
  if ($manifest.launcherPath -ne 'launcher/src/cli.mjs') { throw 'Неподдерживаемая точка запуска комплекта.' }
  $cli = Join-Path $bundle $manifest.launcherPath
  $picker = New-Object System.Windows.Forms.FolderBrowserDialog
  $picker.Description = 'Выберите папку игры. Для новой игры создайте пустую папку.'
  $picker.ShowNewFolderButton = $true
  $preferences = Join-Path $HomeDirectory 'preferences.json'
  $settings = @{}
  if (Test-Path -LiteralPath $preferences) { $existing = Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json; foreach ($property in $existing.PSObject.Properties) { $settings[$property.Name] = $property.Value } }
  if (!$ResumeLastGame) {
    $browserForm = New-Object System.Windows.Forms.Form
    $browserForm.Text = 'Браузер агента — en-agent'; $browserForm.Width = 520; $browserForm.Height = 245; $browserForm.StartPosition = 'CenterScreen'
    $browserForm.Add_Shown({ [void][EnAgentLauncherWindow]::ShowWindow($browserForm.Handle,5); $browserForm.Activate() })
    $browserLabel = New-Object System.Windows.Forms.Label
    $browserLabel.Text = 'Один браузер для действий агента и входа Encounter. GUI откроется в вашем браузере по умолчанию.'; $browserLabel.SetBounds(16,16,470,45); $browserForm.Controls.Add($browserLabel)
    $browserSelect = New-Object System.Windows.Forms.ComboBox; $browserSelect.DropDownStyle = 'DropDownList'; $browserSelect.SetBounds(16,70,470,28)
    $browserIds = @('auto','chrome','msedge','chromium','firefox')
    $browserSelect.Items.AddRange(@('Автоматически — найти установленный','Google Chrome','Microsoft Edge','Chromium (Playwright, если установлен)','Firefox (Playwright, если установлен)'))
    $selectedBrowser = [Array]::IndexOf($browserIds,[string]$settings.browser); if ($selectedBrowser -lt 0) { $selectedBrowser = 0 }; $browserSelect.SelectedIndex = $selectedBrowser
    $browserForm.Controls.Add($browserSelect)
    $browserHint = New-Object System.Windows.Forms.Label; $browserHint.Text = 'Выбор сохраняется для всех игр. Личный профиль браузера не используется.'; $browserHint.SetBounds(16,110,470,40); $browserForm.Controls.Add($browserHint)
    $browserContinue = New-Object System.Windows.Forms.Button; $browserContinue.Text = 'Продолжить'; $browserContinue.SetBounds(350,155,135,32); $browserContinue.DialogResult = 'OK'; $browserForm.Controls.Add($browserContinue); $browserForm.AcceptButton = $browserContinue
    if ($browserForm.ShowDialog() -ne 'OK') { $browserForm.Dispose(); return }
    $settings.browser = $browserIds[$browserSelect.SelectedIndex]; $browserForm.Dispose()
    Write-LauncherPreferences $settings
  }
  if (Test-Path -LiteralPath $preferences) { $picker.SelectedPath = (Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json).game }
  if (!$ResumeLastGame -or !$picker.SelectedPath) {
    if ($picker.ShowDialog() -ne 'OK') { return }
  }
  $game = $picker.SelectedPath
  $name = $null
  if (!(Test-Path -LiteralPath (Join-Path $game '.en-agent\project.json'))) {
    $name = [Microsoft.VisualBasic.Interaction]::InputBox('Название новой игры', 'en-agent', (Split-Path $game -Leaf))
    if ([string]::IsNullOrWhiteSpace($name)) { return }
  }
  $request = Join-Path $HomeDirectory 'launch-request.json'
  [IO.File]::WriteAllText($request, (@{game=$game;name=$name} | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  $outFile = Join-Path $HomeDirectory 'launcher-output.log'
  $errFile = Join-Path $HomeDirectory 'launcher-error.log'
  # These arguments are Windows file paths; quotes cannot occur in path components.
  $arguments = '"' + $cli + '" --home "' + $HomeDirectory + '" --request "' + $request + '" --parent-pid ' + $PID + ' --parent-birth ' + (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $null = $process.Handle
  $form = New-Object System.Windows.Forms.Form
  $form.Add_Shown({ [void][EnAgentLauncherWindow]::ShowWindow($form.Handle,5); $form.Activate() })
  $form.Text = 'en-agent'; $form.Width = 580; $form.Height = 390
  $form.StartPosition = 'CenterScreen'
  $label = New-Object System.Windows.Forms.Label
  $label.Left = 16; $label.Top = 16; $label.Width = 530; $label.Height = 110
  $label.Text = 'Запускается OpenCode. Готовый интерфейс откроется в браузере.'
  $form.Controls.Add($label)
  $stop = New-Object System.Windows.Forms.Button
  $stop.Text = 'Завершить работу'; $stop.Left = 16; $stop.Top = 135; $stop.Width = 180
  $form.Controls.Add($stop)
  $accountButton = New-Object System.Windows.Forms.Button
  $accountButton.Text = 'Аккаунт Encounter'; $accountButton.Left = 215; $accountButton.Top = 135; $accountButton.Width = 190
  $accountButton.Enabled = [bool]$manifest.accountPath
  $form.Controls.Add($accountButton)
  $exaButton = New-Object System.Windows.Forms.Button; $exaButton.Text = 'Поиск Exa'; $exaButton.SetBounds(16,270,180,32); $form.Controls.Add($exaButton)
  $exaButton.Add_Click({
    . (Join-Path $bundle 'launcher/src/Exa.ps1')
    Show-EnAgentExa $form $node $bundle $HomeDirectory
  })
  $settingsButton = New-Object System.Windows.Forms.Button
  $settingsButton.Text = 'Настройки'; $settingsButton.SetBounds(16,180,180,32); $form.Controls.Add($settingsButton)
  $settingsButton.Add_Click({
    $active = Get-Content -LiteralPath (Join-Path $HomeDirectory 'state.json') -Raw | ConvertFrom-Json
    $activeBundle = Join-Path $HomeDirectory ('releases\' + $active.current)
    $available = @(& $node (Join-Path $activeBundle 'launcher/src/browser-choice.mjs') $activeBundle | ConvertFrom-Json)
    $dialog = New-Object System.Windows.Forms.Form; $dialog.Text = 'Общие настройки'; $dialog.SetBounds(0,0,520,230); $dialog.StartPosition = 'CenterParent'
    $info = New-Object System.Windows.Forms.Label; $info.SetBounds(16,16,475,55)
    $info.Text = 'Комплект: ' + $active.current + '. Подготовлено обновление: ' + $active.pending
    if (Test-Path (Join-Path $HomeDirectory 'status.json')) { $currentStatus = Get-Content (Join-Path $HomeDirectory 'status.json') -Raw | ConvertFrom-Json; $info.Text += "`r`nБраузер: " + $currentStatus.browser + '. Обновление: ' + $currentStatus.update }
    $dialog.Controls.Add($info)
    $select = New-Object System.Windows.Forms.ComboBox; $select.DropDownStyle='DropDownList'; $select.SetBounds(16,80,475,30)
    $choices = @('auto') + @($available | ForEach-Object { $_.id }); [void]$select.Items.Add('Автоматически')
    foreach ($item in $available) { [void]$select.Items.Add($item.label) }
    $prefs = Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json
    $index = [Array]::IndexOf($choices,[string]$prefs.browser); if ($index -lt 0) { $index=0 }; $select.SelectedIndex=$index; $dialog.Controls.Add($select)
    $apply = New-Object System.Windows.Forms.Button; $apply.Text='Применить'; $apply.SetBounds(330,135,160,32); $dialog.Controls.Add($apply)
    $apply.Add_Click({
      if ([System.Windows.Forms.MessageBox]::Show('OpenCode и браузер агента будут перезапущены. Завершите текущую работу. Продолжить?','Смена браузера','YesNo','Warning') -ne 'Yes') { return }
      $prefs.browser=$choices[$select.SelectedIndex]
      Write-LauncherPreferences $prefs
      [IO.File]::WriteAllText((Join-Path $HomeDirectory 'restart.request'),'restart')
      $dialog.Close()
    })
    [void]$dialog.ShowDialog($form); $dialog.Dispose()
  })
  $logButton = New-Object System.Windows.Forms.Button; $logButton.Text='Журнал'; $logButton.SetBounds(215,180,190,32); $form.Controls.Add($logButton)
  $logButton.Add_Click({
    $logPath = Join-Path $HomeDirectory ('diagnostics\events-' + [DateTime]::UtcNow.ToString('yyyy-MM-dd') + '.jsonl')
    if (Test-Path -LiteralPath $logPath) { Start-Process notepad.exe -ArgumentList ('"' + $logPath + '"') }
  })
  $exportButton = New-Object System.Windows.Forms.Button; $exportButton.Text='Экспорт диагностики'; $exportButton.SetBounds(16,225,180,32); $form.Controls.Add($exportButton)
  $exportButton.Add_Click({
    & $node (Join-Path $bundle 'launcher/src/diagnostics.mjs') $HomeDirectory (Join-Path $HomeDirectory 'diagnostic-export.json')
    [void][System.Windows.Forms.MessageBox]::Show(('Файл: ' + (Join-Path $HomeDirectory 'diagnostic-export.json')),'Диагностика')
  })
  $retry = New-Object System.Windows.Forms.Button; $retry.Text='Повторить запуск'; $retry.SetBounds(215,225,190,32); $retry.Enabled=$false; $form.Controls.Add($retry)
  $retry.Add_Click({
    $script:process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $null = $script:process.Handle
    $retry.Enabled=$false; $stop.Enabled=$true; $timer.Start()
  })

  $accountButton.Add_Click({ [IO.File]::WriteAllText((Join-Path $HomeDirectory 'account.request'), 'open') })
  $stop.Add_Click({ [IO.File]::WriteAllText((Join-Path $HomeDirectory 'stop.request'), 'stop'); $stop.Enabled = $false; $label.Text = 'Завершение работы…' })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 500
  $timer.Add_Tick({
    if (!$accountButton.Enabled) {
      $activeState = Get-Content -LiteralPath (Join-Path $HomeDirectory 'state.json') -Raw | ConvertFrom-Json
      $activeManifest = Get-Content -LiteralPath (Join-Path $HomeDirectory ('releases\' + $activeState.current + '\release.json')) -Raw | ConvertFrom-Json
      $accountButton.Enabled = [bool]$activeManifest.accountPath
    }
    if (Test-Path -LiteralPath (Join-Path $HomeDirectory 'status.json')) {
      try { $status = Get-Content -LiteralPath (Join-Path $HomeDirectory 'status.json') -Raw | ConvertFrom-Json
        $label.Text = 'Этап: ' + $status.stage + ' | Комплект: ' + $status.version + "`r`n"
        if ($status.mcp) { foreach ($item in $status.mcp.PSObject.Properties) { $label.Text += $item.Name + ': ' + $item.Value + '  ' } }
        $label.Text += "`r`nОшибка: " + $status.category
      } catch {}
    }
    if (!(Test-Path -LiteralPath (Join-Path $HomeDirectory 'status.json')) -and (Test-Path -LiteralPath $outFile)) { $text = (Read-LauncherLog $outFile); if ($text) { $label.Text = $text } }
    if ($process.HasExited) {
      $process.WaitForExit()
      $timer.Stop(); $stop.Enabled = $false; $retry.Enabled = $true
      if ($process.ExitCode -ne 0) { $label.Text = (Read-LauncherLog $errFile) }
      else { $form.Close() }
    }
  })
  $form.Add_FormClosing({
    if (!$process.HasExited) {
      $_.Cancel = $true
      [IO.File]::WriteAllText((Join-Path $HomeDirectory 'stop.request'), 'stop')
      $label.Text = 'Ожидание остановки OpenCode…'
    }
  })
  $timer.Start(); [void]$form.ShowDialog(); $timer.Dispose()
} catch {
  [void][System.Windows.Forms.MessageBox]::Show('Не удалось запустить комплект. Проверьте установку и диагностику.', 'en-agent', 'OK', 'Error')
} finally {
  if ($focusTimer) { $focusTimer.Stop(); $focusTimer.Dispose() }
  if ($ownsLauncher) { [EnAgentLauncherWindow]::Owner.ReleaseMutex() }
  if ([EnAgentLauncherWindow]::Owner) { [EnAgentLauncherWindow]::Owner.Dispose() }
  if ([EnAgentLauncherWindow]::Focus) { [EnAgentLauncherWindow]::Focus.Dispose() }
}
