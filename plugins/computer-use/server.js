import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

const PS_SCRIPT = String.raw`
param(
  [string]$Action = 'probe',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$ToX = 0,
  [int]$ToY = 0,
  [string]$Button = 'left',
  [int]$Clicks = 1,
  [int]$Times = 1,
  [int]$Delta = 120,
  [int]$HoldMs = 80,
  [int]$DurationMs = 0,
  [int]$Steps = 12,
  [int]$ClickDelayMs = 30,
  [int]$MoveFirst = 0
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$cacheDir = Join-Path $env:TEMP 'artificer-computer-use'
if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
$cacheDll = Join-Path $cacheDir 'ArtificerMouse.dll'

$cs = @'
using System;
using System.Runtime.InteropServices;
public static class ArtificerMouse {
  private struct POINT { public int X; public int Y; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public static int[] Cursor() {
    POINT p;
    if (!GetCursorPos(out p)) { return new int[] { -1, -1 }; }
    return new int[] { p.X, p.Y };
  }
  public static void Click(uint down, uint up, int data, int delay) {
    mouse_event(down, 0, 0, data, UIntPtr.Zero);
    System.Threading.Thread.Sleep(delay);
    mouse_event(up, 0, 0, data, UIntPtr.Zero);
  }
}
'@

$loaded = $false
if (Test-Path $cacheDll) {
  try { Add-Type -Path $cacheDll -ErrorAction Stop; $loaded = $true } catch { $loaded = $false }
}
if (-not $loaded) {
  try {
    Add-Type -TypeDefinition $cs -OutputAssembly $cacheDll -ErrorAction Stop
    Add-Type -Path $cacheDll -ErrorAction Stop
  } catch {
    Add-Type -TypeDefinition $cs -ErrorAction Stop
  }
}

$dpi = 'host'
try {
  if ([ArtificerMouse]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { $dpi = 'per-monitor-v2' }
} catch { }
if ($dpi -eq 'host') {
  try { if ([ArtificerMouse]::SetProcessDPIAware()) { $dpi = 'system' } } catch { }
}

function Get-Flags([string]$Btn) {
  switch ($Btn.ToLower()) {
    'left'   { return @{ down = 0x0002; up = 0x0004; data = 0 } }
    'right'  { return @{ down = 0x0008; up = 0x0010; data = 0 } }
    'middle' { return @{ down = 0x0020; up = 0x0040; data = 0 } }
    'x1'     { return @{ down = 0x0080; up = 0x0100; data = 1 } }
    'x2'     { return @{ down = 0x0080; up = 0x0100; data = 2 } }
    default  { throw "unknown button: $Btn" }
  }
}

function Move-To([int]$tx, [int]$ty, [int]$duration, [int]$steps) {
  if ($duration -le 0) {
    if (-not [ArtificerMouse]::SetCursorPos($tx, $ty)) { throw "SetCursorPos failed: $tx,$ty" }
    return
  }
  $c = [ArtificerMouse]::Cursor()
  $sx = [int]$c[0]
  $sy = [int]$c[1]
  $n = [Math]::Max(2, $steps)
  for ($i = 1; $i -le $n; $i++) {
    $t = $i / $n
    $nx = [int][Math]::Round($sx + ($tx - $sx) * $t)
    $ny = [int][Math]::Round($sy + ($ty - $sy) * $t)
    [void][ArtificerMouse]::SetCursorPos($nx, $ny)
    Start-Sleep -Milliseconds ([Math]::Max(1, [int]($duration / $n)))
  }
}

try {
  switch ($Action.ToLower()) {
    'probe' { }
    'move' {
      Move-To -tx $X -ty $Y -duration $DurationMs -steps $Steps
    }
    'click' {
      if ($MoveFirst -eq 1) { Move-To -tx $X -ty $Y -duration $DurationMs -steps $Steps }
      $f = Get-Flags $Button
      $n = [Math]::Max(1, $Clicks)
      for ($i = 0; $i -lt $n; $i++) {
        [ArtificerMouse]::Click([uint32]$f.down, [uint32]$f.up, [int]$f.data, [Math]::Max(0, $ClickDelayMs))
        if ($i -lt $n - 1) { Start-Sleep -Milliseconds 80 }
      }
    }
    'scroll' {
      if ($MoveFirst -eq 1) { Move-To -tx $X -ty $Y -duration 0 -steps 2 }
      $n = [Math]::Max(1, $Times)
      for ($i = 0; $i -lt $n; $i++) {
        [ArtificerMouse]::mouse_event(0x0800, 0, 0, $Delta, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
      }
    }
    'drag' {
      $f = Get-Flags $Button
      Move-To -tx $X -ty $Y -duration $DurationMs -steps $Steps
      Start-Sleep -Milliseconds 80
      [ArtificerMouse]::mouse_event([uint32]$f.down, 0, 0, [int]$f.data, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds ([Math]::Max(0, $HoldMs))
      Move-To -tx $ToX -ty $ToY -duration ([Math]::Max(240, $DurationMs)) -steps ([Math]::Max(8, $Steps))
      Start-Sleep -Milliseconds 80
      [ArtificerMouse]::mouse_event([uint32]$f.up, 0, 0, [int]$f.data, [UIntPtr]::Zero)
    }
    default { throw "unknown action: $Action" }
  }
  $c = [ArtificerMouse]::Cursor()
  $out = @{
    success = $true
    action = $Action
    cursorX = [int]$c[0]
    cursorY = [int]$c[1]
    screenWidth = [int][ArtificerMouse]::GetSystemMetrics(0)
    screenHeight = [int][ArtificerMouse]::GetSystemMetrics(1)
    dpiAwareness = $dpi
  }
  $out | ConvertTo-Json -Compress
} catch {
  $err = @{ success = $false; action = $Action; error = $_.Exception.Message }
  $err | ConvertTo-Json -Compress
}
`

