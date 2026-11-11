param(
  [string]$OutDir = $(
    if ($env:F2I_RECV) { $env:F2I_RECV }
    elseif ($env:F2I_IN) { Join-Path $env:F2I_IN 'recv' }
    else { Join-Path ([Environment]::GetFolderPath('Desktop')) 'f2i\recv' }
  ),
  [int]$Seconds = 86400,
  [string]$Password = ''
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('Win32.ClipSeq4' -as [type])) {
  Add-Type -Namespace Win32 -Name ClipSeq4 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetClipboardSequenceNumber();
'@
}

$node = (Get-Command node).Source
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$dec  = Join-Path $root 'file2img.mjs'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Log($msg, $color = 'Gray') {
  Write-Host ("[" + (Get-Date).ToString('HH:mm:ss') + "] " + $msg) -ForegroundColor $color
}

function Sha([byte[]]$b) {
  return [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($b))
}

function Start-RestoreDaemon {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $argList = "`"$dec`" restore-daemon `"$OutDir`""
  if (-not [string]::IsNullOrEmpty($Password)) {
    $escapedPw = $Password.Replace('"', '\"')
    $argList += " --password `"$escapedPw`""
  }
  $psi.Arguments = $argList
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $psi.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  # 用 UTF-8 无 BOM 写入标准输入，避免中文路径乱码
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $stdinWriter = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, $utf8NoBom)
  $stdinWriter.AutoFlush = $true

  $ready = $proc.StandardOutput.ReadLine()
  if ($ready -ne 'READY') {
    throw "restore-daemon 启动异常: $ready"
  }
  return @{ proc = $proc; writer = $stdinWriter }
}

$script:daemon = Start-RestoreDaemon

function Invoke-RestorePath([string]$pngPath) {
  if ($null -eq $script:daemon -or $script:daemon.proc.HasExited) {
    $script:daemon = Start-RestoreDaemon
  }
  $b64Path = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pngPath))
  $script:daemon.writer.WriteLine("B64:$b64Path")
  $line = $script:daemon.proc.StandardOutput.ReadLine()
  if ([string]::IsNullOrEmpty($line)) {
    return @{ status = 'SKIP'; msg = 'daemon closed' }
  }
  if ($line -match '^OK:(.+)$') {
    $dest = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[1]))
    return @{ status = 'OK'; dest = $dest; size = (Get-Item -LiteralPath $dest).Length }
  }
  if ($line -match '^PART:([^:]+):(.+)$') {
    $prog = $Matches[1]
    $name = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[2]))
    return @{ status = 'PART'; progress = $prog; name = $name }
  }
  if ($line -match '^(ERR|SKIP):(.+)$') {
    $msg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[2]))
    return @{ status = $Matches[1]; msg = $msg }
  }
  return @{ status = 'SKIP'; msg = $line }
}

function Read-ClipboardPngBytes {
  # 1. 优先读取原生 PNG 流（避免 GDI+ 二次重编码，速度更快且像素 100% 保真）
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsData('PNG')) {
      $raw = [System.Windows.Forms.Clipboard]::GetData('PNG')
      if ($raw -is [System.IO.Stream]) {
        $ms = New-Object System.IO.MemoryStream
        try {
          $raw.CopyTo($ms)
          return @{ source = 'PNG流'; bytes = $ms.ToArray() }
        } finally {
          $ms.Dispose()
          $raw.Dispose()
        }
      } elseif ($raw -is [byte[]]) {
        return @{ source = 'PNG流'; bytes = $raw }
      }
    }
  } catch { }

  # 2. 退化读取 Bitmap（豆包同步过来通常是位图）
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($null -ne $img) {
        $ms = New-Object System.IO.MemoryStream
        try {
          $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          return @{ source = "Bitmap $($img.Width)x$($img.Height)"; bytes = $ms.ToArray() }
        } finally {
          $ms.Dispose()
          try { $img.Dispose() } catch { }
        }
      }
    }
  } catch { }

  return $null
}

function Report-Result($r) {
  switch ($r.status) {
    'OK'   { Log ("  还原 -> " + $r.dest + "  (" + $r.size + " B)") 'Green' }
    'PART' { Log ("  收到分片 " + $r.progress + " · " + $r.name) 'Cyan' }
    'ERR'  { Log ("  解码失败: " + $r.msg) 'Red' }
    default { Log '  不是载荷图（普通图片，忽略）' 'DarkGray' }
  }
}

Log '剪贴板接收器已启动（常驻解码模式）' 'Cyan'
Log ("输出目录: " + $OutDir) 'DarkGray'
Log '通道优先级: 原生 PNG 流 -> Bitmap 位图 -> FileDrop' 'DarkGray'
Write-Host ''

$lastSeq      = [Win32.ClipSeq4]::GetClipboardSequenceNumber()
$lastClipHash = ''
$hits = 0
$got  = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    $seq = [Win32.ClipSeq4]::GetClipboardSequenceNumber()
    if ($seq -ne $lastSeq) {
      $lastSeq = $seq
      # 等待极短时间让发送方完成剪贴板各格式写入（不丢弃连续事件）
      Start-Sleep -Milliseconds 180

      # 跳过本机 watch.mjs / clip.ps1 刚写入的图片，防止自发自收
      $isLocal = $false
      try { $isLocal = [System.Windows.Forms.Clipboard]::ContainsData('F2I_LOCAL_ORIGIN') } catch { }
      if ($isLocal) {
        Log '检测到本机发出的图片，跳过自收' 'DarkGray'
        continue
      }

      $clip = Read-ClipboardPngBytes
      if ($null -ne $clip -and $clip.bytes.Length -gt 0) {
        $h = Sha $clip.bytes
        if ($h -eq $lastClipHash) { continue }
        $lastClipHash = $h
        $hits++
        Log ($clip.source) 'Yellow'

        $tmp = Join-Path $env:TEMP ('cb_' + [guid]::NewGuid().ToString('N') + '.png')
        try {
          [System.IO.File]::WriteAllBytes($tmp, $clip.bytes)
          $r = Invoke-RestorePath $tmp
          if ($r.status -eq 'OK') { $got++ }
          Report-Result $r
        } finally {
          Remove-Item $tmp -ErrorAction SilentlyContinue
        }
        continue
      }

      # 兜底：FileDrop
      try {
        if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
          foreach ($fp in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
            if (-not (Test-Path -LiteralPath $fp)) { continue }
            $item = Get-Item -LiteralPath $fp
            if ($item.Extension.ToLower() -eq '.png') {
              $fileBytes = [System.IO.File]::ReadAllBytes($fp)
              $h = Sha $fileBytes
              if ($h -eq $lastClipHash) { continue }
              $lastClipHash = $h
              $hits++
              Log ("FileDrop PNG  " + $item.Name) 'Yellow'
              $r = Invoke-RestorePath $fp
              if ($r.status -eq 'OK') { $got++ }
              Report-Result $r
            }
          }
        }
      } catch { }
    }
    Start-Sleep -Milliseconds 200
  }
} finally {
  if ($null -ne $script:daemon) {
    try {
      if (-not $script:daemon.proc.HasExited) {
        $script:daemon.writer.WriteLine('QUIT')
        [void]$script:daemon.proc.WaitForExit(1000)
        if (-not $script:daemon.proc.HasExited) { $script:daemon.proc.Kill() }
      }
      $script:daemon.proc.Dispose()
    } catch { }
  }
}

Log ("结束：捕获 " + $hits + " 次，还原 " + $got + " 个") 'Cyan'
