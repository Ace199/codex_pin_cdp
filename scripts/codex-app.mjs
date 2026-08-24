import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function executableForMacBundle(appPath) {
  return path.posix.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(appPath, ".app"),
  );
}

export function codexExecutablePath(appPath, platform = process.platform) {
  if (platform === "win32") return appPath;
  if (platform === "darwin" && appPath.toLowerCase().endsWith(".app")) {
    return executableForMacBundle(appPath);
  }
  return appPath;
}

export function macCodexAppCandidates(homeDirectory = os.homedir()) {
  return [
    "/Applications/ChatGPT.app",
    path.posix.join(homeDirectory, "Applications", "ChatGPT.app"),
    "/Applications/Codex.app",
    path.posix.join(homeDirectory, "Applications", "Codex.app"),
  ];
}

export function resolveCodexDesktop({
  platform = process.platform,
  explicitPath = process.env.CODEX_PIN_APP_PATH,
  homeDirectory = os.homedir(),
  pathExists = existsSync,
  runSync = spawnSync,
} = {}) {
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(`Chat Pin 暂不支持 ${platform}，目前仅支持 Windows 和 macOS。`);
  }

  if (typeof explicitPath === "string" && explicitPath.trim()) {
    const platformPath = platform === "win32" ? path.win32 : path.posix;
    const appPath = platformPath.resolve(explicitPath.trim());
    const executablePath = codexExecutablePath(appPath, platform);
    if (!pathExists(executablePath)) {
      throw new Error(`--app-path 指向的 Codex 桌面端不存在：${executablePath}`);
    }
    return { appPath, executablePath, source: "explicit" };
  }

  if (platform === "darwin") {
    for (const appPath of macCodexAppCandidates(homeDirectory)) {
      const executablePath = codexExecutablePath(appPath, platform);
      if (pathExists(executablePath)) return { appPath, executablePath, source: "applications" };
    }
    throw new Error("未找到官方 ChatGPT.app 或 Codex.app。请先安装到 /Applications 或 ~/Applications，或使用 --app-path 指定位置。");
  }

  const result = runSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package) { [pscustomobject]@{ InstallLocation = $package.InstallLocation; PackageFamilyName = $package.PackageFamilyName } | ConvertTo-Json -Compress }",
  ], { encoding: "utf8", windowsHide: true });
  let packageInfo = null;
  try {
    packageInfo = result.status === 0 ? JSON.parse(result.stdout.trim()) : null;
  } catch {}
  const installLocation = packageInfo?.InstallLocation?.trim() || "";
  const appPath = installLocation && path.win32.join(installLocation, "app", "ChatGPT.exe");
  if (!appPath || !pathExists(appPath)) {
    throw new Error("未找到 Microsoft Store 版 Codex。请先安装或更新 OpenAI.Codex，或使用 --app-path 指定 ChatGPT.exe。");
  }
  const packageFamilyName = packageInfo?.PackageFamilyName?.trim() || "";
  return {
    appPath,
    executablePath: appPath,
    appUserModelId: packageFamilyName ? `${packageFamilyName}!App` : "",
    source: "appx",
  };
}
