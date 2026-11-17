param([string]$Launcher = (Join-Path $PSScriptRoot '..\Launch.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Launcher parse failed' }
$function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-LauncherPreferences'}, $true)
if (!$function) { throw 'Write-LauncherPreferences missing' }
Invoke-Expression $function.Extent.Text
$directory = Join-Path ([IO.Path]::GetTempPath()) ('en-agent-preferences-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($directory)
$preferences = Join-Path $directory 'preferences.json'
try {
  $settings = @{ browser = 'auto'; game = 'synthetic game'; custom = 'preserved' }
  foreach ($browser in @('auto','msedge','chrome')) {
    $settings.browser = $browser
    Write-LauncherPreferences $settings
    $saved = [IO.File]::ReadAllText($preferences) | ConvertFrom-Json
    if ($saved.browser -ne $browser -or $saved.game -ne $settings.game -or $saved.custom -ne 'preserved') { throw 'Preferences were not saved losslessly' }
    if (@(Get-ChildItem -LiteralPath $directory).Count -ne 1) { throw 'Temporary or backup file left behind' }
  }
  Write-Output 'PASS: initial save and repeated browser changes preserve preferences'
} finally {
  Get-ChildItem -LiteralPath $directory -File | Remove-Item
  Remove-Item -LiteralPath $directory
}
