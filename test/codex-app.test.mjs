import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  codexExecutablePath,
  macCodexAppCandidates,
  resolveCodexDesktop,
} from "../scripts/codex-app.mjs";

test("Windows resolves the Microsoft Store desktop executable, not the bundled CLI", () => {
  const installLocation = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3_x64`;
  const expected = path.win32.join(installLocation, "app", "ChatGPT.exe");
  const resolved = resolveCodexDesktop({
    platform: "win32",
    explicitPath: "",
    pathExists: (candidate) => candidate === expected,
    runSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        InstallLocation: installLocation,
        PackageFamilyName: "OpenAI.Codex_example",
      }),
    }),
  });

  assert.equal(resolved.executablePath, expected);
  assert.equal(resolved.appUserModelId, "OpenAI.Codex_example!App");
  assert.doesNotMatch(resolved.executablePath, /resources[\\/]codex\.exe$/i);
});

test("macOS resolves the executable inside ChatGPT.app", () => {
  assert.equal(
    codexExecutablePath("/Applications/ChatGPT.app", "darwin"),
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  );
  assert.equal(
    codexExecutablePath("/Applications/Codex.app", "darwin"),
    "/Applications/Codex.app/Contents/MacOS/Codex",
  );
});

test("macOS checks both system and per-user app locations", () => {
  const home = "/Users/example";
  assert.deepEqual(macCodexAppCandidates(home), [
    "/Applications/ChatGPT.app",
    "/Users/example/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    "/Users/example/Applications/Codex.app",
  ]);
});

test("an explicit macOS app path takes precedence", () => {
  const resolved = resolveCodexDesktop({
    platform: "darwin",
    explicitPath: "/Custom/Codex.app",
    pathExists: (candidate) => candidate === "/Custom/Codex.app/Contents/MacOS/Codex",
  });
  assert.equal(resolved.source, "explicit");
  assert.equal(resolved.executablePath, "/Custom/Codex.app/Contents/MacOS/Codex");
});
