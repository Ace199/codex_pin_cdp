import assert from "node:assert/strict";
import test from "node:test";

import { activateWindowsApp } from "../scripts/windows-app-activation.mjs";

test("Windows activation passes AUMID and CDP arguments through dedicated environment variables", () => {
  let invocation;
  const processId = activateWindowsApp({
    appUserModelId: "OpenAI.Codex_example!App",
    launchArguments: "--remote-debugging-port=9339",
    environment: { SYSTEMROOT: "C:\\Windows" },
    runSync: (executable, args, options) => {
      invocation = { executable, args, options };
      return { status: 0, stdout: "41324", stderr: "" };
    },
  });

  assert.equal(processId, 41324);
  assert.equal(invocation.executable, "powershell.exe");
  assert.equal(invocation.options.env.CODEX_PIN_AUMID, "OpenAI.Codex_example!App");
  assert.equal(invocation.options.env.CODEX_PIN_ACTIVATION_ARGS, "--remote-debugging-port=9339");
  assert.match(invocation.args.at(-1), /ApplicationActivationManager/);
});

test("Windows activation rejects an invalid process id", () => {
  assert.throws(() => activateWindowsApp({
    appUserModelId: "OpenAI.Codex_example!App",
    launchArguments: "",
    runSync: () => ({ status: 1, stdout: "", stderr: "activation failed" }),
  }), /activation failed/);
});

