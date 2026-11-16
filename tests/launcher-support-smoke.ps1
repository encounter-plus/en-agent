param([string]$Launcher = (Join-Path $PSScriptRoot '..\Launch.ps1'))
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Launcher parse failed' }
foreach ($name in @('Read-LauncherLog','Export-LauncherSupport')) {
  $definition=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
  if (!$definition) { throw "Missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('en-agent-support-test-'+[guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($root)
$originalTemp=$env:TEMP; $originalTmp=$env:TMP
try {
  $env:TEMP=$root; $env:TMP=$root
  $testHome=Join-Path $root 'home'; [void][IO.Directory]::CreateDirectory($testHome)
  $bundle=Join-Path $root 'bundle'
  $scripts=Join-Path $bundle 'launcher/src'; [void][IO.Directory]::CreateDirectory($scripts)
  foreach ($file in @('diagnostics.mjs','storage.mjs','process-identity.mjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../src/$file") -Destination $scripts }
  $diagnostics=Join-Path $testHome 'diagnostics'; [void][IO.Directory]::CreateDirectory($diagnostics)
  [IO.File]::WriteAllText((Join-Path $diagnostics 'events-2026-11-16.jsonl'),'{"time":"2026-11-16T01:00:00.000Z","stage":"error","category":"startup","password":"DO-NOT-EXPORT"}')
  foreach ($file in @('launcher-output.log','launcher-error.log','en-agent-launcher-failure.log')) { [IO.File]::WriteAllText((Join-Path $testHome $file),'Синтетическая ошибка запуска') }
  [IO.File]::WriteAllText((Join-Path $testHome 'preferences.json'),'DO-NOT-EXPORT')
  $nodePath=(Get-Command node.exe).Source
  $first=Export-LauncherSupport $testHome $nodePath $bundle $null
  foreach ($file in @('diagnostic-export.json','launcher-output.log','launcher-error.log','en-agent-launcher-failure.log','README.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $first $file))) { throw "Missing support file: $file" }
  }
  if ((Get-Content -LiteralPath (Join-Path $first 'diagnostic-export.json') -Raw).Contains('DO-NOT-EXPORT')) { throw 'Diagnostic export leaked an unknown field' }
  if (Test-Path -LiteralPath (Join-Path $first 'preferences.json')) { throw 'Preferences must not be copied' }
  $fallback=Join-Path $root 'fallback.log'; [IO.File]::WriteAllText($fallback,'Fallback startup cause')
  $second=Export-LauncherSupport $testHome '' '' $fallback
  if ($first -eq $second) { throw 'Repeated exports must preserve earlier reports' }
  if ((Get-Content -LiteralPath (Join-Path $second 'en-agent-launcher-failure.log') -Raw) -ne 'Fallback startup cause') { throw 'Fallback failure log missing' }
  if ((Get-Content -LiteralPath (Join-Path $first 'launcher-error.log') -Raw -Encoding UTF8) -ne 'Синтетическая ошибка запуска') { throw 'UTF-8 log damaged' }
  Write-Output 'PASS: diagnostic export, launcher logs, UTF-8, unique folders, missing runtime fallback and excluded host state'
} finally {
  $env:TEMP=$originalTemp; $env:TMP=$originalTmp
  $resolved=[IO.Path]::GetFullPath($root)
  if ((Split-Path $resolved -Leaf) -notlike 'en-agent-support-test-*' -or (Split-Path $resolved -Parent) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')) { throw 'Unsafe test cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
