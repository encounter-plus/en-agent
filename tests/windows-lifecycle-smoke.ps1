param([Parameter(Mandatory=$true)][string]$HomeDirectory)
$ErrorActionPreference='Stop'
$HomeDirectory=[IO.Path]::GetFullPath($HomeDirectory)
if ($HomeDirectory -notlike '*\.local\*') { throw 'Use a disposable .local installation' }
$exe=Join-Path $HomeDirectory 'en-agent.exe'
$previousNoBrowser=$env:EN_AGENT_NO_BROWSER
$env:EN_AGENT_NO_BROWSER='1'
$statusPath=Join-Path $HomeDirectory 'status.json'
$lockPath=Join-Path $HomeDirectory 'launcher.lock\owner.json'
function Wait-Condition([scriptblock]$Condition,[int]$Seconds=45) {
  $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) { if (& $Condition) { return }; Start-Sleep -Milliseconds 250 }
  throw 'Timed out waiting for local launcher state'
}
function Start-TestLauncher {
  if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath }
  $script:wrapper=Start-Process -FilePath $exe -ArgumentList '--resume' -WindowStyle Hidden -PassThru
  Wait-Condition { if (Test-Path -LiteralPath $statusPath) { try { (Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json).stage -eq 'ready' } catch { $false } } }
  $script:owner=Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  $script:gui=Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$wrapper.Id) | Select-Object -First 1
  if (!$gui) { throw 'Native wrapper lost its GUI child' }
}
try {
  Start-TestLauncher
  $first=$owner.pid
  $duplicates=1..3 | ForEach-Object { Start-Process -FilePath $exe -ArgumentList '--resume' -WindowStyle Hidden -PassThru }
  foreach ($duplicate in $duplicates) { if (!$duplicate.WaitForExit(15000)) { throw 'Duplicate launcher did not forward focus and exit' } }
  if ((Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json).pid -ne $first) { throw 'Duplicate launcher replaced owner' }
  $prefsPath=Join-Path $HomeDirectory 'preferences.json'
  $prefs=Get-Content -LiteralPath $prefsPath -Raw | ConvertFrom-Json
  $prefs | Add-Member -NotePropertyName browser -NotePropertyValue 'msedge' -Force
  [IO.File]::WriteAllText($prefsPath,($prefs | ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $HomeDirectory 'restart.request'),'restart')
  Wait-Condition { $current=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json; $current.stage -eq 'ready' -and $current.browser -eq 'msedge' }
  if ((Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json).pid -ne $first) { throw 'Browser restart lost installation ownership' }
  $engine=Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$owner.pid) | Where-Object { $_.Name -eq 'opencode.exe' } | Select-Object -First 1
  if (!$engine) { throw 'OpenCode child not found' }
  Stop-Process -Id $engine.ProcessId -Force
  Wait-Condition { (Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json).stage -eq 'error' }
  Wait-Condition { !(Test-Path -LiteralPath $lockPath) }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $window=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$gui.ProcessId)))
  $retry=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Повторить запуск')))
  if (!$retry) { throw 'Retry button missing' }
  Wait-Condition { $retry.Current.IsEnabled }
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class EnSmokeClick { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr w,IntPtr l); }'
  $exportsBefore=@(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'en-agent-support-*' | ForEach-Object FullName)
  $export=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Отправить журнал')))
  if (!$export -or !$export.Current.NativeWindowHandle) { throw 'Support export button missing' }
  [void][EnSmokeClick]::SendMessage([IntPtr]$export.Current.NativeWindowHandle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
  $support=@(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'en-agent-support-*' | Where-Object { $_.FullName -notin $exportsBefore })
  if ($support.Count -ne 1) { throw 'Support button must create one report folder' }
  foreach ($file in @('diagnostic-export.json','launcher-error.log','README.txt')) { if (!(Test-Path -LiteralPath (Join-Path $support[0].FullName $file))) { throw "Support file missing after runtime crash: $file" } }
  if (!$retry.Current.NativeWindowHandle) { throw 'Retry native button handle missing' }
  [void][EnSmokeClick]::SendMessage([IntPtr]$retry.Current.NativeWindowHandle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
  Wait-Condition { (Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json).stage -eq 'ready' }
  Wait-Condition { $s=Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json; $s.skills.status -and $s.skills.status -ne 'checking' -and $s.app.status -ne 'checking' }
  $before=(Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json).time
  $check=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Проверить обновления')))
  if (!$check.Current.NativeWindowHandle) { throw 'Update button missing' }
  [void][EnSmokeClick]::SendMessage([IntPtr]$check.Current.NativeWindowHandle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
  Wait-Condition {
    $s=Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
    $s.time -gt $before -and $s.skills.status -eq 'current' -and $s.app.status -and $s.app.status -ne 'checking'
  }
  $owner=Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  # Abrupt GUI death: child supervisor must stop OpenCode and release the lock.
  Stop-Process -Id $gui.ProcessId -Force
  Wait-Condition { !(Test-Path -LiteralPath $lockPath) }
  if (!$wrapper.WaitForExit(15000)) { throw 'Wrapper remained after GUI crash' }
  Start-TestLauncher
  # Abrupt Node death leaves a lock. The next launch must reclaim only this dead owner.
  Stop-Process -Id $owner.pid -Force
  Stop-Process -Id $gui.ProcessId -Force
  [void]$wrapper.WaitForExit(15000)
  Start-TestLauncher
  [IO.File]::WriteAllText((Join-Path $HomeDirectory 'stop.request'),'stop')
  if (!$wrapper.WaitForExit(20000)) { throw 'Normal shutdown failed' }
  Wait-Condition { !(Test-Path -LiteralPath $lockPath) }
  Write-Output 'PASS: native EXE, three rapid duplicates, managed Edge restart, OpenCode crash, Support export and Retry buttons, GUI crash cleanup, Node crash recovery, normal shutdown'
} finally {
  $env:EN_AGENT_NO_BROWSER=$previousNoBrowser
  if ($wrapper -and !$wrapper.HasExited) {
    [IO.File]::WriteAllText((Join-Path $HomeDirectory 'stop.request'),'stop')
    [void]$wrapper.WaitForExit(10000)
    if (!$wrapper.HasExited -and $gui) { Stop-Process -Id $gui.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}
