import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexAppServerClient,
  COLLECTION_MARKER,
  clearCompletedCollectionItems,
  clearCollectionItems,
  collectionItemIsCurrent,
  collectionPrompt,
  collectionRuntimeOptions,
  extractCollectionMetadata,
  findExactWorkspaceUrlMatches,
  parseDesktopExecutionPreference,
  prepareCollectionPreflight,
  probeCodexCli,
  recoverCollectionItems,
  resolveCollectionSourceInWorkspace,
  resolveCodexCli,
  retryFailedCollectionItems,
  selectCollectionExecutionProfile,
  verifyGithubRepositories,
} from "../scripts/collection-mode.mjs";

const injectionSource = await readFile(new URL("../inject/codex-pin.user.js", import.meta.url), "utf8");
const launcherSource = await readFile(new URL("../scripts/pin-launcher.mjs", import.meta.url), "utf8");
const collectionModeSource = await readFile(new URL("../scripts/collection-mode.mjs", import.meta.url), "utf8");

test("collection prompt keeps each item isolated and requires real workspace changes", () => {
  const prompt = collectionPrompt(
    "# 规则\n保留项目名、链接和来源。",
    "项目 A：https://example.com/a\n项目 B：https://example.com/b",
  );
  assert.ok(prompt.startsWith(COLLECTION_MARKER));
  assert.match(prompt, /## 采集目标与处理规则\n# 规则/);
  assert.match(prompt, /## 当前输入\n项目 A/);
  assert.match(prompt, /不要使用或假设存在此前的对话或采集结果/);
  assert.match(prompt, /不要强制套用固定摘要格式/);
  assert.match(prompt, /批量输入应逐项处理/);
  assert.match(prompt, /名称、日期、数值、单位、代码、链接和来源/);
  assert.match(prompt, /实际创建或修改工作区文件/);
  assert.match(prompt, /不得只返回建议、草稿或待写入的 Markdown/);
  assert.match(prompt, /完成写入后执行规则要求的检查/);
  assert.match(prompt, /最终回答只报告实际创建或修改的文件/);
  assert.match(prompt, /## 脚本预提取（仅作检索键）/);
  assert.match(prompt, /禁止枚举完整文件树/);
  assert.match(prompt, /GitHub 仓库优先批量核验/);
  assert.doesNotMatch(prompt, /不修改采集规则文件或工作区文件/);
  assert.doesNotMatch(prompt, /主题与中心思想/);
  assert.throws(() => collectionPrompt("", "请求"), /采集规则文件是空的/);
  assert.throws(() => collectionPrompt("主题", "  "), /采集要求不能为空/);
});

test("collection preprocessor preserves raw text and extracts deterministic lookup keys", () => {
  const rules = "  # 规则\n保留 [Lap](https://github.com/julyx10/lap2) 。\n";
  const input = "\n2026年8月25日 https://github.com/nyblnet/bento, 以及 2026-08-24。  ";
  const metadata = extractCollectionMetadata(rules, input);
  assert.deepEqual(metadata.githubRepositories.map((entry) => entry.canonicalUrl), [
    "https://github.com/julyx10/lap2",
    "https://github.com/nyblnet/bento",
  ]);
  assert.ok(metadata.dates.some((entry) => entry.value === "2026年8月25日" && entry.origin === "input"));
  assert.ok(metadata.dates.some((entry) => entry.value === "2026-08-24" && entry.origin === "input"));
  assert.ok(metadata.projectCandidates.some((entry) => entry.name === "Lap" && entry.evidence === "markdown-link"));
  assert.ok(metadata.projectCandidates.some((entry) => entry.name === "bento" && entry.evidence === "github-repository-slug"));
  const prompt = collectionPrompt(rules, input, { version: 1, metadata });
  assert.ok(prompt.includes(rules));
  assert.ok(prompt.includes(input));
});

test("workspace URL preflight returns bounded exact matches instead of file contents", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "indexes"), { recursive: true });
  await writeFile(path.join(directory, "indexes", "projects.md"), [
    "# Projects",
    "- https://github.com/example/one",
    "- https://github.com/example/two",
  ].join("\n"), "utf8");
  const result = await findExactWorkspaceUrlMatches(directory, [
    "https://github.com/example/one",
    "https://github.com/example/missing",
  ]);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0], {
    url: "https://github.com/example/one",
    path: "indexes/projects.md",
    line: 2,
  });
  assert.equal(Object.hasOwn(result.matches[0], "content"), false);
});

