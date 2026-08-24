import { spawnSync } from "node:child_process";

const ACTIVATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$definition = @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}
[ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
public static class CodexPinAppActivator {
  public static uint Activate(string aumid, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint processId;
    int result = manager.ActivateApplication(aumid, arguments, 2, out processId);
    Marshal.ThrowExceptionForHR(result);
    return processId;
  }
}
'@
Add-Type -TypeDefinition $definition
[Console]::Write([CodexPinAppActivator]::Activate($env:CODEX_PIN_AUMID, $env:CODEX_PIN_ACTIVATION_ARGS))
`;

export function activateWindowsApp({
  appUserModelId,
  launchArguments,
  runSync = spawnSync,
  environment = process.env,
} = {}) {
  if (!appUserModelId?.trim()) throw new Error("Codex AUMID is unavailable");
  const result = runSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    ACTIVATION_SCRIPT,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...environment,
      CODEX_PIN_AUMID: appUserModelId,
      CODEX_PIN_ACTIVATION_ARGS: launchArguments,
    },
  });
  const processId = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isInteger(processId) || processId <= 0) {
    const detail = result.stderr?.trim() || result.error?.message || `PowerShell exited ${result.status}`;
    throw new Error(`Windows 无法通过 AUMID 激活 Codex：${detail}`);
  }
  return processId;
}

