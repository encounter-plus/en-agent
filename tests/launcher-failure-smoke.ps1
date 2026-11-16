param([string]$Launcher = (Join-Path $PSScriptRoot '..\Launch.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Launcher parse failed' }
$function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-LauncherFailureMessage'}, $true)
if (!$function) { throw 'Failure reporting function missing' }
Invoke-Expression $function.Extent.Text
$directory = Join-Path ([IO.Path]::GetTempPath()) ('en-agent-failure-test-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($directory)
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
try {
  try { throw (New-Object IO.IOException('Synthetic restart failure', (New-Object InvalidOperationException('Synthetic inner cause')))) } catch { $failure = $_ }
  $log = Join-Path $directory 'en-agent-launcher-failure.log'
  foreach ($attempt in 1..2) {
    $message = Get-LauncherFailureMessage $failure $directory 'Сохранение настроек браузера'
    if (!$message.Contains('Synthetic restart failure') -or !$message.Contains($log)) { throw 'Dialog must contain cause and saved log path' }
  }
  $entries = @(Get-Content -LiteralPath $log -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
  if ($entries.Count -ne 2) { throw 'Repeated failures must append, not overwrite' }
  if ($entries[0].exceptions[1].message -ne 'Synthetic inner cause' -or !$entries[0].line -or !$entries[0].stack) { throw 'Exception chain and location missing' }
  if ($entries[0].stage -ne 'Сохранение настроек браузера') { throw 'Stage missing or UTF-8 damaged' }
  # Isolate the fallback log from real launcher diagnostics.
  $env:TEMP = $directory; $env:TMP = $directory
  $message = Get-LauncherFailureMessage $failure (Join-Path $directory 'missing') 'Fallback'
  if (!$message.Contains($log)) { throw 'Fallback path missing' }
  $env:TEMP = Join-Path $directory 'missing'; $env:TMP = $env:TEMP
  $message = Get-LauncherFailureMessage $failure $env:TEMP 'Unavailable'
  if (!$message.Contains('Synthetic restart failure') -or !$message.Contains('Не удалось сохранить лог:')) { throw 'Logging failure must preserve original cause' }
  Write-Output 'PASS: cause, exception chain, location, UTF-8, append, fallback and unavailable log'
} finally {
  $env:TEMP = $originalTemp; $env:TMP = $originalTmp
  Remove-Item -LiteralPath (Join-Path $directory 'en-agent-launcher-failure.log') -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $directory
}