test("GitHub verification batches concise reachability and redirect results", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    return {
      ok: true,
      status: 200,
      url: url.endsWith("/old") ? "https://github.com/example/new" : url,
    };
  };
  const results = await verifyGithubRepositories([
    { canonicalUrl: "https://github.com/example/old" },
    { canonicalUrl: "https://github.com/example/two" },
  ], { fetchImpl, timeoutMs: 500 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((entry) => entry.method === "HEAD"));
  assert.equal(results[0].redirected, true);
  assert.equal(results[0].canonicalUrl, "https://github.com/example/new");
  assert.deepEqual(Object.keys(results[0]).sort(), ["canonicalUrl", "httpStatus", "redirected", "requestedUrl", "status"]);
});

test("collection preflight and execution profile keep routine work fast and escalate conflicts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preflight = await prepareCollectionPreflight({
    workspacePath: directory,
    sourceMarkdown: "# rules",
    userInput: "https://github.com/a/tool https://github.com/b/tool",
    fetchImpl: async (url) => ({ ok: true, status: 200, url }),
  });
  const complex = selectCollectionExecutionProfile(preflight, "# rules", "检查同名冲突", {});
  assert.equal(complex.profile, "complex");
  assert.equal(complex.model, "gpt-5.6-sol");
  assert.equal(complex.effort, "high");
  const routine = selectCollectionExecutionProfile(preflight, "# rules", "归档两个项目", { CODEX_PIN_COLLECTION_PROFILE: "routine" });
  assert.equal(routine.profile, "routine");
  assert.equal(routine.model, "gpt-5.6-terra");
  assert.equal(routine.effort, "medium");
  assert.deepEqual(collectionRuntimeOptions({ CODEX_PIN_COLLECTION_COMPACT_TOKENS: "75000" }), {
    compactTokenLimit: 75_000,
    compactTokenLimitScope: "body_after_prefix",
  });
});

test("collection execution follows the desktop model selection when no environment override is set", () => {
  assert.deepEqual(parseDesktopExecutionPreference("5.6 Sol 高"), {
    source: "desktop-ui",
    label: "5.6 Sol 高",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  assert.deepEqual(parseDesktopExecutionPreference("GPT-5.6 Terra medium"), {
    source: "desktop-ui",
    label: "GPT-5.6 Terra medium",
    model: "gpt-5.6-terra",
    effort: "medium",
  });
  assert.equal(parseDesktopExecutionPreference("自动"), null);
  const desktop = parseDesktopExecutionPreference("5.6 Luna 低");
  const selected = selectCollectionExecutionProfile({}, "# rules", "归档", {}, desktop);
  assert.equal(selected.profile, "desktop-selection");
  assert.equal(selected.model, "gpt-5.6-luna");
  assert.equal(selected.effort, "low");
  const overridden = selectCollectionExecutionProfile(
    {},
    "# rules",
    "归档",
    { CODEX_PIN_COLLECTION_MODEL: "gpt-5.6-sol", CODEX_PIN_COLLECTION_EFFORT: "high" },
    desktop,
  );
  assert.equal(overridden.model, "gpt-5.6-sol");
  assert.equal(overridden.effort, "high");
});

test("ordinary Markdown collection sources must resolve uniquely inside the workspace", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = path.join(directory, "rules");
  await mkdir(nested, { recursive: true });
  const source = path.join(nested, "topic.md");
  await writeFile(source, "# rules", "utf8");
  assert.equal(await resolveCollectionSourceInWorkspace(directory, "topic.md"), source);
  await mkdir(path.join(directory, "duplicate"), { recursive: true });
  await writeFile(path.join(directory, "duplicate", "topic.md"), "# duplicate", "utf8");
  await assert.rejects(
    resolveCollectionSourceInWorkspace(directory, "topic.md"),
    /存在 2 个同名文件/,
  );
  await assert.rejects(
    resolveCollectionSourceInWorkspace(directory, "../topic.md"),
    /不是可用的 Markdown/,
  );
});

test("Windows npm installation resolves to the JS entry instead of a cmd shim", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appData = path.join(directory, "AppData", "Roaming");
  const entry = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "// fake codex", "utf8");
  const cli = resolveCodexCli({
    platform: "win32",
    environment: { APPDATA: appData, PATH: "" },
    homeDirectory: directory,
  });
  assert.equal(cli.command, process.execPath);
  assert.equal(cli.prefixArgs[0], entry);
  assert.equal(cli.source, "npm-global");
});

