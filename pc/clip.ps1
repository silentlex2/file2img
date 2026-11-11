param(
  [string]$Png
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($Png)) { throw 'missing -Png' }
if (-not [System.IO.File]::Exists($Png)) { throw ('file not found: ' + $Png) }

$bytes = [System.IO.File]::ReadAllBytes($Png)
$imgStream = New-Object System.IO.MemoryStream (,$bytes)
$pngStream = New-Object System.IO.MemoryStream (,$bytes)
$img = $null

try {
  $img = [System.Drawing.Image]::FromStream($imgStream)
  $dobj = New-Object System.Windows.Forms.DataObject
  $dobj.SetData([System.Windows.Forms.DataFormats]::Bitmap, $img)
  $dobj.SetData('PNG', $false, $pngStream)
  $dobj.SetData('F2I_LOCAL_ORIGIN', '1')
  [System.Windows.Forms.Clipboard]::SetDataObject($dobj, $true)
  Write-Output ('CLIPBOARD_OK {0}x{1} {2}B' -f $img.Width, $img.Height, $bytes.Length)
} finally {
  if ($null -ne $img) { $img.Dispose() }
  $imgStream.Dispose()
  $pngStream.Dispose()
}
