param([string]$Launcher = (Join-Path $PSScriptRoot '..\Launch.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Launcher parse failed' }
$function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-LauncherLog'}, $true)
if (!$function) { throw 'Read-LauncherLog missing' }
Invoke-Expression $function.Extent.Text
$path = Join-Path ([IO.Path]::GetTempPath()) ('en-agent-log-' + [guid]::NewGuid() + '.txt')
$writer = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes('OpenCode ready')
  $writer.Write($bytes,0,$bytes.Length); $writer.Flush()
  if ((Read-LauncherLog $path) -ne 'OpenCode ready') { throw 'Cannot read while redirect writer is open' }
  if ((Read-LauncherLog ($path + '.missing')) -ne '') { throw 'Missing log must be tolerated' }
  Write-Output 'PASS: launcher reads log while redirect writer holds it open'
} finally { $writer.Dispose(); Remove-Item -LiteralPath $path }