const GUARD_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$StopFlag,
  [string]$Heartbeat = '',
  [string]$PidFile = '',
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class MouseGuard {
  public static string StopFlag = "";
  [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  public static bool TryRegister(IntPtr hwnd) { return RegisterHotKey(hwnd, 1, 0x4003u, 0x51u); }
  public static void WriteStop(string reason) { try { File.WriteAllText(StopFlag, reason); } catch { } }
  public static uint Dpi() {
    try { uint d = GetDpiForSystem(); if (d >= 72 && d <= 480) { return d; } } catch { }
    return 96;
  }
}

public class EscWatch {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;
  private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string lpModuleName);
  private static LowLevelKeyboardProc _proc;
  private static IntPtr _hook = IntPtr.Zero;
  public static volatile bool EscPressed = false;
  public static bool Start() {
    _proc = new LowLevelKeyboardProc(Callback);
    _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
    return _hook != IntPtr.Zero;
  }
  public static void Stop() {
    try { if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); } } catch { }
    _hook = IntPtr.Zero;
  }
  private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
      int vk = Marshal.ReadInt32(lParam);
      if (vk == 0x1B) { EscPressed = true; }
    }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }
}

public class CornerWindow : Form {
  [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] private struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
  [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
  [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr h);
  [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);
  [DllImport("user32.dll")] private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

  public CornerWindow() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    AutoScaleMode = AutoScaleMode.None;
  }

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x00080000;
      cp.ExStyle |= 0x00000020;
      return cp;
    }
  }

  public void PaintCorner(string mode, Color color, int radius, float scale) {
    int s = Width;
    using (Bitmap bmp = new Bitmap(s, s, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        if (mode == "tr") { g.TranslateTransform(s, 0); g.ScaleTransform(-1, 1); }
        else if (mode == "bl") { g.TranslateTransform(0, s); g.ScaleTransform(1, -1); }
        else if (mode == "br") { g.TranslateTransform(s, s); g.ScaleTransform(-1, -1); }

        float d = radius * 2f;
        using (GraphicsPath corner = new GraphicsPath()) {
          corner.AddLine(0, 0, radius, 0);
          corner.AddArc(0, 0, d, d, 270, -90);
          corner.AddLine(0, radius, 0, 0);
          corner.CloseFigure();
          using (PathGradientBrush pg = new PathGradientBrush(corner)) {
            pg.CenterPoint = new PointF(0, 0);
            pg.CenterColor = Color.FromArgb(158, color);
            pg.SurroundColors = new Color[] { Color.FromArgb(28, color) };
            pg.FocusScales = new PointF(0.22f, 0.22f);
            g.FillPath(pg, corner);
          }
        }

        using (GraphicsPath arc = new GraphicsPath()) {
          arc.AddArc(0, 0, d, d, 270, -90);
          using (Pen halo = new Pen(Color.FromArgb(34, color), 13f * scale))
          using (Pen soft = new Pen(Color.FromArgb(78, color), 6f * scale))
          using (Pen edge = new Pen(Color.FromArgb(196, color), 2.2f * scale)) {
            g.DrawPath(halo, arc);
            g.DrawPath(soft, arc);
            g.DrawPath(edge, arc);
          }
        }

        float len = 150f * scale;
        float thick = 2.2f * scale;
        RectangleF top = new RectangleF(radius, 0, len, thick);
        using (LinearGradientBrush lg = new LinearGradientBrush(top, Color.FromArgb(150, color), Color.FromArgb(0, color), LinearGradientMode.Horizontal)) {
          g.FillRectangle(lg, top);
        }
        RectangleF left = new RectangleF(0, radius, thick, len);
        using (LinearGradientBrush lg2 = new LinearGradientBrush(left, Color.FromArgb(150, color), Color.FromArgb(0, color), LinearGradientMode.Vertical)) {
          g.FillRectangle(lg2, left);
        }
      }
      Apply(bmp);
    }
  }

  private void Apply(Bitmap bmp) {
    IntPtr screenDc = GetDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr hBitmap = bmp.GetHbitmap(Color.FromArgb(0));
    IntPtr old = SelectObject(memDc, hBitmap);
    SIZE size = new SIZE();
    size.cx = bmp.Width;
    size.cy = bmp.Height;
    POINT src = new POINT();
    POINT dst = new POINT();
    dst.X = Left;
    dst.Y = Top;
    BLENDFUNCTION bf = new BLENDFUNCTION();
    bf.BlendOp = 0;
    bf.BlendFlags = 0;
    bf.SourceConstantAlpha = 255;
    bf.AlphaFormat = 1;
    UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref bf, 2);
    SelectObject(memDc, old);
    DeleteObject(hBitmap);
    DeleteDC(memDc);
    ReleaseDC(IntPtr.Zero, screenDc);
  }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Windows.Forms','System.Drawing','System'

