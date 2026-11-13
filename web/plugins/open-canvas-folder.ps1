param([Parameter(Mandatory = $true)][string]$Folder)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CanvasExplorerWindow
{
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint thread, uint other, bool attach);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
        public uint Private;
    }

    public static void Activate(IntPtr window)
    {
        if (IsIconic(window)) ShowWindowAsync(window, 9); // SW_RESTORE
        if (SetForegroundWindow(window)) return;

        // The service runs in the background. Briefly share the foreground
        // input queue for this user-initiated activation, then detach.
        Message message;
        PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
        uint current = GetCurrentThreadId();
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        uint target = GetWindowThreadProcessId(window, IntPtr.Zero);
        bool attachedForeground = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
        bool attachedTarget = target != 0 && target != current && target != foreground && AttachThreadInput(current, target, true);
        try
        {
            BringWindowToTop(window);
            SetForegroundWindow(window);
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(current, target, false);
            if (attachedForeground) AttachThreadInput(current, foreground, false);
        }
    }
}
'@

$shell = New-Object -ComObject Shell.Application
function Find-ExplorerWindow {
    foreach ($window in $shell.Windows()) {
        try {
            $location = [uri]$window.LocationURL
            if ($location.IsFile -and $location.LocalPath.TrimEnd('\') -ieq $Folder.TrimEnd('\')) {
                return [IntPtr]([long]$window.HWND)
            }
        } catch {
            # A window can close while ShellWindows is being enumerated.
        }
    }
    return [IntPtr]::Zero
}

$windowHandle = Find-ExplorerWindow
if ($windowHandle -eq [IntPtr]::Zero) {
    $shell.Explore($Folder)
}
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    $windowHandle = Find-ExplorerWindow
    if ($windowHandle -ne [IntPtr]::Zero) {
        [CanvasExplorerWindow]::Activate($windowHandle)
        Start-Sleep -Milliseconds 120
        if ([CanvasExplorerWindow]::GetForegroundWindow() -eq $windowHandle) { exit 0 }
    } else {
        Start-Sleep -Milliseconds 120
    }
} while ([DateTime]::UtcNow -lt $deadline)

if ($windowHandle -ne [IntPtr]::Zero) { exit 2 }
exit 3
