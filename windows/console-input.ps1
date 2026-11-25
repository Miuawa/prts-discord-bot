# Reads and types into the narrator's console window directly (Win32 console API),
# instead of SendKeys. SendKeys needs the window to be in front, which Windows
# refuses for hidden background scripts and on a locked screen, so at 5:00 with
# nobody at the laptop the keys never arrived. Writing to the console's input
# buffer works with no focus, with the screen locked or off.
# Dot-source this file, then call Get-NarratorScreen / Send-NarratorText.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PrtsConsole {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct CSBI { public COORD Size, Cursor; public ushort Attr; public RECT Win; public COORD Max; }
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort VKey;
    [FieldOffset(12)] public ushort Scan;
    [FieldOffset(14)] public char Char;
    [FieldOffset(16)] public uint Ctrl;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);

  const uint RW = 0xC0000000, SHARE = 3, OPEN_EXISTING = 3;

  static IntPtr Open(uint pid, string name) {
    FreeConsole();
    if (!AttachConsole(pid)) throw new Exception("AttachConsole failed for pid " + pid);
    IntPtr h = CreateFile(name, RW, SHARE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { FreeConsole(); throw new Exception("Cannot open " + name); }
    return h;
  }

  // The visible part of the console window, one line per row.
  public static string ReadScreen(uint pid) {
    IntPtr h = Open(pid, "CONOUT$");
    try {
      CSBI i; GetConsoleScreenBufferInfo(h, out i);
      int w = i.Win.R - i.Win.L + 1;
      var all = new StringBuilder();
      for (short y = i.Win.T; y <= i.Win.B; y++) {
        var row = new StringBuilder(w); uint n;
        COORD at; at.X = i.Win.L; at.Y = y;
        ReadConsoleOutputCharacter(h, row, (uint)w, at, out n);
        all.AppendLine(row.ToString().TrimEnd());
      }
      return all.ToString();
    } finally { CloseHandle(h); FreeConsole(); }
  }

  // Buffer size, cursor and visible window, for troubleshooting.
  public static string Info(uint pid) {
    IntPtr h = Open(pid, "CONOUT$");
    try {
      CSBI i; GetConsoleScreenBufferInfo(h, out i);
      return string.Format("buffer {0}x{1} cursor {2},{3} window {4},{5}-{6},{7}", i.Size.X, i.Size.Y, i.Cursor.X, i.Cursor.Y, i.Win.L, i.Win.T, i.Win.R, i.Win.B);
    } finally { CloseHandle(h); FreeConsole(); }
  }

  // Types text into the console; '\r' is the Enter key.
  public static void Type(uint pid, string text) {
    IntPtr h = Open(pid, "CONIN$");
    try {
      var recs = new INPUT_RECORD[text.Length * 2];
      for (int k = 0; k < text.Length; k++) {
        char c = text[k];
        ushort vk = c == '\r' ? (ushort)0x0D : (ushort)0;
        ushort sc = c == '\r' ? (ushort)0x1C : (ushort)0;
        for (int d = 0; d < 2; d++) {
          var r = new INPUT_RECORD();
          r.EventType = 1; r.KeyDown = d == 0 ? 1 : 0; r.Repeat = 1; r.VKey = vk; r.Scan = sc; r.Char = c;
          recs[k * 2 + d] = r;
        }
      }
      uint written; WriteConsoleInput(h, recs, (uint)recs.Length, out written);
    } finally { CloseHandle(h); FreeConsole(); }
  }
}
'@

function Get-NarratorProcess {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -like '*--dangerously-load-development-channels*' } | Select-Object -First 1
}
function Get-NarratorScreen([uint32]$ProcessId) { [PrtsConsole]::ReadScreen($ProcessId) }
function Send-NarratorText([uint32]$ProcessId, [string]$Text) { [PrtsConsole]::Type($ProcessId, $Text) }