try { [void][MouseGuard]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { }
try { [void][MouseGuard]::SetProcessDPIAware() } catch { }

if (Test-Path $StopFlag) { exit 0 }
[MouseGuard]::StopFlag = $StopFlag
if ($PidFile -ne '') {
  try { [System.IO.File]::WriteAllText($PidFile, [string]$PID) } catch { }
}

$dpi = [MouseGuard]::Dpi()
$scale = [double]$dpi / 96.0

$amber = [System.Drawing.Color]::FromArgb(255, 121, 167, 255)
$amberDim = [System.Drawing.Color]::FromArgb(110, 58, 96, 168)
$textMain = [System.Drawing.Color]::FromArgb(216, 231, 255)
$textSub = [System.Drawing.Color]::FromArgb(146, 158, 182)
$ink = [System.Drawing.Color]::FromArgb(18, 21, 27)
$danger = [System.Drawing.Color]::FromArgb(198, 64, 64)
$stroke = [System.Drawing.Color]::FromArgb(120, 121, 167, 255)

$area = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

function Px([double]$value) { return [int][Math]::Round($value * $scale) }

function New-PxFont([double]$size, [bool]$bold) {
  $style = [System.Drawing.FontStyle]::Regular
  if ($bold) { $style = [System.Drawing.FontStyle]::Bold }
  return New-Object System.Drawing.Font('Microsoft YaHei UI', [float]$size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-RoundedRegion([int]$rw, [int]$rh, [int]$rr) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $rr * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($rw - $d, 0, $d, $d, 270, 90)
  $path.AddArc($rw - $d, $rh - $d, $d, $d, 0, 90)
  $path.AddArc(0, $rh - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return New-Object System.Drawing.Region($path)
}

$forms = New-Object System.Collections.ArrayList

$cornerRadius = Px 26
$cornerSize = Px 210
function New-Corner([string]$mode, [int]$cx, [int]$cy) {
  $w = New-Object CornerWindow
  $w.Width = $cornerSize
  $w.Height = $cornerSize
  $w.Left = $cx
  $w.Top = $cy
  $w.PaintCorner($mode, $amber, $cornerRadius, [float]$scale)
  $w.Show()
  return $w
}

[void]$forms.Add((New-Corner 'tl' $area.Left ($area.Top - 0)))
[void]$forms.Add((New-Corner 'tr' ($area.Right - $cornerSize) $area.Top))
[void]$forms.Add((New-Corner 'bl' $area.Left ($work.Bottom - $cornerSize)))
[void]$forms.Add((New-Corner 'br' ($area.Right - $cornerSize) ($work.Bottom - $cornerSize)))

$pw = Px 452
$ph = Px 48
$pill = New-Object System.Windows.Forms.Form
$pill.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$pill.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$pill.TopMost = $true
$pill.ShowInTaskbar = $false
$pill.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$pill.BackColor = $ink
$pill.Width = $pw
$pill.Height = $ph
$pill.Left = $area.Left + [int](($area.Width - $pw) / 2)
$pill.Top = $area.Top + (Px 16)
$pill.Region = New-RoundedRegion $pw $ph ([int]($ph / 2))
$pill.Opacity = 0.94

$pill.Add_Paint({
  $g = $_.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $pen = New-Object System.Drawing.Pen($stroke, [float](1.4 * $scale))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $ph - 2
  $path.AddArc(0.7, 0.7, $d, $d, 180, 90)
  $path.AddArc($pw - $d - 0.7, 0.7, $d, $d, 270, 90)
  $path.AddArc($pw - $d - 0.7, $ph - $d - 0.7, $d, $d, 0, 90)
  $path.AddArc(0.7, $ph - $d - 0.7, $d, $d, 90, 90)
  $g.DrawPath($pen, $path)
  $pen.Dispose()
  $path.Dispose()
})

$dotSize = Px 9
$dot = New-Object System.Windows.Forms.Panel
$dot.Width = $dotSize
$dot.Height = $dotSize
$dot.Left = Px 22
$dot.Top = [int](($ph - $dotSize) / 2)
$dot.BackColor = $amber
$dot.Region = New-RoundedRegion $dotSize $dotSize ([int]($dotSize / 2))
$pill.Controls.Add($dot)

$titleFontSize = 14.5
$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $false
$title.Left = Px 40
$title.Top = Px 7
$title.Width = Px 268
$title.Height = Px 22
$title.ForeColor = $textMain
$title.Font = New-PxFont $titleFontSize $true
$title.Text = 'AI 正在操控鼠标'
$pill.Controls.Add($title)

$sub = New-Object System.Windows.Forms.Label
$sub.AutoSize = $false
$sub.Left = Px 40
$sub.Top = Px 27
$sub.Width = Px 300
$sub.Height = Px 18
$sub.ForeColor = $textSub
$sub.Font = New-PxFont 11.5 $false
$sub.Text = '按 Esc 键停止'
$pill.Controls.Add($sub)

$btnW = Px 78
$btnH = Px 30
$btn = New-Object System.Windows.Forms.Label
$btn.AutoSize = $false
$btn.Width = $btnW
$btn.Height = $btnH
$btn.Left = $pw - $btnW - (Px 14)
$btn.Top = [int](($ph - $btnH) / 2)
$btn.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$btn.BackColor = $danger
$btn.ForeColor = [System.Drawing.Color]::White
$btn.Font = New-PxFont 12.5 $true
$btn.Text = '停止'
$btn.Cursor = [System.Windows.Forms.Cursors]::Hand
$btn.Region = New-RoundedRegion $btnW $btnH ([int]($btnH / 2))
$pill.Controls.Add($btn)

$stopAction = {
  [MouseGuard]::WriteStop('button')
  [System.Windows.Forms.Application]::ExitThread()
}
$btn.Add_Click($stopAction)
$pill.Add_Click($stopAction)

$pill.Show()
[void]$forms.Add($pill)

$escOk = $false
try { $escOk = [EscWatch]::Start() } catch { $escOk = $false }
$hkOk = $false
try { $hkOk = [MouseGuard]::TryRegister($pill.Handle) } catch { $hkOk = $false }
if (-not $escOk) { $sub.Text = '点“停止”或按 Ctrl+Alt+Q 结束' }

$script:pulse = 0
$blink = New-Object System.Windows.Forms.Timer
$blink.Interval = 800
$blink.Add_Tick({
  $script:pulse = 1 - $script:pulse
  if ($script:pulse -eq 0) { $dot.BackColor = $amber } else { $dot.BackColor = $amberDim }
})

$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 150
$watch.Add_Tick({
  if ([EscWatch]::EscPressed) {
    [MouseGuard]::WriteStop('esc')
    [System.Windows.Forms.Application]::ExitThread()
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  if (Test-Path $StopFlag) {
    [System.Windows.Forms.Application]::ExitThread()
    return
  }
  if ($TimeoutSec -gt 0 -and $Heartbeat -ne '' -and (Test-Path $Heartbeat)) {
    try {
      $last = [DateTime]::Parse((Get-Content $Heartbeat -Raw).Trim())
      if (([DateTime]::Now - $last).TotalSeconds -gt $TimeoutSec) {
        [MouseGuard]::WriteStop('timeout')
        [System.Windows.Forms.Application]::ExitThread()
      }
    } catch { }
  }
})

$blink.Start()
$watch.Start()
$timer.Start()
[System.Windows.Forms.Application]::Run($pill)

$blink.Stop()
$watch.Stop()
$timer.Stop()
try { [EscWatch]::Stop() } catch { }
foreach ($ef in $forms) {
  try { $ef.Close() } catch { }
}
if ($PidFile -ne '') {
  try { [System.IO.File]::Delete($PidFile) } catch { }
}
`

const GUARD_DIR = path.join(os.tmpdir(), 'artificer-computer-use')
const STOP_FLAG = path.join(GUARD_DIR, 'guard.stop')
const HEARTBEAT = path.join(GUARD_DIR, 'guard.heartbeat')
const GUARD_PID = path.join(GUARD_DIR, 'guard.pid')
const GUARD_LOG = path.join(GUARD_DIR, 'guard.log')

let lastSpawnPid = 0
let lastSpawnError = ''
let cachedScript = null

function appendGuardLog(entry) {
  try {
    fs.mkdirSync(GUARD_DIR, { recursive: true })
    fs.appendFileSync(GUARD_LOG, new Date().toISOString() + ' ' + JSON.stringify(entry) + '\n', 'utf8')
  } catch (_e) {
    // 诊断日志写入失败不影响主流程
  }
}

function ensureScript() {
  if (cachedScript && fs.existsSync(cachedScript)) return cachedScript
  fs.mkdirSync(GUARD_DIR, { recursive: true })
  const file = path.join(GUARD_DIR, 'mouse.ps1')
  const content = '\ufeff' + PS_SCRIPT
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
    fs.writeFileSync(file, content, 'utf8')
  }
  cachedScript = file
  return file
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runPowerShell(scriptFile, args) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, ...args],
      { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout || '').trim()
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start >= 0 && end > start) {
          try {
            resolve(JSON.parse(text.slice(start, end + 1)))
            return
          } catch (_e) {
            // 落到下面统一报错
          }
        }
        const reason = String(stderr || '').trim() || err?.message || 'PowerShell 调用失败'
        resolve({ success: false, error: reason })
      }
    )
  })
}

async function invoke(payload = {}) {
  const action = String(payload.action || 'probe').toLowerCase()
  const scriptFile = ensureScript()
  const args = [
    '-Action', action,
    '-X', String(toInt(payload.x, 0)),
    '-Y', String(toInt(payload.y, 0)),
    '-ToX', String(toInt(payload.toX, 0)),
    '-ToY', String(toInt(payload.toY, 0)),
    '-Button', String(payload.button || 'left'),
    '-Clicks', String(toInt(payload.clicks, 1)),
    '-Times', String(toInt(payload.times, 1)),
    '-Delta', String(toInt(payload.delta, 120)),
    '-HoldMs', String(toInt(payload.holdMs, 80)),
    '-DurationMs', String(toInt(payload.durationMs, 0)),
    '-Steps', String(toInt(payload.steps, 12)),
    '-ClickDelayMs', String(toInt(payload.clickDelayMs, 30)),
    '-MoveFirst', payload.moveFirst ? '1' : '0'
  ]
  return runPowerShell(scriptFile, args)
}

async function readSettings(ctx) {
  try {
    const s = await ctx.getSettings?.()
    return s && typeof s === 'object' ? s : {}
  } catch (_e) {
    return {}
  }
}

function readGuardPid() {
  try {
    const n = Number(String(fs.readFileSync(GUARD_PID, 'utf8')).trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch (_e) {
    return 0
  }
}

function guardAlive() {
  const pid = readGuardPid() || lastSpawnPid
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

function touchHeartbeat() {
  try {
    fs.mkdirSync(GUARD_DIR, { recursive: true })
    fs.writeFileSync(HEARTBEAT, new Date().toISOString(), 'utf8')
  } catch (_e) {
    // 心跳写入失败不影响动作执行
  }
}

function readStop() {
  try {
    return String(fs.readFileSync(STOP_FLAG, 'utf8')).trim()
  } catch (_e) {
    return ''
  }
}

function clearStop() {
  try {
    fs.unlinkSync(STOP_FLAG)
  } catch (_e) {
    // 文件不存在时忽略
  }
}

function ensureGuardScript() {
  fs.mkdirSync(GUARD_DIR, { recursive: true })
  const file = path.join(GUARD_DIR, 'guard.ps1')
  const content = '\ufeff' + GUARD_SCRIPT
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
    fs.writeFileSync(file, content, 'utf8')
  }
  return file
}

function startGuard(timeoutSec) {
  const scriptFile = ensureGuardScript()
  const outFd = fs.openSync(path.join(GUARD_DIR, 'guard.out.log'), 'a')
  const errFd = fs.openSync(path.join(GUARD_DIR, 'guard.err.log'), 'a')
  const child = spawn(
    'powershell.exe',
    ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptFile,
      '-StopFlag', STOP_FLAG, '-Heartbeat', HEARTBEAT, '-PidFile', GUARD_PID, '-TimeoutSec', String(timeoutSec)],
    { detached: false, stdio: ['ignore', outFd, errFd], windowsHide: true }
  )
  lastSpawnPid = child.pid || 0
  child.on('error', (e) => {
    lastSpawnError = String(e && e.message ? e.message : e)
    appendGuardLog({ event: 'spawn-error', error: lastSpawnError })
  })
  child.unref()
  return child
}

function stopMessage(reason) {
  const map = {
    esc: '用户按 Esc 键夺回鼠标控制，接管结束。',
    hotkey: '用户按备用热键 Ctrl+Alt+Q 夺回鼠标控制，接管结束。',
    button: '用户点击了“停止”按钮，接管结束。',
    timeout: '接管超时，已自动结束。',
    ended: '接管已结束。'
  }
  const head = map[reason] || '接管已结束。'
  return head + '如需继续，请先调用 mouseBeginControl 重新开启接管。'
}

async function requireControl() {
  const stop = readStop()
  if (stop) {
    return { ok: false, result: { success: false, blocked: true, reason: stop, error: stopMessage(stop) } }
  }
  if (!guardAlive()) {
    return {
      ok: false,
      result: {
        success: false,
        blocked: true,
        reason: 'no-session',
        error: '尚未开启鼠标接管。请先调用 mouseBeginControl，屏幕四角会出现接管标记，用户按 Esc 即可夺回控制。'
      }
    }
  }
  touchHeartbeat()
  return { ok: true }
}

async function beginControl(ctx, params = {}) {
  const settings = await readSettings(ctx)
  const raw = toInt(params.timeoutSec ?? settings.idleTimeoutSec, 600)
  const timeoutSec = Math.min(600, Math.max(15, raw))
  fs.mkdirSync(GUARD_DIR, { recursive: true })
  clearStop()
  touchHeartbeat()
  let waitedMs = 0
  if (!guardAlive()) {
    startGuard(timeoutSec)
    const started = Date.now()
    while (Date.now() - started < 9000) {
      await sleep(250)
      if (guardAlive()) break
    }
    waitedMs = Date.now() - started
  }
  touchHeartbeat()
  const alive = guardAlive()
  appendGuardLog({ event: 'begin', alive, waitedMs, pid: readGuardPid(), spawnPid: lastSpawnPid, spawnError: lastSpawnError })
  return {
    success: alive,
    controlling: alive,
    timeoutSec,
    waitedMs,
    guardPid: readGuardPid() || lastSpawnPid || null,
    exitHint: '按 Esc 键即可随时夺回鼠标控制；Esc 不会被吞掉，仍会正常传给当前窗口。',
    error: alive ? undefined : ('接管提示条启动失败（等待 ' + waitedMs + 'ms）：' + (lastSpawnError || 'guard.ps1 未产生 pid 文件，请检查 PowerShell 与 WinForms 可用性'))
  }
}

async function endControl() {
  fs.mkdirSync(GUARD_DIR, { recursive: true })
  try {
    fs.writeFileSync(STOP_FLAG, 'ended', 'utf8')
  } catch (_e) {
    // 忽略写入失败
  }
  await sleep(500)
  try {
    fs.unlinkSync(HEARTBEAT)
  } catch (_e) {
    // 心跳文件不存在时忽略
  }
  return { success: true, controlling: false, message: '已结束鼠标接管，提示条已关闭。' }
}

function controlStatus() {
  const stop = readStop()
  const alive = guardAlive()
  return { success: true, controlling: Boolean(alive && !stop), reason: stop || null, guardPid: readGuardPid() || null }
}

export function register(ctx) {
  const buttonSchema = {
    type: 'string',
    enum: ['left', 'right', 'middle'],
    description: '鼠标按键，默认 left'
  }

  ctx.registerTool({
    id: 'mouseProbe',
    description: '读取屏幕物理分辨率、当前鼠标光标坐标和 DPI 感知模式。截图上定位坐标前先调用它确认坐标系，也可顺带查看是否处于接管状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    security: { kind: 'safe' },
    handler: async () => {
      const result = await invoke({ action: 'probe' })
      return Object.assign({}, result, { controlling: Boolean(guardAlive() && !readStop()) })
    }
  })

  ctx.registerTool({
    id: 'mouseBeginControl',
    description: '开启鼠标接管：屏幕四角出现接管标记，用户按 Esc 键即可随时夺回控制。未接管时所有移动/点击/滚动/拖拽都会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        timeoutSec: { type: 'number', description: '接管最长持续秒数，超时自动结束（界面不显示倒计时），默认 600' }
      },
      additionalProperties: false
    },
    security: { kind: 'safe' },
    handler: async (params = {}) => beginControl(ctx, params)
  })

  ctx.registerTool({
    id: 'mouseEndControl',
    description: '结束鼠标接管并清除屏幕四角的接管标记。接管结束后所有鼠标动作被拒绝，直到再次开启。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    security: { kind: 'safe' },
    handler: async () => endControl()
  })

  ctx.registerTool({
    id: 'mouseMove',
    description: '把鼠标光标移动到屏幕指定坐标（物理像素）。不点击。必须先 mouseBeginControl 开启接管。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标（物理像素）' },
        y: { type: 'number', description: '目标 Y 坐标（物理像素）' },
        durationMs: { type: 'number', description: '移动过渡时长，0 为瞬移，默认 0' }
      },
      required: ['x', 'y']
    },
    security: { kind: 'safe' },
    handler: async ({ x, y, durationMs } = {}) => {
      const guard = await requireControl()
      if (!guard.ok) return guard.result
      const settings = await readSettings(ctx)
      return invoke({
        action: 'move',
        x,
        y,
        durationMs: durationMs ?? settings.moveDurationMs ?? 0
      })
    }
  })

  ctx.registerTool({
    id: 'mouseClick',
    description: '在屏幕指定坐标（物理像素）点击鼠标，可指定按键与点击次数。省略 x/y 时在光标当前位置点击。必须先 mouseBeginControl 开启接管，真实点击会产生实际副作用。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '点击位置 X 坐标，省略则用当前光标位置' },
        y: { type: 'number', description: '点击位置 Y 坐标，省略则用当前光标位置' },
        button: buttonSchema,
        clicks: { type: 'number', description: '点击次数，2 表示双击，默认 1' },
        durationMs: { type: 'number', description: '先移动到目标点的过渡时长，默认 0' }
      },
      additionalProperties: false
    },
    security: { kind: 'risky' },
    handler: async ({ x, y, button, clicks, durationMs } = {}) => {
      const guard = await requireControl()
      if (!guard.ok) return guard.result
      const settings = await readSettings(ctx)
      const hasPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y))
      return invoke({
        action: 'click',
        x: hasPoint ? Number(x) : 0,
        y: hasPoint ? Number(y) : 0,
        button: button || 'left',
        clicks: clicks ?? 1,
        durationMs: durationMs ?? settings.moveDurationMs ?? 0,
        clickDelayMs: settings.clickDelayMs ?? 30,
        moveFirst: hasPoint
      })
    }
  })

  ctx.registerTool({
    id: 'mouseScroll',
    description: '在光标处滚动鼠标滚轮。delta 为 120 的整数倍，正数向上、负数向下。必须先 mouseBeginControl 开启接管。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '滚动前移动到的 X 坐标，省略则不移动' },
        y: { type: 'number', description: '滚动前移动到的 Y 坐标，省略则不移动' },
        delta: { type: 'number', description: '单次滚动量，默认 120，正数向上' },
        times: { type: 'number', description: '滚动次数，默认 1' }
      },
      additionalProperties: false
    },
    security: { kind: 'risky' },
    handler: async ({ x, y, delta, times } = {}) => {
      const guard = await requireControl()
      if (!guard.ok) return guard.result
      const hasPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y))
      return invoke({
        action: 'scroll',
        x: hasPoint ? Number(x) : 0,
        y: hasPoint ? Number(y) : 0,
        delta: delta ?? 120,
        times: times ?? 1,
        moveFirst: hasPoint
      })
    }
  })

  ctx.registerTool({
    id: 'mouseDrag',
    description: '从起点按下鼠标并拖拽到终点后松开，用于拖动窗口、选中文本、拖拽滑块。必须先 mouseBeginControl 开启接管。',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number', description: '起点 X 坐标' },
        fromY: { type: 'number', description: '起点 Y 坐标' },
        toX: { type: 'number', description: '终点 X 坐标' },
        toY: { type: 'number', description: '终点 Y 坐标' },
        button: buttonSchema,
        durationMs: { type: 'number', description: '拖拽过程时长，默认 600' }
      },
      required: ['fromX', 'fromY', 'toX', 'toY']
    },
    security: { kind: 'risky' },
    handler: async ({ fromX, fromY, toX, toY, button, durationMs } = {}) => {
      const guard = await requireControl()
      if (!guard.ok) return guard.result
      return invoke({
        action: 'drag',
        x: fromX,
        y: fromY,
        toX,
        toY,
        button: button || 'left',
        durationMs: durationMs ?? 600
      })
    }
  })

  ctx.registerRoute({
    method: 'POST',
    path: '/api/plugins/computer-use/action',
    handler: async (req) => {
      let body = req?.body ?? {}
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body)
        } catch (_e) {
          body = {}
        }
      }
      if (!body || typeof body !== 'object') body = {}
      const act = String(body.action || 'probe').toLowerCase()

      if (act === 'begincontrol' || act === 'begin') {
        return { success: true, data: await beginControl(ctx, body) }
      }
      if (act === 'endcontrol' || act === 'end') {
        return { success: true, data: await endControl() }
      }
      if (act === 'status') {
        return { success: true, data: controlStatus() }
      }
      if (act === 'move' || act === 'click' || act === 'scroll' || act === 'drag') {
        const guard = await requireControl()
        if (!guard.ok) return { success: false, data: guard.result }
      }
      const result = await invoke(body)
      return { success: result.success !== false, data: result }
    }
  })
}
