param([Parameter(Mandatory=$true)][string]$AccountUrl)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EnAgentAccountConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$consoleWindow = [EnAgentAccountConsole]::GetConsoleWindow()
if ($consoleWindow -ne [IntPtr]::Zero) { [void][EnAgentAccountConsole]::ShowWindow($consoleWindow,0) }
[System.Windows.Forms.Application]::EnableVisualStyles()
$endpoint = [Uri]$AccountUrl
if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.AbsolutePath -notmatch '^/account/([a-f0-9]{48})/$') { throw 'Invalid local account endpoint' }
$nonce = $Matches[1]
$origin = $endpoint.GetLeftPart([UriPartial]::Authority)
$created = $false
$windowMutex = [Threading.Mutex]::new($true, 'Local\EnAgentAccount-' + $nonce, [ref]$created)
$focusEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, 'Local\EnAgentAccountFocus-' + $nonce)
if (!$created) { [void]$focusEvent.Set(); $focusEvent.Dispose(); $windowMutex.Dispose(); exit 0 }
$form = New-Object System.Windows.Forms.Form
$form.Add_Shown({ [void][EnAgentAccountConsole]::ShowWindow($form.Handle,5); $form.Activate() })
$form.Text = 'Аккаунт Encounter — en-agent'; $form.Width = 620; $form.Height = 480; $form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
function Add-Field($title,$top,$secret) {
  $label = New-Object System.Windows.Forms.Label; $label.Text = $title; $label.SetBounds(20,$top,550,24); $form.Controls.Add($label)
  $field = New-Object System.Windows.Forms.TextBox; $field.SetBounds(20,($top+26),550,28); $field.UseSystemPasswordChar = $secret; $form.Controls.Add($field); return $field
}
$username = Add-Field 'Логин' 16 $false
$password = Add-Field 'Пароль (хранится в Windows Credential Manager)' 80 $true
$login = New-Object System.Windows.Forms.Button; $login.Text = 'Сохранить аккаунт'; $login.SetBounds(20,152,175,38); $form.Controls.Add($login)
$saved = New-Object System.Windows.Forms.Button; $saved.Text = 'Сохранённый пароль'; $saved.SetBounds(205,152,190,38); $form.Controls.Add($saved)
$forget = New-Object System.Windows.Forms.Button; $forget.Text = 'Забыть аккаунт'; $forget.SetBounds(405,152,165,38); $form.Controls.Add($forget)
$info = New-Object System.Windows.Forms.Label; $info.Text = 'После сохранения откроется браузер агента: логин и пароль заполнятся, Sign in нажмётся автоматически. Если сайт попросит CAPTCHA или вход не завершится — продолжите в браузере. При успехе он закроется. Если домен ещё не выбран, аккаунт сохранится без открытия браузера.'; $info.SetBounds(20,206,550,90); $form.Controls.Add($info)
$status = New-Object System.Windows.Forms.Label; $status.Text = 'Загрузка…'; $status.SetBounds(20,306,550,85); $form.Controls.Add($status)
$back = New-Object System.Windows.Forms.Button; $back.Text = 'Назад'; $back.SetBounds(20,398,110,32); $form.Controls.Add($back)
$back.Add_Click({ $form.Close() })
$script:dirty = $false; $script:actionFailed = $false
$onEdit = { if($script:initialized) { $script:dirty = $true; $status.Text = 'Изменения не сохранены.' } }
$username.Add_TextChanged($onEdit); $password.Add_TextChanged($onEdit)
$username.Enabled = $false; $password.Enabled = $false; $login.Enabled = $false; $saved.Enabled = $false; $forget.Enabled = $false
$script:pending = $null; $script:pendingClient = $null; $script:statusTask = $null; $script:statusClient = $null; $script:initialized = $false
function New-Client {
  $client = New-Object System.Net.WebClient; $client.Encoding = [Text.Encoding]::UTF8
  $client.Headers['Origin'] = $origin; $client.Headers['X-En-Agent-UI'] = $nonce; $client.Headers['Content-Type'] = 'application/json'
  return $client
}
function Send-Action($action,$body) {
  if ($script:pending) { return }
  if ($script:statusClient) { $script:statusClient.CancelAsync(); $script:statusClient.Dispose(); $script:statusClient = $null; $script:statusTask = $null }
  $script:actionFailed = $false
  $username.Enabled = $false; $password.Enabled = $false
  $script:pendingClient = New-Client
  $script:pending = $script:pendingClient.UploadStringTaskAsync([Uri]($AccountUrl+$action), 'POST', ($body | ConvertTo-Json -Compress))
  $password.Clear(); $status.Text = 'Выполняется…'; $login.Enabled = $false; $saved.Enabled = $false; $forget.Enabled = $false
}
$login.Add_Click({ Send-Action 'login' @{username=$username.Text;password=$password.Text;useSaved=$false} })
$saved.Add_Click({ Send-Action 'login' @{username=$username.Text;useSaved=$true} })
$forget.Add_Click({ Send-Action 'forget' @{} })
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 700
$timer.Add_Tick({
  if ($focusEvent.WaitOne(0)) { $form.WindowState = 'Normal'; $form.Show(); $form.Activate() }
  if ($script:pending -and $script:pending.IsCompleted) {
    try { $reply = $script:pending.GetAwaiter().GetResult() | ConvertFrom-Json; if (!$reply.ok) { throw 'Save failed' }; $script:dirty = $false } catch { $script:actionFailed = $true; $status.Text = 'Аккаунт не сохранён. Проверьте данные и попробуйте снова.' }
    $username.Enabled = $true; $password.Enabled = $true
    $script:pending = $null; $script:pendingClient.Dispose(); $script:pendingClient = $null
  }
  if ($script:statusTask -and $script:statusTask.IsCompleted) {
    try {
      $result = $script:statusTask.GetAwaiter().GetResult() | ConvertFrom-Json
      if (!$script:initialized) { $username.Text = $result.username; $script:initialized = $true; $username.Enabled = $true; $password.Enabled = $true }
      if ($script:pending -or $result.busy) { $status.Text = 'Выполняется…' }
      elseif ($script:actionFailed) { $status.Text = 'Аккаунт не сохранён. ' + $result.message }
      elseif ($script:dirty) { $status.Text = 'Изменения не сохранены.' }
      elseif ($result.saved) { $status.Text = 'Аккаунт сохранён.' }
      else { $status.Text = 'Укажите логин и пароль.' }
      $enabled = !$result.busy -and !$script:pending; $login.Enabled = $enabled; $saved.Enabled = $enabled -and $result.saved; $forget.Enabled = $enabled -and $result.saved
    } catch { $status.Text = 'en-agent остановлен или недоступен. Откройте аккаунт из launcher после запуска.' }
    $script:statusTask = $null; $script:statusClient.Dispose(); $script:statusClient = $null
  }
  if (!$script:statusTask) { $script:statusClient = New-Client; $script:statusTask = $script:statusClient.DownloadStringTaskAsync([Uri]($AccountUrl+'status')) }
})
$form.Add_FormClosed({ $timer.Stop(); if ($script:pendingClient) { $script:pendingClient.CancelAsync(); $script:pendingClient.Dispose() }; if ($script:statusClient) { $script:statusClient.CancelAsync(); $script:statusClient.Dispose() } })
try {
$timer.Start(); [void]$form.ShowDialog(); $timer.Dispose()
} finally { $focusEvent.Dispose(); $windowMutex.ReleaseMutex(); $windowMutex.Dispose() }
