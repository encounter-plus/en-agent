param([int]$WindowProcess)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$processCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$WindowProcess)
$nameCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'Аккаунт Encounter — en-agent')
$condition = [Windows.Automation.AndCondition]::new($processCondition,$nameCondition)
$deadline=(Get-Date).AddSeconds(25); $window=$null
while (!$window -and (Get-Date) -lt $deadline) { $window=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,$condition); Start-Sleep -Milliseconds 150 }
if (!$window) { throw 'Account window not found' }
$editCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
$edits=@()
while($edits.Count -ne 3 -and (Get-Date) -lt $deadline) { $edits=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,$editCondition)) | Sort-Object { $_.Current.BoundingRectangle.Top }; Start-Sleep -Milliseconds 150 }
if($edits.Count -ne 3 -or !$edits[2].Current.IsPassword){$details=$edits | ForEach-Object { 'type='+$_.Current.ControlType.ProgrammaticName+' password='+$_.Current.IsPassword+' top='+$_.Current.BoundingRectangle.Top };throw ('Expected three fields and a masked password: count='+$edits.Count+' '+($details -join ';'))}
$edits[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('demo.en.cx')
$edits[1].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('Synthetic Author')
$edits[2].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('synthetic-only')
$buttonCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'Войти и сохранить')
$button=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,$buttonCondition)
$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
'Native fields, password masking and login button verified'