test("Windows Store bundled CLI is not treated as an independent CLI", () => {
  const bundled = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0_x64__abc\app\resources\codex.exe`;
  const cli = resolveCodexCli({
    platform: "win32",
    environment: { PATH: path.win32.dirname(bundled) },
    pathExists: (candidate) => candidate.toLowerCase() === bundled.toLowerCase(),
  });
  assert.equal(cli, null);
});

test("missing independent CLI returns an explicit error instead of using Desktop", async () => {
  const result = await probeCodexCli(null);
  assert.equal(result.ok, false);
  assert.match(result.error, /未检测到独立 Codex CLI/);
});

test("App Server client creates a fresh thread for every collection item", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-app-server-"));
  const fakeServer = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeServer, `
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    if (!process.argv.includes("model_auto_compact_token_limit=100000")) process.exit(9);
    if (!process.argv.includes('model_auto_compact_token_limit_scope="body_after_prefix"')) process.exit(10);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let threadSequence = 0;
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      if (message.method === "initialize") {
        send({ id: message.id, result: { platformFamily: "test" } });
        return;
      }
      if (message.method === "thread/start") {
        if (message.params.sandbox !== "workspaceWrite") process.exit(3);
        if (message.params.model !== "gpt-5.6-terra") process.exit(7);
        const threadId = "thread_" + (++threadSequence);
        send({ id: message.id, result: { thread: { id: threadId } } });
        return;
      }
      if (message.method === "turn/start") {
        if (message.params.sandboxPolicy?.type !== "workspaceWrite") process.exit(4);
        if (message.params.sandboxPolicy?.writableRoots?.[0] !== ${JSON.stringify(directory)}) process.exit(5);
        if (message.params.sandboxPolicy?.networkAccess !== true) process.exit(6);
        if (message.params.model !== "gpt-5.6-terra" || message.params.effort !== "medium") process.exit(8);
        const threadId = message.params.threadId;
        const turnId = "turn_" + threadId;
        const prompt = message.params.input[0].text;
        send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        send({ method: "item/started", params: { threadId, turnId, item: {
          type: "commandExecution", id: "tool_" + threadId, status: "inProgress"
        } } });
        send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: {
          last: { inputTokens: 1200, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 1240 },
          total: { inputTokens: 1200, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 1240 },
          modelContextWindow: 400000
        } } });
        send({ method: "item/completed", params: { threadId, turnId, item: {
          type: "contextCompaction", id: "compact_" + threadId
        } } });
        send({ method: "item/completed", params: { threadId, turnId, item: {
          type: "fileChange", id: "change_" + threadId, status: "completed",
          changes: [{ path: "sources/example.md", kind: "add", diff: "+content" }]
        } } });
        send({ method: "item/completed", params: { threadId, turnId, item: {
          type: "agentMessage", id: "answer_" + threadId, phase: "final_answer", text: "result:" + prompt.slice(-3)
        } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
    });
  `, "utf8");

  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer, source: "test" },
    cwd: directory,
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const execution = { model: "gpt-5.6-terra", effort: "medium" };
  const progress = [];
  const first = await client.runFreshCollection({
    prompt: "first-甲",
    cwd: directory,
    timeoutMs: 2_000,
    ...execution,
    onProgress: (event) => progress.push(event),
  });
  const second = await client.runFreshCollection({ prompt: "second-乙", cwd: directory, timeoutMs: 2_000, ...execution });
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(first.output, "result:t-甲");
  assert.equal(second.output, "result:d-乙");
  assert.deepEqual(first.fileChanges, [{ path: "sources/example.md", kind: "add" }]);
  assert.equal(first.metrics.compactionCount, 1);
  assert.equal(first.metrics.tokenUsage.total.inputTokens, 1200);
  assert.ok(first.metrics.firstToolMs >= 0);
  assert.ok(first.metrics.firstWriteMs >= 0);
  assert.ok(progress.some((event) => event.type === "app-server-ready"));
  assert.ok(progress.some((event) => event.type === "thread-started"));
  assert.ok(progress.some((event) => event.type === "turn-started"));
  assert.ok(progress.some((event) => event.type === "item" && event.itemType === "commandExecution"));
  assert.ok(progress.some((event) => event.type === "item" && event.itemType === "fileChange" && event.changes[0]?.path === "sources/example.md"));
  assert.ok(progress.some((event) => event.type === "turn-completed"));
});

test("App Server initialization timeout cleans up the child process", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-app-server-timeout-"));
  const fakeServer = path.join(directory, "silent-codex.mjs");
  await writeFile(fakeServer, `
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  `, "utf8");
  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer },
    cwd: directory,
    requestTimeoutMs: 60,
  });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(client.start(), /请求超时：initialize/);
  assert.equal(client.child, null);
});

test("an aborted collection turn is interrupted instead of blocking the queue", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-app-server-abort-"));
  const fakeServer = path.join(directory, "abortable-codex.mjs");
  const interruptMarker = path.join(directory, "interrupted.txt");
  await writeFile(fakeServer, `
    import { writeFileSync } from "node:fs";
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-abort" } } });
      if (message.method === "turn/start") return send({ id: message.id, result: { turn: { id: "turn-abort" } } });
      if (message.method === "turn/interrupt") {
        writeFileSync(${JSON.stringify(interruptMarker)}, "yes");
        return send({ id: message.id, result: {} });
      }
    });
  `, "utf8");
  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer },
    cwd: directory,
    requestTimeoutMs: 500,
  });
  const controller = new AbortController();
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    client.runFreshCollection({
      prompt: "abort me",
      cwd: directory,
      timeoutMs: 2_000,
      signal: controller.signal,
      onTurnStarted: () => controller.abort(),
    }),
    /采集任务已取消/,
  );
  assert.equal(await readFile(interruptMarker, "utf8"), "yes");
});

test("App Server client waits through retryable errors until the turn completes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-retryable-error-"));
  const fakeServer = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeServer, `
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "thread/start") {
        return send({ id: message.id, result: { thread: { id: "retry_thread" } } });
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "retry_turn", status: "inProgress" } } });
        send({ method: "error", params: {
          threadId: "retry_thread",
          turnId: "retry_turn",
          willRetry: true,
          error: { message: "Reconnecting... 2/5" }
        } });
        setTimeout(() => {
          send({ method: "item/completed", params: { threadId: "retry_thread", turnId: "retry_turn", item: {
            type: "agentMessage", id: "answer", phase: "final_answer", text: "recovered-ok"
          } } });
          send({ method: "turn/completed", params: {
            threadId: "retry_thread", turn: { id: "retry_turn", status: "completed" }
          } });
        }, 20);
        return;
      }
      if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
    });
  `, "utf8");
  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer, source: "test" },
    cwd: directory,
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await client.runFreshCollection({ prompt: "retry", cwd: directory, timeoutMs: 2_000 });
  assert.equal(result.output, "recovered-ok");
});

test("App Server client still rejects terminal error notifications", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-terminal-error-"));
  const fakeServer = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeServer, `
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "thread/start") {
        return send({ id: message.id, result: { thread: { id: "failed_thread" } } });
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "failed_turn", status: "inProgress" } } });
        send({ method: "error", params: {
          threadId: "failed_thread",
          turnId: "failed_turn",
          willRetry: false,
          error: { message: "terminal failure" }
        } });
        return;
      }
      if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
    });
  `, "utf8");
  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer, source: "test" },
    cwd: directory,
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    client.runFreshCollection({ prompt: "fail", cwd: directory, timeoutMs: 2_000 }),
    /terminal failure/,
  );
});

test("App Server client falls back to legacy kebab-case sandbox names", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-legacy-app-server-"));
  const fakeServer = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeServer, `
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "thread/start") {
        if (message.params.sandbox === "workspaceWrite") {
          return send({ id: message.id, error: { message: "unknown variant workspaceWrite, expected workspace-write" } });
        }
        if (message.params.sandbox !== "workspace-write") process.exit(3);
        return send({ id: message.id, result: { thread: { id: "legacy_thread" } } });
      }
      if (message.method === "turn/start") {
        if (message.params.sandboxPolicy?.type === "workspaceWrite") {
          return send({ id: message.id, error: { message: "unknown variant workspaceWrite, expected workspace-write" } });
        }
        if (message.params.sandboxPolicy?.type !== "workspace-write") process.exit(4);
        send({ id: message.id, result: { turn: { id: "legacy_turn", status: "inProgress" } } });
        send({ method: "item/completed", params: { threadId: "legacy_thread", turnId: "legacy_turn", item: {
          type: "agentMessage", id: "answer", phase: "final_answer", text: "legacy-ok"
        } } });
        send({ method: "turn/completed", params: { threadId: "legacy_thread", turn: { id: "legacy_turn", status: "completed" } } });
      }
    });
  `, "utf8");
  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer, source: "test" },
    cwd: directory,
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await client.runFreshCollection({ prompt: "legacy", cwd: directory, timeoutMs: 2_000 });
  assert.equal(result.output, "legacy-ok");
});

test("App Server negotiates thread and turn sandbox names independently", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-pin-hybrid-app-server-"));
  const fakeServer = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeServer, `
    import readline from "node:readline";
    if (process.argv[2] !== "app-server") process.exit(2);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "thread/start") {
        if (message.params.sandbox === "workspaceWrite") {
          return send({ id: message.id, error: { message: "unknown variant workspaceWrite, expected workspace-write" } });
        }
        if (message.params.sandbox !== "workspace-write") process.exit(3);
        return send({ id: message.id, result: { thread: { id: "hybrid_thread" } } });
      }
      if (message.method === "turn/start") {
        if (message.params.sandboxPolicy?.type !== "workspaceWrite") process.exit(4);
        send({ id: message.id, result: { turn: { id: "hybrid_turn", status: "inProgress" } } });
        send({ method: "item/completed", params: { threadId: "hybrid_thread", turnId: "hybrid_turn", item: {
          type: "agentMessage", id: "answer", phase: "final_answer", text: "hybrid-ok"
        } } });
        send({ method: "turn/completed", params: { threadId: "hybrid_thread", turn: { id: "hybrid_turn", status: "completed" } } });
      }
    });
  `, "utf8");
  const client = new CodexAppServerClient({
    cli: { command: process.execPath, prefixArgs: [fakeServer], displayPath: fakeServer, source: "test" },
    cwd: directory,
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await client.runFreshCollection({ prompt: "hybrid", cwd: directory, timeoutMs: 2_000 });
  assert.equal(result.output, "hybrid-ok");
});

test("collection submission stops the native send path", () => {
  const segment = injectionSource.match(/async function prepareCollectionSubmit[\s\S]+?function refresh/)?.[0] || "";
  assert.match(segment, /event\.preventDefault\(\)/);
  assert.match(segment, /event\.stopImmediatePropagation\(\)/);
  assert.match(segment, /requestCollection\("enqueue"/);
  assert.match(segment, /replaceComposerValueImmediately\(editor, ""\)/);
  assert.match(segment, /composerCleared: true/);
  assert.match(segment, /desktopExecutionLabel\(rootNode\)/);
  assert.match(injectionSource, /desktop-execution-selection/);
  assert.match(launcherSource, /parseDesktopExecutionPreference\(desktopExecutionLabel\)/);
  assert.match(launcherSource, /item\.desktopExecutionPreference \|\| null/);
  assert.doesNotMatch(segment, /button\.click\(\)/);
  assert.match(injectionSource, /window\.addEventListener\("pointerdown", handleCollectionPointerSubmit, true\)/);
  assert.match(injectionSource, /window\.addEventListener\("mousedown", handleCollectionPointerSubmit, true\)/);
  assert.match(injectionSource, /window\.addEventListener\("pointerup", handleCollectionPointerSubmit, true\)/);
  assert.match(injectionSource, /window\.addEventListener\("submit", handleNativeFormSubmit, true\)/);
  assert.match(injectionSource, /window\.addEventListener\("keyup", handleCollectionKeyup, true\)/);
  assert.match(injectionSource, /window\.addEventListener\("beforeinput", handleCollectionBeforeInput, true\)/);
  assert.match(injectionSource, /COLLECTION_SEND_GUARD_ATTRIBUTE/);
  assert.match(injectionSource, /COLLECTION_SEND_OVERLAY_ATTRIBUTE/);
  assert.match(injectionSource, /pointer-events:none!important/);
  assert.match(injectionSource, /document\.body\.appendChild\(overlay\)/);
  assert.match(injectionSource, /发送到采集队列/);
  assert.match(injectionSource, /window\.addEventListener\("input", handleCollectionComposerInput, true\)/);
  assert.match(injectionSource, /button\.disabled = true/);
  assert.match(injectionSource, /button\.setAttribute\("aria-disabled", "true"\)/);
  assert.match(injectionSource, /function restoreNativeCollectionSend/);
  assert.match(injectionSource, /new MutationObserver\(\(\) => \{\s+if \(collectionState\.enabled\) guardNativeCollectionSend\(\)/);
  assert.match(injectionSource, /function handleCollectionComposerInput\(\) \{\s+if \(!collectionState\.enabled\) return;\s+guardNativeCollectionSend\(\)/);
  assert.match(injectionSource, /target\?\.closest\?\.\(`\[\$\{COLLECTION_SEND_OVERLAY_ATTRIBUTE\}/);
  assert.match(injectionSource, /button\?\.hasAttribute\(COLLECTION_SEND_OVERLAY_ATTRIBUTE\)/);
  assert.match(injectionSource, /guardedSendButtonAtPoint/);
  assert.match(launcherSource, /composerAlreadyCleared\s*\?\s*\{ cleared: true, method: "injection" \}/);
  assert.match(injectionSource, /sourceFileName/);
  assert.match(injectionSource, /\(revisionButton \|\| source\)\.insertAdjacentElement\("beforebegin", collectionButton\)/);
  assert.doesNotMatch(injectionSource, /采集模式当前使用.+是否切换到/);
  assert.match(injectionSource, /const action = sameSource \? "disable" : "enable"/);
  assert.match(injectionSource, /function addCollectionCard\(\)/);
  assert.match(injectionSource, /codex-chat-pin-collection-file/);
  assert.match(injectionSource, /collectionState\.counts\?\.failed/);
});

