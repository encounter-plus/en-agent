param([string]$Launcher = (Join-Path $PSScriptRoot '..\Launch.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Get-LauncherStatusText','Set-LauncherStatusText')) {
  $function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  Invoke-Expression $function.Extent.Text
}

Add-Type -AssemblyName System.Windows.Forms
$view = New-Object Windows.Forms.RichTextBox
$null = $view.Handle
$normal = $view.ForeColor.ToArgb()
function Assert-Rendering([string]$Json,[int]$ExpectedErrors) {
  $status = $Json | ConvertFrom-Json
  Set-LauncherStatusText $view (Get-LauncherStatusText $status)
  $prefixes = [regex]::Matches($view.Text, '(?m)^Ошибка(?=:)')
  if ($prefixes.Count -ne $ExpectedErrors) { throw "Unexpected error count in $($view.Text)" }
  foreach ($prefix in $prefixes) {
    $view.Select($prefix.Index,$prefix.Length)
    if ($view.SelectionColor.ToArgb() -ne [Drawing.Color]::Firebrick.ToArgb()) { throw 'Error word must be red' }
    $view.Select($prefix.Index+$prefix.Length,2)
    if ($view.SelectionColor.ToArgb() -ne $normal) { throw 'Error punctuation and details must retain the normal color' }
  }
  $view.Select(0,4)
  if ($view.SelectionColor.ToArgb() -ne $normal) { throw 'Stage must retain the normal color' }
}
try {
  Assert-Rendering '{"stage":"verify"}' 0
  Assert-Rendering '{"stage":"ready","category":"network","app":{"status":"current"},"skills":{"status":"checking"}}' 0
  Assert-Rendering '{"stage":"error","category":"startup"}' 1
  Assert-Rendering '{"stage":"error"}' 1
  Assert-Rendering '{"stage":"skills","app":{"status":"failed"},"skills":{"status":"failed","category":"bundle"}}' 2
  Assert-Rendering '{"stage":"ready","app":{"status":"unconfigured"},"skills":{"status":"cancelled"}}' 0
  Set-LauncherStatusText $view 'Ошибка: Процесс en-agent завершился с кодом 1.'
  $view.Select(0,6)
  if ($view.SelectionColor.ToArgb() -ne [Drawing.Color]::Firebrick.ToArgb()) { throw 'Process failure must be red' }
  Set-LauncherStatusText $view 'Повторный запуск…'
  $view.SelectAll()
  if ($view.SelectionColor.ToArgb() -ne $normal) { throw 'Retry must clear error formatting' }
  Write-Output 'PASS: normal status, failures, update checks and retry on a native RichTextBox'
} finally { $view.Dispose() }
