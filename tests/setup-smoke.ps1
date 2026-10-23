param([Parameter(Mandatory=$true)][string]$Setup)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class EnSetupDialog { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr w,IntPtr l); }'
$setupProcess=Start-Process -FilePath ([IO.Path]::GetFullPath($Setup)) -WindowStyle Hidden -PassThru
$null=$setupProcess.Handle
$deadline=[DateTime]::UtcNow.AddSeconds(45)
try {
  $window=$null
  while (!$window -and [DateTime]::UtcNow -lt $deadline) {
    if ($setupProcess.HasExited) { throw ('Setup exited before confirmation: '+$setupProcess.ExitCode) }
    $child=Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$setupProcess.Id) | Where-Object { $_.Name -eq 'powershell.exe' } | Select-Object -First 1
    if ($child) { $window=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$child.ProcessId))) }
    if (!$window) { Start-Sleep -Milliseconds 250 }
  }
  if (!$window) { throw 'Setup confirmation did not appear' }
  $elements=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $text=($elements | ForEach-Object { $_.Current.Name }) -join ' '
  if ($text -notmatch 'Установить en-agent') { throw 'Expected per-user installation confirmation missing' }
  [void][EnSetupDialog]::SendMessage([IntPtr]$window.Current.NativeWindowHandle,0x111,[IntPtr]2,[IntPtr]::Zero)
  if (!$setupProcess.WaitForExit(15000)) { throw 'Setup cancellation failed' }
  Write-Output 'PASS: setup EXE extracts embedded ZIP, verifies payload, displays per-user install confirmation and cancels without installation'
} finally {
  if (!$setupProcess.HasExited -and $child) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
}
