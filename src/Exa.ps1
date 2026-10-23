function Show-EnAgentExa($Owner, [string]$NodePath, [string]$BundlePath, [string]$InstallHome) {
  $dialog = New-Object System.Windows.Forms.Form
  $dialog.Text = 'Поиск Exa'; $dialog.ClientSize = New-Object System.Drawing.Size(620,500)
  $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'; $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false
  $help = New-Object System.Windows.Forms.Label; $help.SetBounds(20,16,580,145)
  $help.Text = "Exa помогает агенту находить источники в интернете и давать ссылки. Ключ Exa подключает ваш аккаунт поиска; это не ключ модели и не аккаунт Encounter.`r`n`r`n1. Откройте кабинет Exa по ссылке ниже и зарегистрируйтесь или войдите.`r`n2. В разделе API Keys создайте ключ и скопируйте его.`r`n3. Вставьте ключ здесь, проверьте и сохраните. Для замены введите новый ключ и снова нажмите «Сохранить»."
  $dialog.Controls.Add($help)
  $link = New-Object System.Windows.Forms.LinkLabel; $link.Text = 'Открыть кабинет Exa — регистрация и API Keys'; $link.SetBounds(20,166,580,24)
  $link.Add_LinkClicked({ Start-Process 'https://dashboard.exa.ai/api-keys' }); $dialog.Controls.Add($link)
  $caption = New-Object System.Windows.Forms.Label; $caption.Text = 'API-ключ (оставьте поле пустым для проверки сохранённого ключа)'; $caption.SetBounds(20,200,580,24); $dialog.Controls.Add($caption)
  $keyBox = New-Object System.Windows.Forms.TextBox; $keyBox.UseSystemPasswordChar = $true; $keyBox.MaxLength = 2048; $keyBox.SetBounds(20,228,580,28); $dialog.Controls.Add($keyBox)
  $test = New-Object System.Windows.Forms.Button; $test.Text = 'Проверить'; $test.SetBounds(20,270,130,32); $dialog.Controls.Add($test)
  $save = New-Object System.Windows.Forms.Button; $save.Text = 'Сохранить / заменить'; $save.SetBounds(160,270,200,32); $dialog.Controls.Add($save)
  $delete = New-Object System.Windows.Forms.Button; $delete.Text = 'Удалить ключ'; $delete.SetBounds(370,270,150,32); $dialog.Controls.Add($delete)
  $hint = New-Object System.Windows.Forms.Label; $hint.SetBounds(20,312,580,60)
  $hint.Text = "Проверка делает один запрос и расходует лимит Exa по вашему тарифу. Ключ хранится в Windows Credential Manager, а не в папке игры. Сохранённый здесь ключ имеет приоритет над EXA_API_KEY из окружения."
  $dialog.Controls.Add($hint)
  $status = New-Object System.Windows.Forms.Label; $status.SetBounds(20,380,580,54); $status.Text = 'Проверка настроек…'; $dialog.Controls.Add($status)
  $apply = New-Object System.Windows.Forms.Button; $apply.Text = 'Применить и перезапустить'; $apply.SetBounds(20,450,260,32); $apply.Enabled = $false; $dialog.Controls.Add($apply)
  $close = New-Object System.Windows.Forms.Button; $close.Text = 'Закрыть'; $close.SetBounds(470,450,130,32); $dialog.Controls.Add($close)
  $state = @{ process = $null; output = $null; error = $null; started = $null; changed = $false }
  function Start-ExaAction([string]$Action) {
    if ($state.process) { return }
    try {
      $info = New-Object System.Diagnostics.ProcessStartInfo
      $info.FileName = $NodePath
      $helper = Join-Path $BundlePath 'launcher/src/exa.mjs'
      $info.Arguments = '"' + $helper + '" "' + $BundlePath + '" "' + $InstallHome + '"'
      $info.UseShellExecute = $false; $info.CreateNoWindow = $true
      $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
      $info.StandardOutputEncoding = [Text.Encoding]::UTF8; $info.StandardErrorEncoding = [Text.Encoding]::UTF8
      $state.process = New-Object System.Diagnostics.Process; $state.process.StartInfo = $info
      [void]$state.process.Start()
      $state.output = $state.process.StandardOutput.ReadToEndAsync(); $state.error = $state.process.StandardError.ReadToEndAsync()
      $payload = @{action=$Action;key=$keyBox.Text} | ConvertTo-Json -Compress
      $state.process.StandardInput.Write($payload); $state.process.StandardInput.Close(); $state.started = [DateTime]::UtcNow
      $test.Enabled = $false; $save.Enabled = $false; $delete.Enabled = $false; $keyBox.Enabled = $false; $apply.Enabled = $false
      $status.Text = 'Выполняется…'
    } catch {
      if ($state.process) { $state.process.Dispose(); $state.process = $null }
      $status.Text = 'Не удалось выполнить операцию. Проверьте установку en-agent.'
    }
  }
  $test.Add_Click({ Start-ExaAction 'test' })
  $save.Add_Click({ if ([string]::IsNullOrWhiteSpace($keyBox.Text)) { $status.Text = 'Введите новый API-ключ для сохранения.' } else { Start-ExaAction 'save' } })
  $delete.Add_Click({
    if ([System.Windows.Forms.MessageBox]::Show($dialog,'Удалить сохранённый в этой установке ключ? Переменная EXA_API_KEY Windows останется без изменений.','Удаление ключа','YesNo','Question') -eq 'Yes') { Start-ExaAction 'delete' }
  })
  $apply.Add_Click({
    if ([System.Windows.Forms.MessageBox]::Show($dialog,'OpenCode и браузер агента будут перезапущены. Завершите текущую работу перед продолжением.','Применение ключа','YesNo','Warning') -eq 'Yes') {
      [IO.File]::WriteAllText((Join-Path $InstallHome 'restart.request'),'restart'); $dialog.Close()
    }
  })
  $close.Add_Click({ $dialog.Close() })
  $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 150
  $timer.Add_Tick({
    if (!$state.process) { return }
    if (!$state.process.HasExited -and ([DateTime]::UtcNow - $state.started).TotalSeconds -gt 40) { $state.process.Kill() }
    if (!$state.process.HasExited -or !$state.output.IsCompleted -or !$state.error.IsCompleted) { return }
    try {
      $reply = $state.output.GetAwaiter().GetResult() | ConvertFrom-Json
      if (!$reply.message) { throw 'Missing result' }
      $status.Text = $reply.message
      if ($reply.ok -and $reply.changed) { $state.changed = $true; $keyBox.Clear() }
    } catch { $status.Text = 'Операция не завершена. Проверьте подключение и повторите попытку.' }
    finally {
      $state.process.Dispose(); $state.process = $null
      $test.Enabled = $true; $save.Enabled = $true; $delete.Enabled = $true; $keyBox.Enabled = $true; $apply.Enabled = $state.changed
    }
  })
  $dialog.Add_FormClosing({ param($sender,$eventArgs) if ($state.process) { $eventArgs.Cancel = $true; $status.Text = 'Дождитесь завершения операции.' } })
  try { Start-ExaAction 'status'; $timer.Start(); [void]$dialog.ShowDialog($Owner) }
  finally { $timer.Stop(); $timer.Dispose(); $keyBox.Clear(); $dialog.Dispose() }
}
