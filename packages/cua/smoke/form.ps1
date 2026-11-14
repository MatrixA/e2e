# A deterministic WinForms window for the @e2e-dev/cua smoke test. WinForms
# reports each control's Name as its UI Automation AutomationId.
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'e2e smoke'
$form.Width = 420
$form.Height = 240
$form.StartPosition = 'CenterScreen'

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Your name'
$label.Location = New-Object System.Drawing.Point(16, 16)
$label.AutoSize = $true

$name = New-Object System.Windows.Forms.TextBox
$name.Name = 'NameField'
$name.AccessibleName = 'Your name'
$name.Location = New-Object System.Drawing.Point(16, 40)
$name.Width = 360

$agree = New-Object System.Windows.Forms.CheckBox
$agree.Name = 'AgreeBox'
$agree.Text = 'I agree'
$agree.Location = New-Object System.Drawing.Point(16, 76)

$greet = New-Object System.Windows.Forms.Button
$greet.Name = 'GreetButton'
$greet.Text = 'Greet'
$greet.Location = New-Object System.Drawing.Point(16, 112)

$greeting = New-Object System.Windows.Forms.Label
$greeting.Name = 'Greeting'
$greeting.Text = 'Nobody greeted yet'
$greeting.Location = New-Object System.Drawing.Point(16, 152)
$greeting.AutoSize = $true

$greet.Add_Click({
  if ($agree.Checked) { $greeting.Text = "Hello, $($name.Text)!" } else { $greeting.Text = 'Please agree first' }
})

$form.Controls.AddRange(@($label, $name, $agree, $greet, $greeting))
[void]$form.ShowDialog()