test("collection status card can retry failures and clear the queue", () => {
  assert.match(injectionSource, /data-collection-action="retry"/);
  assert.match(injectionSource, /data-collection-action="clear"/);
  assert.match(injectionSource, /requestCollection\("retry"\)/);
  assert.match(injectionSource, /requestCollection\("clear"\)/);
  assert.match(launcherSource, /async function retryFailedCollection/);
  assert.match(launcherSource, /retryFailedCollectionItems\(queue\.items, retriedAt\)/);
  assert.match(launcherSource, /async function clearCollectionQueue/);
  assert.match(launcherSource, /clearCollectionItems\(queue\)/);
  assert.match(launcherSource, /collectionItemControllers\.get\(item\.id\)\?\.abort\(\)/);
  assert.match(launcherSource, /collectionItemIsCurrent\(queue, item, generation\)/);
  assert.match(launcherSource, /collectionAction === "retry"/);
  assert.match(launcherSource, /collectionAction === "clear"/);
});

test("collection execution reports can be hidden or cleared without cancelling pending work", () => {
  const queue = {
    generation: 4,
    items: [
      { id: "done-1", status: "completed", output: "report" },
      { id: "queued-1", status: "queued" },
      { id: "failed-1", status: "failed" },
      { id: "done-2", status: "completed", output: "report 2" },
    ],
  };
  assert.equal(clearCompletedCollectionItems(queue), 2);
  assert.equal(queue.generation, 4);
  assert.deepEqual(queue.items.map((item) => item.id), ["queued-1", "failed-1"]);
  assert.match(injectionSource, /data-results-action="collapse"/);
  assert.match(injectionSource, /data-results-action="clear"/);
  assert.match(injectionSource, /data-results-action="close"/);
  assert.match(injectionSource, /requestCollection\("clear-reports"\)/);
  assert.match(injectionSource, /collectionResultsHidden = true/);
  assert.match(injectionSource, /const collectionResultOpenState = new Map\(\)/);
  assert.match(injectionSource, /details\.open = collectionResultOpenState\.has\(resultId\)/);
  assert.match(injectionSource, /details\.addEventListener\("toggle"/);
  assert.match(injectionSource, /if \(list\.dataset\.renderKey === renderKey\) return/);
  assert.match(launcherSource, /async function clearCollectionReports/);
  assert.match(launcherSource, /collectionAction === "clear-reports"/);
  assert.match(launcherSource, /"clear-reports"/);
});

test("active collection status is periodically reconciled after missed runtime events", () => {
  assert.match(injectionSource, /function scheduleCollectionStatusPoll\(delayMs = 2_000\)/);
  assert.match(injectionSource, /Number\(collectionState\.pendingCount \|\| 0\) <= 0/);
  assert.match(injectionSource, /collectionStatusSessionId = "";\s+void syncCollectionStatus\(\)/);
  assert.match(injectionSource, /if \(!collectionState\.enabled\) collectionState = \{ enabled: false \}/);
  assert.match(injectionSource, /clearTimeout\(collectionStatusPollTimer\)/);
  assert.match(injectionSource, /preparing: "准备 CLI 与预处理"/);
  assert.match(injectionSource, /"starting-turn": "启动独立任务"/);
  assert.match(injectionSource, /executing: "独立 CLI 执行中"/);
  assert.match(launcherSource, /runningStartedAt: runningItem\?\.startedAt \|\| ""/);
  assert.match(launcherSource, /runningPhase: runningItem\?\.phase \|\| ""/);
  assert.match(launcherSource, /item\.phase = "preparing"/);
  assert.match(launcherSource, /item\.phase = "starting-turn"/);
  assert.match(launcherSource, /item\.phase = "executing"/);
  assert.match(injectionSource, /if \(fileNode\.textContent !== fileText\) fileNode\.textContent = fileText/);
});

test("collection launcher prints bounded terminal progress and heartbeats", () => {
  assert.match(launcherSource, /function collectionTerminalLog/);
  assert.match(launcherSource, /HEARTBEAT/);
  assert.match(launcherSource, /QUEUED \| rule=/);
  assert.match(launcherSource, /APP SERVER ready/);
  assert.match(launcherSource, /TOOL #\$\{terminalState\.toolEvents\} started/);
  assert.match(launcherSource, /WRITE \$\{change\.kind/);
  assert.match(launcherSource, /DONE \$\{collectionDuration/);
  assert.match(launcherSource, /FAILED \$\{collectionDuration/);
  assert.match(collectionModeSource, /onProgress/);
  assert.match(collectionModeSource, /type: "retry"/);
  assert.doesNotMatch(launcherSource, /collectionTerminalLog\(item,\s*item\.input/);
});

test("collection mode persists per task and completed execution reports stay visible", () => {
  assert.match(launcherSource, /mode: persistedCollectionMode\(queue\.mode\)/);
  assert.match(launcherSource, /queue\.mode = persistedCollectionMode\(mode\)/);
  assert.match(launcherSource, /collectionModes\.set\(mode\.sessionId, mode\)/);
  assert.match(launcherSource, /let mode = collectionModes\.get\(safeId\)/);
  assert.match(launcherSource, /mode = \{ \.\.\.queue\.mode, cdp \}/);
  assert.match(launcherSource, /queue\.items\.some\(\(item\) => item\.status === "queued"\)\) scheduleCollectionPump\(\)/);
  assert.doesNotMatch(injectionSource, /data-collection-action="open-result"/);
  assert.doesNotMatch(injectionSource, /requestCollection\("open-result"/);
  assert.match(injectionSource, /已完成 \$\{completed\} 项/);
  assert.match(launcherSource, /async function openCollectionResult/);
  assert.match(launcherSource, /collectionAction === "open-result"/);
  assert.match(launcherSource, /collectionCapabilities = Object\.freeze\(\["retry", "clear", "clear-reports", "persistent-mode", "workspace-write", "execution-reports", "collection-performance", "desktop-execution-selection"\]\)/);
  assert.match(injectionSource, /function collectionSupports\(capability\)/);
  assert.match(injectionSource, /collectionSupports\("workspace-write"\)/);
  assert.match(injectionSource, /启动器仍是旧版只读采集/);
  assert.match(launcherSource, /const workspacePath = item\.workspacePath \|\| queue\.workspacePath \|\| collectionWorkspaceDirectory/);
  assert.match(launcherSource, /results: await collectionResultsForQueue\(queue\)/);
  assert.match(launcherSource, /item\.output = String\(result\.output/);
  assert.doesNotMatch(launcherSource, /appendCollectionResult\(queue, item, result\.output\)/);
  assert.match(launcherSource, /recoverCollectionItems\(items, stored\?\.version\)/);
  const enableSegment = launcherSource.match(/async function enableCollection[\s\S]+?async function disableCollection/)?.[0] || "";
  assert.match(enableSegment, /requireCollectionCli\(\)/);
  assert.doesNotMatch(enableSegment, /await ensureCollectionBackend\(\)/);
  assert.match(injectionSource, /function addCollectionResultCards\(\)/);
  assert.match(injectionSource, /采集执行报告（本地）/);
  assert.match(injectionSource, /upsertCollectionResult\(message\.item\)/);
  assert.match(injectionSource, /COLLECTION_RESULTS_ATTRIBUTE/);
  assert.match(launcherSource, /samePath\(path\.dirname\(filePath\), collectionDirectory\)[\s\S]+collectionGitExcludeRule/);
  assert.match(launcherSource, /rule === visibility\.protectRule/);
});

test("failed collection items can be requeued without changing completed items", () => {
  const failed = {
    status: "failed",
    error: "old failure",
    startedAt: "start",
    completedAt: "end",
    threadId: "thread",
    turnId: "turn",
    output: "old report",
    outputTruncated: true,
  };
  const completed = { status: "completed", error: "" };
  const retriedCount = retryFailedCollectionItems([failed, completed], "retry-time");
  assert.equal(retriedCount, 1);
  assert.deepEqual(failed, {
    status: "queued",
    error: "",
    startedAt: null,
    completedAt: null,
    threadId: null,
    turnId: null,
    output: "",
    outputTruncated: false,
    changedFiles: [],
    executionProfile: null,
    preflightSummary: null,
    metrics: null,
    retriedAt: "retry-time",
    retryCount: 1,
  });
  assert.deepEqual(completed, { status: "completed", error: "" });
});

test("legacy read-only queues require an explicit retry before gaining write access", () => {
  const items = [
    { id: "old-queued", status: "queued", startedAt: null },
    { id: "old-running", status: "running", startedAt: "old" },
    { id: "old-completed", status: "completed" },
  ];
  assert.equal(recoverCollectionItems(items, 4, "upgrade-time"), 2);
  assert.deepEqual(items[0], {
    id: "old-queued",
    status: "failed",
    startedAt: null,
    completedAt: "upgrade-time",
    error: "采集模式已升级为工作区写入；请确认规则后点击重试",
  });
  assert.equal(items[1].status, "failed");
  assert.equal(items[2].status, "completed");

  const current = [{ id: "current-running", status: "running", startedAt: "old" }];
  assert.equal(recoverCollectionItems(current, 5, "restart-time"), 1);
  assert.deepEqual(current[0], {
    id: "current-running",
    status: "queued",
    startedAt: null,
    error: "启动器重启后重新排队",
  });
});

test("clearing a collection queue invalidates an in-flight item", () => {
  const running = { id: "running", status: "running" };
  const queue = { generation: 4, items: [running, { id: "failed", status: "failed" }] };
  assert.equal(collectionItemIsCurrent(queue, running, 4), true);
  assert.equal(clearCollectionItems(queue), 2);
  assert.equal(queue.generation, 5);
  assert.deepEqual(queue.items, []);
  assert.equal(collectionItemIsCurrent(queue, running, 4), false);
});
