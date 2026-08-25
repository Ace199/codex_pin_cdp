#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexDesktop } from "./codex-app.mjs";
import {
  CodexAppServerClient,
  clearCompletedCollectionItems,
  clearCollectionItems,
  collectionItemIsCurrent,
  collectionPrompt,
  collectionRuntimeOptions,
  parseDesktopExecutionPreference,
  prepareCollectionPreflight,
  probeCodexCli,
  recoverCollectionItems,
  resolveCollectionSourceInWorkspace,
  resolveCodexCli,
  retryFailedCollectionItems,
  selectCollectionExecutionProfile,
} from "./collection-mode.mjs";
import { CdpPipeBrowser } from "./cdp-pipe.mjs";
import { CdpWebSocketBrowser } from "./cdp-websocket.mjs";
import {
  composerHasRevisionMessage,
  contentHash,
  REVISION_MARKER,
  revisionInstruction,
  revisionMessage,
  withoutRevisionInstruction,
  workspaceRelativeFile,
} from "./revision-mode.mjs";
import { activateWindowsApp } from "./windows-app-activation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = process.env.CODEX_PIN_PROFILE
  ? path.resolve(process.env.CODEX_PIN_PROFILE)
  : path.join(root, ".codex-pin-profile");
const userScriptPath = path.join(root, "inject", "codex-pin.user.js");
const pinDirectory = path.join(root, "pins");
const legacyPinDirectory = path.join(root, "temp");
const revisionHistoryDirectory = path.join(profilePath, "revision-history");
const collectionQueueDirectory = path.join(profilePath, "collection-queue");
const collectionWorkspaceDirectory = path.join(profilePath, "collection-workspace");
const collectionDirectory = path.join(root, "collections"); // Legacy result location; no new files are written here.
const localGitExcludePath = path.join(root, ".git", "info", "exclude");
const pinGitExcludeRule = "/pins/pin_*.md";
const collectionGitExcludeRule = "/collections/collection_*.md";
const collectionProtocolVersion = 7;
const collectionCapabilities = Object.freeze(["retry", "clear", "clear-reports", "persistent-mode", "workspace-write", "execution-reports", "collection-performance", "desktop-execution-selection"]);
const argv = process.argv.slice(2);
const args = new Set(argv);
const shouldLaunch = args.has("--launch");
const shouldWatch = args.has("--watch");
const forceWindowsActivation = args.has("--windows-activation");
const writeQueues = new Map();
const revisionStates = new Map();
const collectionModes = new Map();
const collectionQueues = new Map();
const collectionQueueLoads = new Map();
const collectionItemControllers = new Map();
let pinVisibilityQueue = Promise.resolve();
let collectionPump = null;
let collectionBackend = null;
let collectionBackendPromise = null;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function collectionDuration(milliseconds) {
  const numeric = Math.max(0, Number(milliseconds || 0));
  if (numeric < 1000) return `${Math.round(numeric)}ms`;
  const totalSeconds = Math.floor(numeric / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function collectionTerminalLog(item, message, level = "log") {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const itemId = String(item?.id || "unknown").replace(/^collect_/, "").slice(-8);
  const line = `[Chat Pin][Collection ${itemId}][${timestamp}] ${message}`;
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(line);
}

function optionValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个路径参数。`);
  return value;
}

const codexDesktop = resolveCodexDesktop({ explicitPath: optionValue("--app-path") });
const appPath = codexDesktop.executablePath;

function isCodexRenderer(target) {
  return target.type === "page"
    && !target.url?.includes("initialRoute=%2Fglobal-dictation")
    && !target.url?.includes("initialRoute=%2Favatar-overlay")
    && (target.url?.startsWith("app://") || target.title === "Codex");
}

function safeSessionId(value) {
  const raw = String(value || "").trim();
  if (/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(raw)) return raw;
  return `session_${createHash("sha256").update(raw || "unknown").digest("hex").slice(0, 20)}`;
}

function pinFileFor(sessionId) {
  return path.join(pinDirectory, `pin_${safeSessionId(sessionId)}.md`);
}

async function preparePinStorage() {
  await Promise.all([
    mkdir(pinDirectory, { recursive: true }),
    mkdir(collectionQueueDirectory, { recursive: true }),
    mkdir(collectionWorkspaceDirectory, { recursive: true }),
  ]);

  if (existsSync(localGitExcludePath)) {
    try {
      const current = await readFile(localGitExcludePath, "utf8");
      const rules = current.split(/\r?\n/).map((line) => line.trim());
      const missingRules = [pinGitExcludeRule, collectionGitExcludeRule].filter((rule) => !rules.includes(rule));
      if (missingRules.length) {
        const separator = current && !current.endsWith("\n") ? "\n" : "";
        await writeFile(localGitExcludePath, `${current}${separator}${missingRules.join("\n")}\n`, "utf8");
      }
    } catch (error) {
      console.warn(`Chat Pin could not update .git/info/exclude: ${error.message}`);
    }
  }

  if (!existsSync(legacyPinDirectory)) return;
  for (const entry of await readdir(legacyPinDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^pin_.+\.md$/i.test(entry.name) || /_probe\.md$/i.test(entry.name)) continue;
    const source = path.join(legacyPinDirectory, entry.name);
    const destination = path.join(pinDirectory, entry.name);
    try {
      await stat(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(source, destination);
    }
  }
}

await preparePinStorage();

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function gitContextForWorkspace(workspacePath) {
  const topLevelResult = spawnSync("git", [
    "-C",
    workspacePath,
    "rev-parse",
    "--show-toplevel",
  ], { encoding: "utf8", windowsHide: true });
  const excludeResult = spawnSync("git", [
    "-C",
    workspacePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ], { encoding: "utf8", windowsHide: true });
  if (topLevelResult.status !== 0 || !topLevelResult.stdout?.trim()
    || excludeResult.status !== 0 || !excludeResult.stdout?.trim()) return null;
  const topLevel = path.resolve(topLevelResult.stdout.trim());
  const excludeValue = excludeResult.stdout.trim();
  const excludePath = path.isAbsolute(excludeValue)
    ? excludeValue
    : path.resolve(workspacePath, excludeValue);
  return { topLevel, excludePath };
}

function indexVisibilityRules(filePath, workspacePath) {
  const gitContext = gitContextForWorkspace(workspacePath);
  if (!gitContext) return null;
  const relative = path.relative(gitContext.topLevel, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const exactRule = `/${relative.replaceAll("\\", "/")}`;
  const rootProtectRule = samePath(workspacePath, root)
    && samePath(path.dirname(filePath), collectionDirectory)
    ? collectionGitExcludeRule
    : pinGitExcludeRule;
  return {
    excludePath: gitContext.excludePath,
    exactRule,
    protectRule: samePath(workspacePath, root) ? rootProtectRule : exactRule,
  };
}

function gitIgnoreReason(filePath, workspacePath) {
  const result = spawnSync("git", [
    "-C",
    workspacePath,
    "check-ignore",
    "-v",
    "--no-index",
    "--",
    filePath,
  ], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout?.trim()) return "";
  return result.stdout.trim().split(/\r?\n/).at(-1) || "";
}

async function protectWorkspaceFileInGit(filePath, workspacePath) {
  const visibility = indexVisibilityRules(filePath, workspacePath);
  if (!visibility?.excludePath || !visibility.protectRule) return;
  try {
    const current = await readFile(visibility.excludePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const rules = current.split(/\r?\n/).map((line) => line.trim());
    if (rules.includes(visibility.protectRule)) return;
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    await mkdir(path.dirname(visibility.excludePath), { recursive: true });
    await writeFile(visibility.excludePath, `${current}${separator}${visibility.protectRule}\n`, "utf8");
  } catch (error) {
    console.warn(`Chat Pin could not protect a collection result in Git: ${error.message}`);
  }
}

async function withPinVisibleToNativeIndexer(filePath, workspacePath, action) {
  const run = async () => {
    const visibility = indexVisibilityRules(filePath, workspacePath);
    const removedRules = [];
    try {
      if (visibility?.excludePath && existsSync(visibility.excludePath)) {
        const current = await readFile(visibility.excludePath, "utf8");
        const newline = current.includes("\r\n") ? "\r\n" : "\n";
        const lines = current.split(/\r?\n/);
        const filtered = lines.filter((line) => {
          const rule = line.trim();
          const shouldRemove = rule === visibility.exactRule
            || (samePath(workspacePath, root) && rule === visibility.protectRule);
          if (shouldRemove) removedRules.push(line);
          return !shouldRemove;
        });
        if (filtered.length !== lines.length) {
          await writeFile(visibility.excludePath, filtered.join(newline), "utf8");
          // Codex maintains its own workspace file list. Give its watcher one
          // short turn to observe the local exclude change before searching.
          await delay(120);
        }
      }
      const remainingIgnoreReason = gitIgnoreReason(filePath, workspacePath);
      const result = await action();
      if (result?.ok !== true && remainingIgnoreReason) {
        return {
          ...result,
          error: `${result?.error || "原生文件打开失败"}；该镜像仍被工作区忽略规则排除：${remainingIgnoreReason}`,
        };
      }
      return result;
    } finally {
      if (visibility?.excludePath) {
        try {
          const current = await readFile(visibility.excludePath, "utf8").catch((error) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          const rules = current.split(/\r?\n/).map((line) => line.trim());
          const restore = [...removedRules, visibility.protectRule]
            .filter((rule, index, all) => rule && all.indexOf(rule) === index)
            .filter((rule) => !rules.includes(rule.trim()));
          if (restore.length) {
            const separator = current && !current.endsWith("\n") ? "\n" : "";
            await mkdir(path.dirname(visibility.excludePath), { recursive: true });
            await writeFile(visibility.excludePath, `${current}${separator}${restore.join("\n")}\n`, "utf8");
          }
        } catch (error) {
          console.warn(`Chat Pin could not protect the workspace Pin mirror in Git: ${error.message}`);
        }
      }
    }
  };
  const pending = pinVisibilityQueue.then(run, run);
  pinVisibilityQueue = pending.catch(() => {});
  return pending;
}

async function postHostMessage(cdp, message) {
  const payload = JSON.stringify(message);
  await cdp.send("Runtime.evaluate", {
    expression: `window.__codexChatPinInjection__?.receiveHostMessage(${JSON.stringify(payload)})`,
    awaitPromise: true,
  });
}

async function evaluateValue(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Codex renderer evaluation failed");
  return result.result?.value;
}

async function nativeWorkspaceContext(cdp) {
  return evaluateValue(cdp, `(async () => {
    let workspacePath = '';
    try {
      const url = new URL(location.href);
      workspacePath = url.searchParams.get('workspace') || url.searchParams.get('cwd') || '';
    } catch (_) {}
    const thread = document.querySelector("[data-app-action-sidebar-thread-selected='true'],[data-app-action-sidebar-thread-active='true']");
    const projectList = thread?.closest?.('[data-app-action-sidebar-project-list-id]');
    const projectRow = thread?.closest?.('[data-app-action-sidebar-project-id]')
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute('data-app-action-sidebar-project-list-id')
      || projectRow?.getAttribute('data-app-action-sidebar-project-id')
      || '';
    if (!workspacePath) {
      const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
      const entries = Array.isArray(bootstrap?.globalStateEntries) ? bootstrap.globalStateEntries : [];
      const localProjects = entries.find((entry) => entry?.key === 'local-projects')?.value;
      const roots = localProjects && typeof localProjects === 'object'
        ? localProjects[projectId]?.rootPaths
        : null;
      workspacePath = Array.isArray(roots)
        ? roots.find((value) => typeof value === 'string' && value.trim())?.trim() || ''
        : '';
    }
    return { projectId, workspacePath };
  })()`).catch(() => ({ projectId: "", workspacePath: "" }));
}

async function composerSnapshot(cdp) {
  return evaluateValue(cdp, `(() => {
    const root = Array.from(document.querySelectorAll(
      '[data-codex-composer-root][data-composer-placement="thread"]'
    )).find((candidate) => candidate.getClientRects().length > 0);
    const editor = Array.from(root?.querySelectorAll(
      '[data-codex-composer="true"][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea'
    ) || []).find((candidate) => candidate.getClientRects().length > 0);
    if (!editor) return { ready: false, text: '' };
    return { ready: true, text: editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || '' };
  })()`);
}

async function selectComposerContents(cdp, collapseToEnd) {
  return evaluateValue(cdp, `(() => {
    const root = Array.from(document.querySelectorAll(
      '[data-codex-composer-root][data-composer-placement="thread"]'
    )).find((candidate) => candidate.getClientRects().length > 0);
    const editor = Array.from(root?.querySelectorAll(
      '[data-codex-composer="true"][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea'
    ) || []).find((candidate) => candidate.getClientRects().length > 0);
    if (!editor) return false;
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const offset = ${collapseToEnd ? "editor.value.length" : "0"};
      editor.setSelectionRange(${collapseToEnd ? "offset" : "0"}, ${collapseToEnd ? "offset" : "editor.value.length"});
      return true;
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (${collapseToEnd ? "true" : "false"}) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
}

async function replaceComposerText(cdp, text) {
  if (!await selectComposerContents(cdp, false)) return false;
  await cdp.send("Input.insertText", { text });
  return true;
}

async function replaceComposerTextWithShortcut(cdp, text) {
  const focused = await selectComposerContents(cdp, true);
  if (!focused) return false;
  const modifiers = process.platform === "darwin" ? 4 : 2;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  });
  await cdp.send("Input.insertText", { text });
  return true;
}

async function waitForRevisionComposer(cdp, userInput, combinedMessage) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const current = await composerSnapshot(cdp);
    if (current.ready && composerHasRevisionMessage(current.text, userInput, combinedMessage)) return true;
    await delay(25);
  }
  return false;
}

async function prepareRevisionComposer(cdp, userInput, combinedMessage) {
  const before = await composerSnapshot(cdp);
  if (!before.ready) return { prepared: false, error: "Codex 输入框尚未出现" };
  const expected = String(userInput || "").trim();
  if (!expected) return { prepared: false, error: "请输入本次文档修改要求" };
  if (before.text.trim() !== expected) {
    return { prepared: false, error: "发送前输入内容发生了变化，请重新发送" };
  }
  const combined = String(combinedMessage || "");
  try {
    const masked = await evaluateValue(cdp, `(() => {
      const root = Array.from(document.querySelectorAll(
        '[data-codex-composer-root][data-composer-placement="thread"]'
      )).find((candidate) => candidate.getClientRects().length > 0);
      if (!root) return false;
      root.setAttribute('data-codex-chat-pin-submitting', 'true');
      return true;
    })()`);
    if (!masked) return { prepared: false, error: "Codex 输入区域尚未出现" };
    if (!await replaceComposerText(cdp, combined)) {
      throw new Error("无法聚焦 Codex 输入框");
    }
    if (await waitForRevisionComposer(cdp, expected, combined)) {
      return { prepared: true, method: "selection" };
    }
    if (!await replaceComposerTextWithShortcut(cdp, combined)) {
      throw new Error("无法通过 Codex 输入事件更新修订要求");
    }
    if (await waitForRevisionComposer(cdp, expected, combined)) {
      return { prepared: true, method: "shortcut" };
    }
    throw new Error("修订约束没有进入 Codex 发送状态");
  } catch (error) {
    await replaceComposerText(cdp, expected).catch(() => false);
    await unmaskRevisionComposer(cdp);
    return { prepared: false, error: error.message || "无法附加修订约束" };
  }
}

async function unmaskRevisionComposer(cdp) {
  await evaluateValue(cdp, `(() => {
    document.querySelectorAll('[data-codex-chat-pin-submitting="true"]')
      .forEach((node) => node.removeAttribute('data-codex-chat-pin-submitting'));
    return true;
  })()`).catch(() => {});
}

async function cleanRevisionComposer(cdp) {
  const before = await composerSnapshot(cdp);
  if (!before.ready || !before.text.includes(REVISION_MARKER)) return { cleaned: true, changed: false };
  const cleanedText = withoutRevisionInstruction(before.text);
  if (!await selectComposerContents(cdp, false)) return { cleaned: false, error: "无法聚焦 Codex 输入框" };
  await cdp.send("Input.insertText", { text: cleanedText });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await composerSnapshot(cdp);
    if (!current.text.includes(REVISION_MARKER)) return { cleaned: true, changed: true };
    await delay(40);
  }
  return { cleaned: false, error: "无法从 Codex 输入框移除修订指令" };
}

async function clearCollectionComposer(cdp, userInput) {
  const expected = String(userInput || "").trim();
  const before = await composerSnapshot(cdp);
  if (!before.ready) return { cleared: false, error: "Codex 输入框尚未出现" };
  if (before.text.trim() !== expected) {
    return { cleared: false, error: "采集入队后输入内容发生了变化，已保留输入框内容" };
  }
  if (!await selectComposerContents(cdp, false)) {
    return { cleared: false, error: "无法聚焦 Codex 输入框，已保留输入框内容" };
  }
  await cdp.send("Input.insertText", { text: "" });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await composerSnapshot(cdp);
    if (current.ready && !current.text.trim()) return { cleared: true };
    await delay(25);
  }
  return { cleared: false, error: "采集已入队，但输入框未能自动清空" };
}

async function explainNativeOpenFailure(cdp, result, filePath) {
  if (result?.ok === true) return result;
  const context = await nativeWorkspaceContext(cdp);
  const workspacePath = context?.workspacePath?.trim();
  if (!workspacePath) return result;
  const relative = path.relative(workspacePath, filePath);
  const fileIsInWorkspace = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (fileIsInWorkspace) {
    return {
      ...result,
      error: `${result?.error || "原生文件打开失败"}；搜索工作区是 ${workspacePath}，Pin 镜像是 ${filePath}`,
    };
  }
  return {
    ...result,
    error: `${result?.error || "原生文件打开失败"}；当前任务工作区是 ${workspacePath}，Pin 文件保存在 ${root}`,
  };
}

async function nativePinTarget(cdp, sessionId) {
  const canonicalPath = pinFileFor(sessionId);
  const context = await nativeWorkspaceContext(cdp);
  const candidate = context?.workspacePath?.trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    return { canonicalPath, filePath: canonicalPath, workspacePath: root, mirrored: false };
  }
  const workspacePath = path.resolve(candidate);
  try {
    const workspaceInfo = await stat(workspacePath);
    if (!workspaceInfo.isDirectory()) throw new Error("workspace root is not a directory");
  } catch {
    return { canonicalPath, filePath: canonicalPath, workspacePath: root, mirrored: false };
  }
  if (samePath(workspacePath, root)) {
    return { canonicalPath, filePath: canonicalPath, workspacePath, mirrored: false };
  }
  return {
    canonicalPath,
    filePath: path.join(workspacePath, "pins", path.basename(canonicalPath)),
    workspacePath,
    mirrored: true,
  };
}

async function nativeCollectionResultTarget(cdp, canonicalPath) {
  const context = await nativeWorkspaceContext(cdp);
  const candidate = context?.workspacePath?.trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    return { canonicalPath, filePath: canonicalPath, workspacePath: root, mirrored: false };
  }
  const workspacePath = path.resolve(candidate);
  try {
    const info = await stat(workspacePath);
    if (!info.isDirectory()) throw new Error("workspace is not a directory");
  } catch {
    return { canonicalPath, filePath: canonicalPath, workspacePath: root, mirrored: false };
  }
  const relative = path.relative(workspacePath, canonicalPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return { canonicalPath, filePath: canonicalPath, workspacePath, mirrored: false };
  }
  return {
    canonicalPath,
    filePath: path.join(workspacePath, "collections", path.basename(canonicalPath)),
    workspacePath,
    mirrored: true,
  };
}

async function revisionTarget(cdp, sessionId) {
  const context = await nativeWorkspaceContext(cdp);
  const candidate = context?.workspacePath?.trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error("当前任务没有可确认的本地工作区，不能启用修订模式");
  }
  const workspacePath = path.resolve(candidate);
  const workspaceInfo = await stat(workspacePath).catch(() => null);
  if (!workspaceInfo?.isDirectory()) throw new Error("当前任务的工作区路径不可访问");

  const canonicalPath = pinFileFor(sessionId);
  await stat(canonicalPath).catch((error) => {
    if (error.code === "ENOENT") throw new Error("当前任务还没有 Pin 文件，请先 Pin 一条助手回复");
    throw error;
  });

  const mirrored = !samePath(workspacePath, root);
  const filePath = mirrored
    ? path.join(workspacePath, "pins", path.basename(canonicalPath))
    : canonicalPath;
  if (mirrored) {
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await stat(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(canonicalPath, filePath);
    }
  }

  const relativePath = workspaceRelativeFile(filePath, workspacePath);
  if (!relativePath) throw new Error("Pin 文件不在当前任务工作区内，不能启用修订模式");
  return { canonicalPath, filePath, workspacePath, relativePath, mirrored };
}

async function syncRevisionTarget(state) {
  const text = await readFile(state.target.filePath, "utf8");
  if (state.target.mirrored) await writePinFile(state.target.canonicalPath, text);
  state.lastKnownHash = contentHash(text);
  return { text, hash: state.lastKnownHash };
}

function revisionStatePayload(state) {
  if (!state) return { enabled: false };
  return {
    enabled: true,
    sessionId: state.sessionId,
    fileName: path.basename(state.target.canonicalPath),
    relativePath: state.target.relativePath,
    instruction: revisionInstruction(state.target.relativePath),
    enabledAt: state.enabledAt,
  };
}

async function enableRevision(cdp, stateKey, sessionId) {
  if (collectionModes.get(safeSessionId(sessionId))?.enabled) {
    throw new Error("采集模式正在使用发送按钮，请先关闭采集模式");
  }
  const existing = revisionStates.get(stateKey);
  if (existing && existing.sessionId !== sessionId) {
    await syncRevisionTarget(existing).catch(() => {});
    revisionStates.delete(stateKey);
  }
  const target = await revisionTarget(cdp, sessionId);
  const text = await readFile(target.filePath, "utf8");
  if (target.mirrored) await writePinFile(target.canonicalPath, text);
  const state = {
    cdp,
    sessionId,
    target,
    enabledAt: Date.now(),
    lastKnownHash: contentHash(text),
    turns: new Map(),
  };
  revisionStates.set(stateKey, state);
  const composer = await cleanRevisionComposer(cdp);
  return { ...revisionStatePayload(state), composer };
}

async function disableRevision(stateKey, sessionId) {
  const state = revisionStates.get(stateKey);
  if (!state || state.sessionId !== sessionId) return { enabled: false };
  const composer = await cleanRevisionComposer(state.cdp);
  if (!composer.cleaned) throw new Error(composer.error || "无法清理输入框中的修订指令");
  await syncRevisionTarget(state);
  revisionStates.delete(stateKey);
  return { enabled: false };
}

async function currentRevisionState(cdp, stateKey, sessionId) {
  const state = revisionStates.get(stateKey);
  if (!state) return { enabled: false };
  if (state.sessionId !== sessionId) {
    await syncRevisionTarget(state).catch(() => {});
    revisionStates.delete(stateKey);
    return { enabled: false };
  }
  await stat(state.target.filePath).catch(() => {
    revisionStates.delete(stateKey);
    throw new Error("修订目标文件已经不存在，修订模式已关闭");
  });
  state.cdp = cdp;
  return revisionStatePayload(state);
}

async function beginRevisionTurn(cdp, stateKey, sessionId, turnId, userInput) {
  const state = revisionStates.get(stateKey);
  if (!state || state.sessionId !== sessionId) throw new Error("当前任务没有启用修订模式");
  state.cdp = cdp;
  const currentTarget = await revisionTarget(cdp, sessionId);
  if (!samePath(currentTarget.filePath, state.target.filePath)
    || !samePath(currentTarget.workspacePath, state.target.workspacePath)) {
    throw new Error("当前任务工作区已经变化，请重新启用修订模式");
  }
  const instruction = revisionInstruction(state.target.relativePath);
  const message = revisionMessage(userInput, state.target.relativePath);
  const text = await readFile(state.target.filePath, "utf8");
  const baselineHash = contentHash(text);
  const historyDirectory = path.join(revisionHistoryDirectory, safeSessionId(sessionId));
  await mkdir(historyDirectory, { recursive: true });
  const backupPath = path.join(historyDirectory, `${Date.now()}_${baselineHash.slice(0, 12)}.md`);
  await writeFile(backupPath, text, { encoding: "utf8", flush: true });
  const composer = await prepareRevisionComposer(cdp, userInput, message);
  if (!composer.prepared) {
    await unmaskRevisionComposer(cdp);
    throw new Error(composer.error || "无法附加修订约束");
  }
  state.turns.set(turnId, { baselineHash, backupPath, startedAt: Date.now() });
  return {
    ...revisionStatePayload(state),
    turnId,
    baselineHash,
    instruction,
    messageLength: message.length,
    composer,
  };
}

async function finishRevisionTurn(stateKey, sessionId, turnId) {
  const state = revisionStates.get(stateKey);
  if (!state || state.sessionId !== sessionId) throw new Error("修订模式已经关闭，无法核验本轮修改");
  const turn = state.turns.get(turnId);
  if (!turn) throw new Error("没有找到本轮修订事务");
  state.turns.delete(turnId);
  const current = await syncRevisionTarget(state);
  return {
    ...revisionStatePayload(state),
    turnId,
    changed: current.hash !== turn.baselineHash,
    baselineHash: turn.baselineHash,
    currentHash: current.hash,
    backupPath: turn.backupPath,
  };
}

function collectionQueuePath(sessionId) {
  return path.join(collectionQueueDirectory, `collection_${safeSessionId(sessionId)}.json`);
}

function collectionCounts(queue) {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const item of queue?.items || []) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  return counts;
}

function collectionStatePayload(mode, queue) {
  const counts = collectionCounts(queue);
  const runningItem = queue?.items.find((item) => item.status === "running");
  return {
    enabled: mode?.enabled === true,
    sessionId: mode?.sessionId || queue?.sessionId || "",
    fileName: mode?.fileName || "",
    sourcePath: mode?.sourcePath || "",
    workspacePath: mode?.workspacePath || queue?.workspacePath || "",
    resultPath: "",
    counts,
    pendingCount: counts.queued + counts.running,
    runningItemId: runningItem?.id || "",
    runningStartedAt: runningItem?.startedAt || "",
    runningPhase: runningItem?.phase || "",
    enabledAt: mode?.enabledAt || null,
    protocolVersion: collectionProtocolVersion,
    capabilities: collectionCapabilities,
  };
}

function persistedCollectionMode(mode) {
  if (!mode?.enabled || !mode.sessionId || !mode.sourcePath) return null;
  return {
    enabled: true,
    sessionId: safeSessionId(mode.sessionId),
    sourcePath: path.resolve(mode.sourcePath),
    workspacePath: mode.workspacePath && path.isAbsolute(mode.workspacePath) ? path.resolve(mode.workspacePath) : "",
    fileName: mode.fileName || path.basename(mode.sourcePath),
    enabledAt: Number.isFinite(mode.enabledAt) ? mode.enabledAt : Date.now(),
  };
}

async function persistCollectionQueue(queue) {
  await mkdir(collectionQueueDirectory, { recursive: true });
  queue.updatedAt = new Date().toISOString();
  await writePinFile(queue.queuePath, `${JSON.stringify({
    version: 5,
    sessionId: queue.sessionId,
    workspacePath: queue.workspacePath || "",
    generation: queue.generation,
    mode: persistedCollectionMode(queue.mode),
    updatedAt: queue.updatedAt,
    items: queue.items,
  }, null, 2)}\n`);
}

async function loadCollectionQueue(sessionId) {
  const key = safeSessionId(sessionId);
  if (collectionQueues.has(key)) return collectionQueues.get(key);
  if (collectionQueueLoads.has(key)) return collectionQueueLoads.get(key);
  const pending = (async () => {
    const queuePath = collectionQueuePath(key);
    let stored = null;
    try {
      stored = JSON.parse(await readFile(queuePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`采集队列文件无法读取：${error.message}`);
      }
    }
    const items = Array.isArray(stored?.items)
      ? stored.items.filter((item) => item && typeof item === "object" && typeof item.id === "string")
      : [];
    const recovered = recoverCollectionItems(items, stored?.version) > 0;
    const queue = {
      sessionId: key,
      queuePath,
      resultPath: "",
      workspacePath: stored?.workspacePath && path.isAbsolute(stored.workspacePath)
        ? path.resolve(stored.workspacePath)
        : "",
      generation: Number.isSafeInteger(stored?.generation) ? stored.generation : 0,
      mode: persistedCollectionMode(stored?.mode),
      items,
      updatedAt: stored?.updatedAt || null,
    };
    collectionQueues.set(key, queue);
    if (recovered) await persistCollectionQueue(queue);
    return queue;
  })();
  collectionQueueLoads.set(key, pending);
  try {
    return await pending;
  } finally {
    collectionQueueLoads.delete(key);
  }
}

async function ensureCollectionBackend() {
  if (collectionBackend?.child && collectionBackend.child.exitCode === null) return collectionBackend;
  if (collectionBackendPromise) return collectionBackendPromise;
  collectionBackendPromise = (async () => {
    const cli = requireCollectionCli();
    const probe = await probeCodexCli(cli);
    if (!probe.ok) {
      throw new Error(`Codex CLI 检测失败（${probe.stage || "resolve"}）：${probe.error}`);
    }
    const client = new CodexAppServerClient({
      cli,
      cwd: collectionWorkspaceDirectory,
      ...collectionRuntimeOptions(),
    });
    client.once("exit", () => {
      if (collectionBackend === client) collectionBackend = null;
    });
    await client.start();
    collectionBackend = client;
    console.log(`Chat Pin collection backend: ${probe.version || cli.displayPath}`);
    return client;
  })();
  try {
    return await collectionBackendPromise;
  } finally {
    collectionBackendPromise = null;
  }
}

function requireCollectionCli() {
  const cli = resolveCodexCli();
  if (!cli) {
    throw new Error("未检测到可用的独立 Codex CLI。请确认 codex --version 和 codex app-server --help 可运行，或设置 CODEX_PIN_CLI_PATH");
  }
  return cli;
}

async function postCollectionEvent(sessionId, event, item = null, result = null) {
  const queue = await loadCollectionQueue(sessionId);
  const mode = collectionModes.get(queue.sessionId);
  if (!mode?.cdp) return;
  await postHostMessage(mode.cdp, {
      type: "collection-event",
      event,
      sessionId: queue.sessionId,
      state: collectionStatePayload(mode, queue),
      item: item ? {
        id: item.id,
        status: item.status,
        error: item.error || "",
        resultPath: "",
        input: item.input || "",
        output: result ? String(result.output || "").slice(0, 6000) : String(item.output || "").slice(0, 6000),
        truncated: result ? String(result.output || "").length > 6000 : item.outputTruncated === true || String(item.output || "").length > 6000,
        changedFiles: Array.isArray(item.changedFiles) ? item.changedFiles : [],
        completedAt: item.completedAt || "",
        executionProfile: item.executionProfile || null,
        metrics: item.metrics || null,
      } : null,
    }).catch(() => {});
}

async function collectionResultsForQueue(queue) {
  return (queue?.items || [])
    .filter((item) => item.status === "completed" && String(item.output || "").trim())
    .slice(-20)
    .map((item) => ({
      id: item.id,
      input: item.input || "",
      output: String(item.output || "").slice(0, 6000),
      truncated: item.outputTruncated === true || String(item.output || "").length > 6000,
      changedFiles: Array.isArray(item.changedFiles) ? item.changedFiles : [],
      completedAt: item.completedAt || "",
      executionProfile: item.executionProfile || null,
      metrics: item.metrics || null,
    }));
}

function nextQueuedCollectionItem() {
  for (const queue of collectionQueues.values()) {
    const item = queue.items.find((candidate) => candidate.status === "queued");
    if (item) return { queue, item };
  }
  return null;
}

async function processCollectionItem(queue, item) {
  const generation = queue.generation;
  const controller = new AbortController();
  collectionItemControllers.set(item.id, controller);
  const processStartedAt = Date.now();
  const terminalState = { lastActivity: "starting", toolEvents: 0, fileChanges: 0 };
  const heartbeat = setInterval(() => {
    collectionTerminalLog(
      item,
      `HEARTBEAT ${collectionDuration(Date.now() - processStartedAt)} | phase=${item.phase || item.status} | last=${terminalState.lastActivity} | tools=${terminalState.toolEvents} | files=${terminalState.fileChanges}`,
    );
  }, 20_000);
  heartbeat.unref?.();
  try {
    item.status = "running";
    item.startedAt = new Date().toISOString();
    item.phase = "preparing";
    item.error = "";
    await persistCollectionQueue(queue);
    await postCollectionEvent(queue.sessionId, "item-started", item);
    if (!collectionItemIsCurrent(queue, item, generation)) return;
    const workspacePath = item.workspacePath || queue.workspacePath || collectionWorkspaceDirectory;
    collectionTerminalLog(item, `START | rule=${path.basename(item.sourcePath || "pin.md")} | workspace=${workspacePath}`);
    const [backend, preflight] = await Promise.all([
      ensureCollectionBackend(),
      prepareCollectionPreflight({
        workspacePath,
        sourceMarkdown: item.sourceMarkdown || item.pinMarkdown,
        userInput: item.input,
      }),
    ]);
    if (!collectionItemIsCurrent(queue, item, generation)) return;
    const executionProfile = selectCollectionExecutionProfile(
      preflight,
      item.sourceMarkdown || item.pinMarkdown,
      item.input,
      process.env,
      item.desktopExecutionPreference || null,
    );
    terminalState.lastActivity = "preflight-complete";
    collectionTerminalLog(
      item,
      `PREFLIGHT ${collectionDuration(preflight.durationMs)} | urls=${preflight.metadata?.urls?.length || 0} | workspace-matches=${preflight.workspaceSearch?.matches?.length || 0} | github-checks=${preflight.githubVerification?.length || 0}`,
    );
    collectionTerminalLog(
      item,
      `MODEL ${executionProfile.model || "CLI default"} / ${executionProfile.effort || "default"} | source=${executionProfile.profile}`,
    );
    item.executionProfile = executionProfile;
    item.phase = "starting-turn";
    item.preflightSummary = {
      durationMs: preflight.durationMs,
      urlCount: preflight.metadata?.urls?.length || 0,
      githubRepositoryCount: preflight.metadata?.githubRepositories?.length || 0,
      workspaceMatchCount: preflight.workspaceSearch?.matches?.length || 0,
      githubVerificationCount: preflight.githubVerification?.length || 0,
      truncated: preflight.workspaceSearch?.truncated === true,
    };
    await persistCollectionQueue(queue);
    const result = await backend.runFreshCollection({
      cwd: workspacePath,
      prompt: collectionPrompt(item.sourceMarkdown || item.pinMarkdown, item.input, preflight),
      model: executionProfile.model,
      effort: executionProfile.effort,
      signal: controller.signal,
      onProgress: (event) => {
        if (!event?.type) return;
        if (event.type === "app-server-ready") {
          terminalState.lastActivity = "app-server-ready";
          collectionTerminalLog(item, `APP SERVER ready in ${collectionDuration(event.elapsedMs)}`);
          return;
        }
        if (event.type === "thread-started") {
          terminalState.lastActivity = "thread-started";
          collectionTerminalLog(item, `THREAD started | id=${String(event.threadId || "").slice(-12)}`);
          return;
        }
        if (event.type === "turn-started") {
          terminalState.lastActivity = "turn-started";
          collectionTerminalLog(item, `TURN started | model=${event.model || "CLI default"} | effort=${event.effort || "default"}`);
          return;
        }
        if (event.type === "model-fallback") {
          terminalState.lastActivity = "model-fallback";
          collectionTerminalLog(item, `MODEL FALLBACK at ${event.stage}; retrying with CLI defaults | ${String(event.error || "").slice(0, 240)}`, "warn");
          return;
        }
        if (event.type === "retry") {
          terminalState.lastActivity = "transport-retry";
          collectionTerminalLog(item, `RETRY | ${String(event.error || "Codex is reconnecting").slice(0, 300)}`, "warn");
          return;
        }
        if (event.type === "item") {
          terminalState.lastActivity = `${event.itemType || "item"}-${event.event || "event"}`;
          if (event.event === "started" && !["agentMessage", "reasoning"].includes(event.itemType)) {
            terminalState.toolEvents += 1;
            if (terminalState.toolEvents <= 3 || terminalState.toolEvents % 10 === 0) {
              collectionTerminalLog(item, `TOOL #${terminalState.toolEvents} started | type=${event.itemType || "unknown"}`);
            }
          }
          if (event.itemType === "contextCompaction" && event.event === "completed") {
            collectionTerminalLog(item, "CONTEXT compacted");
          }
          if (event.itemType === "fileChange" && event.event === "completed") {
            const changes = Array.isArray(event.changes) ? event.changes : [];
            terminalState.fileChanges += changes.length;
            for (const change of changes.slice(0, 12)) {
              collectionTerminalLog(item, `WRITE ${change.kind || "change"} | ${change.path}`);
            }
            if (changes.length > 12) collectionTerminalLog(item, `WRITE +${changes.length - 12} additional paths`);
          }
          return;
        }
        if (event.type === "turn-completed") {
          terminalState.lastActivity = "turn-completed";
          collectionTerminalLog(item, `TURN completed | status=${event.status || "completed"}`);
        }
      },
      onTurnStarted: async ({ threadId, turnId }) => {
        if (!collectionItemIsCurrent(queue, item, generation)) {
          controller.abort();
          return;
        }
        item.threadId = threadId || null;
        item.turnId = turnId || null;
        item.phase = "executing";
        await persistCollectionQueue(queue);
        await postCollectionEvent(queue.sessionId, "item-progress", item);
      },
    });
    if (!collectionItemIsCurrent(queue, item, generation)) return;
    item.threadId = result.threadId;
    item.turnId = result.turnId;
    if (result.executionProfile) {
      item.executionProfile = {
        ...executionProfile,
        effectiveModel: result.executionProfile.model || "inherited",
        effectiveEffort: result.executionProfile.effort || "inherited",
        fallback: result.executionProfile.fallback === true,
      };
    }
    item.completedAt = new Date().toISOString();
    item.output = String(result.output || "").slice(0, 12_000);
    item.outputTruncated = String(result.output || "").length > 12_000;
    item.changedFiles = Array.isArray(result.fileChanges) ? result.fileChanges.slice(0, 200) : [];
    item.metrics = {
      preflightMs: preflight.durationMs,
      totalMs: Date.now() - processStartedAt,
      ...(result.metrics || {}),
    };
    item.status = "completed";
    item.phase = "completed";
    item.resultPath = "";
    await persistCollectionQueue(queue);
    await postCollectionEvent(queue.sessionId, "item-completed", item, result);
    collectionTerminalLog(
      item,
      `DONE ${collectionDuration(Date.now() - processStartedAt)} | files=${item.changedFiles.length} | model=${item.executionProfile?.effectiveModel || item.executionProfile?.model || "CLI default"}`,
    );
  } catch (error) {
    if (!collectionItemIsCurrent(queue, item, generation)) {
      collectionTerminalLog(item, `CANCELLED ${collectionDuration(Date.now() - processStartedAt)} | queue was cleared or replaced`, "warn");
      return;
    }
    item.status = "failed";
    item.phase = "failed";
    item.completedAt = new Date().toISOString();
    item.error = error.message || String(error);
    await persistCollectionQueue(queue).catch(() => {});
    await postCollectionEvent(queue.sessionId, "item-failed", item);
    collectionTerminalLog(item, `FAILED ${collectionDuration(Date.now() - processStartedAt)} | ${String(item.error).slice(0, 500)}`, "error");
  } finally {
    clearInterval(heartbeat);
    if (collectionItemControllers.get(item.id) === controller) collectionItemControllers.delete(item.id);
  }
}

function scheduleCollectionPump() {
  if (collectionPump) return collectionPump;
  collectionPump = (async () => {
    let next;
    while ((next = nextQueuedCollectionItem())) {
      await processCollectionItem(next.queue, next.item);
    }
  })().finally(() => {
    collectionPump = null;
    if (nextQueuedCollectionItem()) scheduleCollectionPump();
  });
  return collectionPump;
}

async function collectionSource(cdp, sessionId, sourceFileName = "") {
  const canonicalPath = pinFileFor(sessionId);
  const requested = String(sourceFileName || "").trim();
  if (!requested || requested.toLowerCase() === path.basename(canonicalPath).toLowerCase()) {
    await stat(canonicalPath).catch((error) => {
      if (error.code === "ENOENT") throw new Error("当前任务还没有 Pin 文件，请先 Pin 一条助手回复");
      throw error;
    });
    return canonicalPath;
  }
  const context = await nativeWorkspaceContext(cdp);
  const workspacePath = String(context?.workspacePath || "").trim();
  return resolveCollectionSourceInWorkspace(workspacePath, requested);
}

async function collectionTaskWorkspace(cdp) {
  const context = await nativeWorkspaceContext(cdp);
  const candidate = String(context?.workspacePath || "").trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error("当前任务没有可确认的本地工作区，无法执行采集规则");
  }
  const workspacePath = path.resolve(candidate);
  const info = await stat(workspacePath).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`当前任务工作区不可用：${workspacePath}`);
  return workspacePath;
}

async function assignCollectionWorkspace(queue, workspacePath) {
  queue.workspacePath = workspacePath;
  queue.resultPath = "";
}

async function enableCollection(cdp, stateKey, sessionId, sourceFileName = "") {
  if (revisionStates.get(stateKey)) {
    throw new Error("修订模式正在使用发送按钮，请先关闭修订模式");
  }
  const sourcePath = await collectionSource(cdp, sessionId, sourceFileName);
  const workspacePath = await collectionTaskWorkspace(cdp);
  // Enabling collection mode is a local state transition and must remain fast.
  // Starting and probing App Server can take tens of seconds on a cold machine;
  // defer that work until an item is actually queued so the UI cannot time out
  // with an unpersisted mode. A missing CLI is still reported immediately.
  requireCollectionCli();
  const queue = await loadCollectionQueue(sessionId);
  await assignCollectionWorkspace(queue, workspacePath);
  const mode = {
    enabled: true,
    cdp,
    sessionId: safeSessionId(sessionId),
    sourcePath,
    workspacePath,
    fileName: path.basename(sourcePath),
    enabledAt: Date.now(),
  };
  queue.mode = persistedCollectionMode(mode);
  collectionModes.set(mode.sessionId, mode);
  await persistCollectionQueue(queue);
  if (queue.items.some((item) => item.status === "queued")) scheduleCollectionPump();
  return collectionStatePayload(mode, queue);
}

async function disableCollection(_stateKey, sessionId) {
  const safeId = safeSessionId(sessionId);
  const queue = await loadCollectionQueue(safeId);
  collectionModes.delete(safeId);
  queue.mode = null;
  await persistCollectionQueue(queue);
  return collectionStatePayload(null, queue);
}

async function currentCollectionState(cdp, _stateKey, sessionId) {
  const safeId = safeSessionId(sessionId);
  const queue = await loadCollectionQueue(safeId);
  let mode = collectionModes.get(safeId);
  if (!mode && queue.mode?.enabled) {
    const sourceExists = await stat(queue.mode.sourcePath).then(() => true, () => false);
    if (sourceExists) {
      mode = { ...queue.mode, cdp };
      collectionModes.set(safeId, mode);
    } else {
      queue.mode = null;
      await persistCollectionQueue(queue);
    }
  }
  if (mode) {
    const workspacePath = await collectionTaskWorkspace(cdp);
    await assignCollectionWorkspace(queue, workspacePath);
    mode.cdp = cdp;
    mode.workspacePath = workspacePath;
    queue.mode = persistedCollectionMode(mode);
    await persistCollectionQueue(queue);
  }
  if (queue.items.some((item) => item.status === "queued")) scheduleCollectionPump();
  return collectionStatePayload(mode, queue);
}

async function retryFailedCollection(stateKey, sessionId) {
  const safeId = safeSessionId(sessionId);
  const mode = collectionModes.get(safeId);
  if (!mode?.enabled || mode.sessionId !== safeId) throw new Error("当前任务没有启用采集模式");
  const queue = await loadCollectionQueue(safeId);
  const retriedAt = new Date().toISOString();
  const retriedCount = retryFailedCollectionItems(queue.items, retriedAt);
  if (retriedCount) {
    await persistCollectionQueue(queue);
    scheduleCollectionPump();
  }
  return { ...collectionStatePayload(mode, queue), retriedCount };
}

async function clearCollectionQueue(stateKey, sessionId) {
  const safeId = safeSessionId(sessionId);
  const mode = collectionModes.get(safeId);
  if (!mode?.enabled || mode.sessionId !== safeId) throw new Error("当前任务没有启用采集模式");
  const queue = await loadCollectionQueue(safeId);
  for (const item of queue.items) collectionItemControllers.get(item.id)?.abort();
  const clearedCount = clearCollectionItems(queue);
  await persistCollectionQueue(queue);
  await postCollectionEvent(safeId, "queue-cleared");
  return { ...collectionStatePayload(mode, queue), clearedCount };
}

async function clearCollectionReports(_stateKey, sessionId) {
  const safeId = safeSessionId(sessionId);
  const queue = await loadCollectionQueue(safeId);
  const clearedReportCount = clearCompletedCollectionItems(queue);
  if (clearedReportCount) await persistCollectionQueue(queue);
  const mode = collectionModes.get(safeId) || null;
  return { ...collectionStatePayload(mode, queue), clearedReportCount };
}

async function openCollectionResult(cdp, stateKey, sessionId) {
  await currentCollectionState(cdp, stateKey, sessionId);
  throw new Error("当前采集模式会直接修改任务工作区，不再生成独立采集结果文件；请查看执行报告和项目文件");
}

async function enqueueCollection(
  cdp,
  stateKey,
  sessionId,
  userInput,
  composerAlreadyCleared = false,
  desktopExecutionLabel = "",
) {
  const safeId = safeSessionId(sessionId);
  await currentCollectionState(cdp, stateKey, safeId);
  const mode = collectionModes.get(safeId);
  if (!mode?.enabled || mode.sessionId !== safeId) throw new Error("当前任务没有启用采集模式");
  if (revisionStates.get(stateKey)) throw new Error("修订模式与采集模式不能同时发送");
  const input = String(userInput || "").trim();
  if (!input) throw new Error("请输入本次采集要求");
  const sourcePath = mode.sourcePath || pinFileFor(safeId);
  const sourceMarkdown = await readFile(sourcePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") throw new Error("当前采集规则文件已经不存在，采集模式已关闭");
    throw error;
  });
  if (!sourceMarkdown.trim()) throw new Error("当前采集规则文件是空的，无法加入采集队列");
  const queue = await loadCollectionQueue(safeId);
  const item = {
    id: `collect_${Date.now()}_${randomUUID().slice(0, 8)}`,
    status: "queued",
    sessionId: safeId,
    input,
    desktopExecutionPreference: parseDesktopExecutionPreference(desktopExecutionLabel),
    sourcePath,
    workspacePath: mode.workspacePath,
    sourceHash: contentHash(sourceMarkdown),
    sourceMarkdown,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    threadId: null,
    turnId: null,
    resultPath: "",
    error: "",
    output: "",
    outputTruncated: false,
    changedFiles: [],
    executionProfile: null,
    preflightSummary: null,
    metrics: null,
    phase: "queued",
  };
  queue.items.push(item);
  await persistCollectionQueue(queue);
  const pendingPosition = queue.items.filter((candidate) => ["queued", "running"].includes(candidate.status)).length;
  collectionTerminalLog(
    item,
    `QUEUED | rule=${path.basename(sourcePath)} | workspace=${mode.workspacePath} | pending=${pendingPosition}`,
  );
  const composer = composerAlreadyCleared
    ? { cleared: true, method: "injection" }
    : await clearCollectionComposer(cdp, input);
  scheduleCollectionPump();
  return {
    ...collectionStatePayload(mode, queue),
    accepted: true,
    composer,
    item: { id: item.id, status: item.status },
  };
}

async function waitForPoint(cdp, expression, timeoutMs, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  do {
    const point = await evaluateValue(cdp, expression);
    if (point) return point;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return null;
}

async function waitForStablePoint(cdp, expression, timeoutMs = 1_500, requiredSamples = 3) {
  const deadline = Date.now() + timeoutMs;
  let lastPoint = null;
  let stableSamples = 0;
  do {
    const point = await evaluateValue(cdp, expression);
    if (point && lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) <= 1.5) {
      stableSamples += 1;
    } else {
      stableSamples = point ? 1 : 0;
    }
    if (point && stableSamples >= requiredSamples) return point;
    lastPoint = point;
    await delay(60);
  } while (Date.now() < deadline);
  return null;
}

async function clickPoint(cdp, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  return true;
}

async function pressKey(cdp, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  const payload = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...payload });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...payload });
}

async function nativeFileTabPoint(cdp, fileName) {
  return evaluateValue(cdp, `(() => {
    const expected = ${JSON.stringify(fileName)}.toLowerCase();
    const visible = (node) => {
      if (!node?.isConnected || !node.getClientRects().length) return false;
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const tabs = [...document.querySelectorAll('[role="tab"]')].filter((node) => visible(node) && (node.textContent || '').trim().toLowerCase() === expected);
    const tab = tabs.find((node) => node.getAttribute('aria-selected') === 'true') || tabs.at(-1);
    if (!tab) return null;
    const rect = tab.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

async function waitForNativeFileTab(cdp, fileName, timeoutMs = 1_200, intervalMs = 24) {
  const deadline = Date.now() + timeoutMs;
  do {
    const point = await nativeFileTabPoint(cdp, fileName);
    if (point) return point;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return null;
}

async function openNativeFileTab(cdp, filePath, options = {}) {
  const startedAt = Date.now();
  const wantedFileName = path.basename(filePath);
  const existing = await nativeFileTabPoint(cdp, wantedFileName);
  if (existing) {
    await clickPoint(cdp, existing);
    return { ok: true, status: "existing", fileName: wantedFileName, elapsedMs: Date.now() - startedAt };
  }

  const fileMenuPointExpression = (anchor = null) => `(() => {
    const visible = (node) => {
      if (!node?.isConnected || !node.getClientRects().length) return false;
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const anchor = ${JSON.stringify(anchor)};
    const injectedPoint = window.__codexChatPinInjection__?.nativeFileMenuPoint?.() || null;
    if (Number.isFinite(injectedPoint?.x) && Number.isFinite(injectedPoint?.y)) return injectedPoint;
    const candidates = [...document.querySelectorAll('button,[role="menuitem"],li')].filter((node) => {
      if (!visible(node) || !/^(?:文件|file\\b)/i.test(norm(node.textContent))) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 70 || rect.width > 560 || rect.height < 20 || rect.height > 90) return false;
      if (anchor) return true;
      for (let parent = node.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth += 1) {
        const familyText = norm(parent.textContent);
        if (/(浏览器|browser)/i.test(familyText) && /(终端|terminal)/i.test(familyText)) return true;
      }
      return rect.left > innerWidth * .45;
    });
    const item = candidates.sort((left, right) => {
      const score = (node) => {
        const rect = node.getBoundingClientRect();
        if (anchor) {
          const dx = rect.left + rect.width / 2 - anchor.x;
          const dy = rect.top + rect.height / 2 - anchor.y;
          return Math.hypot(dx, dy);
        }
        const all = norm(node.parentElement?.parentElement?.textContent);
        return (/(浏览器|browser)/i.test(all) ? 0 : 10000) + (/(终端|terminal)/i.test(all) ? 0 : 10000) + rect.top;
      };
      return score(left) - score(right);
    })[0];
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;

  const openFileTabExpression = `(() => {
    const visible = (node) => {
      if (!node?.isConnected || !node.getClientRects().length) return false;
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => visible(node) && /^(打开文件|open file)$/i.test((node.textContent || '').trim()));
    if (!tab) return null;
    const rect = tab.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  const openFileTab = await evaluateValue(cdp, openFileTabExpression);

  const filterPointExpression = `(() => {
    const visible = (node) => node?.isConnected && node.getClientRects().length > 0;
    const inputs = [...document.querySelectorAll('input')].filter((node) => visible(node));
    const named = inputs.find((node) => /筛选文件|filter files?/i.test(node.placeholder || node.getAttribute('aria-label') || ''));
    const input = named || inputs.find((node) => {
      const rect = node.getBoundingClientRect();
      const type = (node.type || 'text').toLowerCase();
      return /^(search|text)$/.test(type) && rect.left > innerWidth * .5 && rect.top < 360
        && rect.width >= 140 && rect.height >= 20 && rect.height <= 64;
    });
    if (!input) return null;
    const rect = input.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  let filterPoint = null;

  const suppliedFilePoint = options.fileMenuPoint && Number.isFinite(options.fileMenuPoint.x) && Number.isFinite(options.fileMenuPoint.y)
    ? options.fileMenuPoint
    : null;
  if (suppliedFilePoint) {
    await clickPoint(cdp, suppliedFilePoint);
  } else if (openFileTab) {
    await clickPoint(cdp, openFileTab);
  } else {
      const addTabExpression = `(() => {
        const visible = (node) => {
          if (!node?.isConnected || !node.getClientRects().length) return false;
          const rect = node.getBoundingClientRect();
          return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        };
        const direct = [...document.querySelectorAll('button')].filter((node) => {
          if (!visible(node)) return false;
          const rect = node.getBoundingClientRect();
          const label = [node.title, node.getAttribute('aria-label')].filter(Boolean).join(' ');
          return rect.top < 140 && rect.left > innerWidth * .45
            && /打开侧边面板标签页|open side panel tab/i.test(label);
        }).sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0];
        if (direct) {
          const rect = direct.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, source: 'direct-labelled', label: direct.title || direct.getAttribute('aria-label') || '' };
        }
        const rightTabs = [...document.querySelectorAll('[data-app-shell-tab-controller="right"] [role="tab"]')].filter(visible);
        const topRightTabs = [...document.querySelectorAll('[role="tab"]')].filter((node) => {
          if (!visible(node)) return false;
          const rect = node.getBoundingClientRect();
          return rect.top < 120 && rect.left > innerWidth * .45;
        });
        const tabs = rightTabs.length ? rightTabs : topRightTabs;
        const tab = tabs.find((node) => node.getAttribute('aria-selected') === 'true') || tabs.sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0];
        if (!tab) return null;
        const controller = tab.closest('[data-app-shell-tab-controller]') || tab.parentElement;
        const strip = controller?.closest('[data-app-shell-tab-strip-controller]');
        const controllerRect = controller.getBoundingClientRect();
        const centerY = controllerRect.top + controllerRect.height / 2;
        const labelled = [...document.querySelectorAll('button')].filter((node) => {
          const label = [node.title, node.getAttribute('aria-label')].filter(Boolean).join(' ');
          if (!visible(node) || !/打开侧边面板标签页|open side panel tab/i.test(label)) return false;
          const rect = node.getBoundingClientRect();
          const nodeCenterY = rect.top + rect.height / 2;
          return rect.left >= controllerRect.right - 2 && rect.left <= controllerRect.right + 90
            && Math.abs(nodeCenterY - centerY) <= 14;
        }).sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left)[0];
        if (labelled) {
          const rect = labelled.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, source: 'labelled', label: labelled.title || labelled.getAttribute('aria-label') || '' };
        }
        const adjacent = [...(strip || document).querySelectorAll('button')].filter((node) => {
          if (!visible(node) || node.closest('[data-app-shell-tab-controller]')) return false;
          const rect = node.getBoundingClientRect();
          const nodeCenterY = rect.top + rect.height / 2;
          return rect.width >= 20 && rect.width <= 52 && rect.height >= 20 && rect.height <= 52
            && rect.left >= controllerRect.right - 2 && rect.left <= controllerRect.right + 70
            && Math.abs(nodeCenterY - centerY) <= 14;
        }).sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left)[0];
        if (adjacent) {
          const rect = adjacent.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, source: 'strip-button', label: adjacent.title || adjacent.getAttribute('aria-label') || '' };
        }
        const x = controllerRect.right + 28;
        const y = centerY;
        const hit = document.elementFromPoint(x, y);
        return hit ? { x, y, source: 'strip-coordinate', label: hit.title || hit.getAttribute?.('aria-label') || hit.textContent || '', hit: hit.outerHTML?.slice(0, 300) || '' } : null;
      })()`;
    const togglePointExpression = `(() => {
          const visible = (node) => {
            if (!node?.isConnected || !node.getClientRects().length) return false;
            const rect = node.getBoundingClientRect();
            return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
          };
          const button = [...document.querySelectorAll('button')].filter((node) => {
            const describedBy = (node.getAttribute('aria-describedby') || '').split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || '')
              .join(' ');
            const label = [
              node.title,
              node.getAttribute('aria-label'),
              node.getAttribute('data-tooltip-content'),
              describedBy,
              node.textContent,
            ].filter(Boolean).join(' ');
            return visible(node) && /显示.{0,5}隐藏.{0,4}(?:侧边|辅助)面板|切换.{0,4}(?:侧边|辅助)面板|show.{0,6}hide.{0,6}(?:side|secondary).{0,4}(?:panel|bar)|toggle.{0,8}(?:side|secondary).{0,4}(?:panel|bar)/i.test(label);
          }).sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0];
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, open: button.getAttribute('aria-pressed') === 'true' };
        })()`;

    // The empty side-panel state already exposes “文件”; use it directly.
    // Otherwise open the panel (if needed), then use the active tab's “+”.
    let fileMenuPoint = await evaluateValue(cdp, fileMenuPointExpression());
    let addTabPoint = null;
    let toggleState = null;
    let sidePanelShortcutUsed = false;
    if (!fileMenuPoint) {
      toggleState = await evaluateValue(cdp, togglePointExpression);
      if (toggleState && !toggleState.open) {
        await clickPoint(cdp, toggleState);
        fileMenuPoint = await waitForStablePoint(cdp, fileMenuPointExpression(), 1_500);
      } else if (!toggleState) {
        // Some Codex builds render the side-panel toggle as an icon without an
        // accessible name until hover. Use the app's native shortcut instead
        // of relying on its unstable button DOM.
        await pressKey(cdp, {
          key: "b",
          code: "KeyB",
          windowsVirtualKeyCode: 66,
          modifiers: process.platform === "darwin" ? 5 : 3,
        });
        sidePanelShortcutUsed = true;
        fileMenuPoint = await waitForStablePoint(cdp, fileMenuPointExpression(), 1_800);
        if (!fileMenuPoint) addTabPoint = await waitForPoint(cdp, addTabExpression, 1_000);
      }
    }
    for (let attempt = 0; attempt < 24 && !fileMenuPoint && !addTabPoint; attempt += 1) {
      fileMenuPoint = await evaluateValue(cdp, fileMenuPointExpression());
      if (!fileMenuPoint) addTabPoint = await evaluateValue(cdp, addTabExpression);
      if (!fileMenuPoint && !addTabPoint) await delay(150);
    }

    if (!fileMenuPoint && !addTabPoint) {
      toggleState = await evaluateValue(cdp, togglePointExpression);
      if (!toggleState) {
        return {
          ok: false,
          error: sidePanelShortcutUsed
            ? "已触发 Codex 原生侧栏快捷键，但右侧入口未出现"
            : "未找到 Codex 原生侧栏开关",
        };
      }
      if (toggleState.open) return { ok: false, error: "Codex 原生侧栏已展开，但未找到新增页入口" };
      await clickPoint(cdp, toggleState);
      for (let attempt = 0; attempt < 20 && !fileMenuPoint && !addTabPoint; attempt += 1) {
        fileMenuPoint = await evaluateValue(cdp, fileMenuPointExpression());
        if (!fileMenuPoint) addTabPoint = await evaluateValue(cdp, addTabExpression);
        if (!fileMenuPoint && !addTabPoint) await delay(150);
      }
    }

    if (!fileMenuPoint && addTabPoint) {
      await clickPoint(cdp, addTabPoint);
      fileMenuPoint = await waitForStablePoint(cdp, fileMenuPointExpression(addTabPoint), 1_600, 2);
    }
    if (!fileMenuPoint) return { ok: false, error: "未找到 Codex 原生“文件”入口" };
    await clickPoint(cdp, fileMenuPoint);
  }

  if (!openFileTab) {
    const createdFileTab = await waitForPoint(cdp, openFileTabExpression, 2_500);
    if (createdFileTab) await clickPoint(cdp, createdFileTab);
  }
  filterPoint ||= await waitForPoint(cdp, filterPointExpression, 6_000);
  if (!filterPoint) return { ok: false, error: "Codex 原生“打开文件”页未出现" };

  const refreshFilter = async () => {
    await clickPoint(cdp, filterPoint);
    await pressKey(cdp, { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await pressKey(cdp, { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await cdp.send("Input.insertText", { text: wantedFileName });
  };
  await refreshFilter();
  const firstResultPointExpression = `(() => {
    const visible = (node) => node?.isConnected && node.getClientRects().length > 0;
    const filter = [...document.querySelectorAll('input')].find((node) => visible(node) && /筛选文件|filter files?/i.test(node.placeholder || node.getAttribute('aria-label') || ''));
    if (!filter) return null;
    const rect = filter.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 220), y: rect.bottom + 52 };
  })()`;
  const candidateExpression = `(() => {
    const expected = ${JSON.stringify(wantedFileName)}.toLowerCase();
    const prefix = expected.slice(0, Math.min(8, expected.length));
    const visible = (node) => node?.isConnected && node.getClientRects().length > 0;
    const filter = [...document.querySelectorAll('input')].find((node) => visible(node) && /筛选文件|filter files?/i.test(node.placeholder || node.getAttribute('aria-label') || ''));
    if (!filter) return null;
    const filterRect = filter.getBoundingClientRect();
    const matches = [];
    const addRect = (rect) => {
      if (rect.width <= 0 || rect.height <= 0 || rect.top < filterRect.bottom - 1 || rect.right <= filterRect.left) return;
      matches.push({
        x: rect.left + Math.min(rect.width / 2, 180),
        y: rect.top + rect.height / 2,
        area: rect.width * rect.height,
        distance: rect.top - filterRect.bottom,
      });
    };

    // Text-node ranges remain accurate even when the native result row has no
    // role/data attribute or its parent spans the entire file tree.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
      const value = String(textNode.nodeValue || '').trim().replaceAll('\\\\', '/').toLowerCase();
      if (!value.includes(prefix)) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      for (const rect of range.getClientRects()) addRect(rect);
    }

    const nodes = [...document.querySelectorAll('[role="treeitem"],[role="option"],button,[data-file-reference],span,div')];
    for (const node of nodes) {
      if (!visible(node)) continue;
      const values = [node.textContent, node.getAttribute('aria-label'), node.title]
        .filter(Boolean)
        .map((value) => value.trim().replaceAll('\\\\', '/').toLowerCase());
      if (!values.some((value) => value === expected || value.endsWith('/' + expected) || value.includes(prefix))) continue;
      let target = node.closest('[role="treeitem"],[role="option"],button,[data-file-reference]');
      if (!target) {
        for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
          const rect = parent.getBoundingClientRect();
          if (rect.height >= 18 && rect.height <= 48 && rect.width >= 80 && (!filterRect || rect.top > filterRect.bottom)) {
            target = parent;
            break;
          }
        }
      }
      target ||= node;
      const rect = target.getBoundingClientRect();
      if (rect.height <= 80) addRect(rect);
    }
    matches.sort((left, right) => left.distance - right.distance || left.area - right.area);
    return matches[0] || null;
  })()`;
  // An exact filename search has one native result. Current Codex builds do
  // not expose a stable role for that row, so try its native position first
  // instead of paying the old 450ms semantic scan + 700ms fallback wait.
  // Repeated attempts are bounded and stop as soon as the file tab appears.
  let opened = null;
  for (const settleMs of [18, 72, 120]) {
    await delay(settleMs);
    const firstResultPoint = await evaluateValue(cdp, firstResultPointExpression);
    if (!firstResultPoint) break;
    await clickPoint(cdp, firstResultPoint);
    opened = await waitForNativeFileTab(cdp, wantedFileName, 150, 18);
    if (opened) break;
  }

  // Keyboard selection is the second fast path for builds whose first row is
  // positioned differently. It is attempted only while the filter is active.
  if (!opened) {
    await clickPoint(cdp, filterPoint);
    await pressKey(cdp, { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
    await pressKey(cdp, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    opened = await waitForNativeFileTab(cdp, wantedFileName, 260, 20);
  }

  let candidate = null;
  if (!opened) {
    // Some Codex builds do not refresh an active filename query when their
    // workspace index notices a newly-created file. Retype the exact query at
    // increasing intervals; each attempt still exits as soon as a row appears.
    for (const refreshWindowMs of [350, 700, 1_400, 2_400]) {
      await refreshFilter();
      candidate = await waitForPoint(cdp, candidateExpression, refreshWindowMs, 50);
      if (candidate) {
        await clickPoint(cdp, candidate);
        opened = await waitForNativeFileTab(cdp, wantedFileName, 1_200);
      }
      if (opened) break;
    }
  }
  if (!opened) return { ok: false, error: `Codex 文件筛选器中未找到 ${wantedFileName}` };
  await clickPoint(cdp, opened);
  return { ok: true, status: "opened", fileName: wantedFileName, elapsedMs: Date.now() - startedAt };
}

async function writePinFile(filePath, text) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeFile(filePath, text, { encoding: "utf8", flush: true }));
  writeQueues.set(filePath, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  }
}

async function loadSource() {
  const script = await readFile(userScriptPath, "utf8");
  const hash = createHash("sha256").update(script).digest("hex");
  return `window.__CODEX_PIN_SOURCE_HASH__=${JSON.stringify(hash)};\n${script}\n//# sourceURL=codex-pin.user.js`;
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port) || port <= 0) throw new Error("无法为 Codex CDP 分配本机端口");
  return port;
}

async function waitForLoopbackCdp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  do {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const version = await response.json();
        const webSocketUrl = new URL(version.webSocketDebuggerUrl);
        if (webSocketUrl.protocol !== "ws:" || webSocketUrl.hostname !== "127.0.0.1" || Number(webSocketUrl.port) !== port) {
          throw new Error("Codex 返回了非本机 CDP WebSocket 地址");
        }
        return webSocketUrl.toString();
      }
    } catch (error) {
      if (error.message.includes("非本机 CDP")) throw error;
    }
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(`Windows 已激活 Codex，但 CDP 端口 ${port} 未在 30 秒内就绪`);
}

async function launchCodexWithWindowsActivation() {
  if (process.platform !== "win32") throw new Error("AUMID activation is available only on Windows");
  if (!codexDesktop.appUserModelId) {
    throw new Error("当前 --app-path 没有对应的 Codex AUMID，无法使用 Windows 激活备用路径");
  }
  const port = await reserveLoopbackPort();
  const launchArguments = [
    `--user-data-dir="${profilePath.replaceAll('"', '\\"')}"`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ].join(" ");
  const processId = activateWindowsApp({
    appUserModelId: codexDesktop.appUserModelId,
    launchArguments,
  });
  try {
    const webSocketUrl = await waitForLoopbackCdp(port);
    const activatedBrowser = new CdpWebSocketBrowser(webSocketUrl);
    await activatedBrowser.open();
    return { browser: activatedBrowser, processId, port };
  } catch (error) {
    spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    throw error;
  }
}

function windowsSpawnWasDenied(error) {
  return process.platform === "win32"
    && (error?.code === "EPERM" || /(?:spawn\s+)?EPERM/i.test(error?.message || ""));
}

async function inject(browser, known) {
  const source = await loadSource();
  for (const target of (await browser.targets()).filter(isCodexRenderer)) {
    const existing = known.get(target.targetId);
    if (existing) {
      const status = await existing.cdp.send("Runtime.evaluate", {
        expression: "window.__codexChatPinInjection__?.sourceHash || null",
        returnByValue: true,
      });
      const currentHash = /__CODEX_PIN_SOURCE_HASH__=([^;]+)/.exec(source)?.[1] || "";
      if (status.result?.value === JSON.parse(currentHash)) continue;
      await existing.cdp.send("Runtime.evaluate", {
        expression: "try { window.__codexChatPinInjection__?.destroy?.(); } finally { delete window.__codexChatPinInjection__; }",
        awaitPromise: true,
      }).catch(() => {});
      await existing.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: existing.identifier }).catch(() => {});
      existing.cdp.close();
      known.delete(target.targetId);
    }
    const cdp = await browser.connect(target.targetId);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: "__codexChatPinPersist" });
    cdp.on("Runtime.bindingCalled", async ({ name, payload }) => {
      if (name !== "__codexChatPinPersist") return;
      let change;
      try {
        change = JSON.parse(payload);
        if (!change || typeof change !== "object") return;
        const sessionId = safeSessionId(change.sessionId);
        const canonicalPinFilePath = pinFileFor(sessionId);
        const revisionAction = typeof change.type === "string" && change.type.startsWith("revision-")
          ? change.type.slice("revision-".length)
          : "";
        const collectionAction = typeof change.type === "string" && change.type.startsWith("collection-")
          ? change.type.slice("collection-".length)
          : "";
        if (collectionAction) {
          let state;
          if (collectionAction === "enable") {
            state = await enableCollection(cdp, target.targetId, sessionId, String(change.sourceFileName || ""));
          } else if (collectionAction === "disable") {
            state = await disableCollection(target.targetId, sessionId);
          } else if (collectionAction === "status") {
            state = await currentCollectionState(cdp, target.targetId, sessionId);
          } else if (collectionAction === "enqueue") {
            state = await enqueueCollection(
              cdp,
              target.targetId,
              sessionId,
              String(change.input || ""),
              change.composerCleared === true,
              String(change.desktopExecutionLabel || ""),
            );
          } else if (collectionAction === "retry") {
            state = await retryFailedCollection(target.targetId, sessionId);
          } else if (collectionAction === "clear") {
            state = await clearCollectionQueue(target.targetId, sessionId);
          } else if (collectionAction === "clear-reports") {
            state = await clearCollectionReports(target.targetId, sessionId);
          } else if (collectionAction === "open-result") {
            state = await openCollectionResult(cdp, target.targetId, sessionId);
          } else {
            throw new Error(`未知采集操作：${collectionAction}`);
          }
          if (["status", "enable", "disable", "clear", "clear-reports"].includes(collectionAction)) {
            const queue = await loadCollectionQueue(sessionId);
            state = { ...state, results: await collectionResultsForQueue(queue) };
          }
          await postHostMessage(cdp, {
            type: "collection-result",
            action: collectionAction,
            requestId: change.requestId,
            sessionId,
            ok: true,
            state,
          });
        } else if (revisionAction) {
          let state;
          if (revisionAction === "enable") {
            state = await enableRevision(cdp, target.targetId, sessionId);
          } else if (revisionAction === "disable") {
            state = await disableRevision(target.targetId, sessionId);
          } else if (revisionAction === "status") {
            state = await currentRevisionState(cdp, target.targetId, sessionId);
          } else if (revisionAction === "turn-start") {
            state = await beginRevisionTurn(
              cdp,
              target.targetId,
              sessionId,
              String(change.turnId || change.requestId),
              String(change.input || ""),
            );
          } else if (revisionAction === "turn-finish") {
            state = await finishRevisionTurn(target.targetId, sessionId, String(change.turnId || ""));
          } else if (revisionAction === "cleanup") {
            state = { enabled: false, composer: await cleanRevisionComposer(cdp) };
          } else {
            throw new Error(`未知修订操作：${revisionAction}`);
          }
          await postHostMessage(cdp, {
            type: "revision-result",
            action: revisionAction,
            requestId: change.requestId,
            sessionId,
            ok: true,
            state,
          });
        } else if (change.type === "document" && typeof change.text === "string") {
          const activeRevision = revisionStates.get(target.targetId);
          const revisionDisabled = activeRevision?.sessionId === sessionId;
          if (revisionDisabled) revisionStates.delete(target.targetId);
          const activeCollection = collectionModes.get(sessionId);
          const collectionDisabled = activeCollection?.sessionId === sessionId;
          if (collectionDisabled) {
            collectionModes.delete(sessionId);
            const collectionQueue = await loadCollectionQueue(sessionId);
            collectionQueue.mode = null;
            await persistCollectionQueue(collectionQueue);
          }
          await mkdir(pinDirectory, { recursive: true });
          await writePinFile(canonicalPinFilePath, change.text);
          let openResult = null;
          let pinTarget = null;
          if (change.openAfterSave === true) {
            try {
              pinTarget = await nativePinTarget(cdp, sessionId);
              if (pinTarget.mirrored) {
                await mkdir(path.dirname(pinTarget.filePath), { recursive: true });
                await writePinFile(pinTarget.filePath, change.text);
              }
              openResult = await withPinVisibleToNativeIndexer(
                pinTarget.filePath,
                pinTarget.workspacePath,
                () => openNativeFileTab(cdp, pinTarget.filePath),
              );
            } catch (error) {
              openResult = {
                ok: false,
                error: pinTarget?.mirrored
                  ? `无法在当前任务工作区创建或打开 Pin 镜像：${error.message}`
                  : error.message,
              };
            }
          }
          if (openResult && openResult.ok !== true) {
            openResult = await explainNativeOpenFailure(
              cdp,
              openResult,
              pinTarget?.filePath || canonicalPinFilePath,
            );
          }
          await postHostMessage(cdp, {
            type: "save-result",
            requestId: change.requestId,
            sessionId,
            ok: true,
            fileName: path.basename(canonicalPinFilePath),
            openResult,
            revisionDisabled,
            collectionDisabled,
          });
        } else if (change.type === "open") {
          let openResult;
          try {
            await stat(canonicalPinFilePath);
            const pinTarget = await nativePinTarget(cdp, sessionId);
            if (pinTarget.mirrored) {
              await mkdir(path.dirname(pinTarget.filePath), { recursive: true });
              try {
                await stat(pinTarget.filePath);
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
                await copyFile(canonicalPinFilePath, pinTarget.filePath);
              }
            }
            const requestedPoint = change.fileMenuPoint;
            const fileMenuPoint = requestedPoint && Number.isFinite(requestedPoint.x) && Number.isFinite(requestedPoint.y)
              ? { x: requestedPoint.x, y: requestedPoint.y }
              : null;
            openResult = await withPinVisibleToNativeIndexer(
              pinTarget.filePath,
              pinTarget.workspacePath,
              () => openNativeFileTab(cdp, pinTarget.filePath, { fileMenuPoint }),
            ).catch((error) => ({ ok: false, error: error.message }));
            if (openResult.ok !== true) {
              openResult = await explainNativeOpenFailure(cdp, openResult, pinTarget.filePath);
            }
          } catch (error) {
            openResult = error.code === "ENOENT"
              ? { ok: false, error: "当前任务还没有 Pin 文件，请先 Pin 一条助手回复" }
              : { ok: false, error: error.message };
          }
          await postHostMessage(cdp, {
            type: "open-result",
            requestId: change.requestId,
            sessionId,
            ok: openResult.ok === true,
            fileName: path.basename(canonicalPinFilePath),
            openResult,
          });
        } else if (change.type === "load") {
          try {
            const [text, info] = await Promise.all([
              readFile(canonicalPinFilePath, "utf8"),
              stat(canonicalPinFilePath),
            ]);
            await postHostMessage(cdp, {
              type: "load-result",
              requestId: change.requestId,
              sessionId,
              ok: true,
              exists: true,
              text,
              modifiedAt: info.mtimeMs,
              fileName: path.basename(canonicalPinFilePath),
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await postHostMessage(cdp, {
              type: "load-result",
              requestId: change.requestId,
              sessionId,
              ok: true,
              exists: false,
              fileName: path.basename(canonicalPinFilePath),
            });
          }
        }
      } catch (error) {
        console.error(`Chat Pin persistence failed: ${error.message}`);
        if (change?.requestId) {
          const isRevision = typeof change.type === "string" && change.type.startsWith("revision-");
          const isCollection = typeof change.type === "string" && change.type.startsWith("collection-");
          await postHostMessage(cdp, {
            type: isRevision ? "revision-result" : isCollection ? "collection-result" : change.type === "load" ? "load-result" : "save-result",
            ...(isRevision ? { action: change.type.slice("revision-".length) } : {}),
            ...(isCollection ? { action: change.type.slice("collection-".length) } : {}),
            requestId: change.requestId,
            sessionId: safeSessionId(change.sessionId),
            ok: false,
            error: error.message,
          }).catch(() => {});
        }
      }
    });
    const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    const result = await cdp.send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Pin injection failed");
    known.set(target.targetId, { cdp, identifier });
    rendererWasInjected = true;
    const diagnostics = await cdp.send("Runtime.evaluate", {
      expression: "window.__codexChatPinInjection__?.diagnostics?.() || null",
      returnByValue: true,
    });
    console.log(`Chat Pin diagnostics: ${JSON.stringify(diagnostics.result?.value || null)}`);
    console.log(`Injected Chat Pin into Codex renderer ${target.targetId}`);
    setTimeout(() => {
      cdp.send("Runtime.evaluate", {
        expression: "window.__codexChatPinInjection__?.diagnostics?.() || null",
        returnByValue: true,
      }).then((later) => console.log(`Chat Pin delayed diagnostics: ${JSON.stringify(later.result?.value || null)}`)).catch(() => {});
    }, 8_000);
  }
}

let child = null;
let browser = null;
let managedProcessId = null;
let rendererWasInjected = false;
const known = new Map();

function stopManagedCodex() {
  const processId = managedProcessId || child?.pid;
  if (!processId || (child && child.exitCode !== null)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

function stopCollectionBackend() {
  void collectionBackend?.stop();
  collectionBackend = null;
}

process.once("exit", () => {
  stopCollectionBackend();
  stopManagedCodex();
});

try {
  if (!shouldLaunch) throw new Error("Existing Codex windows cannot be injected without CDP. Use: npm start");
  if (forceWindowsActivation) {
    const activated = await launchCodexWithWindowsActivation();
    browser = activated.browser;
    managedProcessId = activated.processId;
    console.log(`Chat Pin launched Codex through Windows app activation on loopback CDP port ${activated.port}.`);
  } else {
    try {
      child = spawn(appPath, [
        `--user-data-dir=${profilePath}`,
        "--remote-debugging-pipe",
      ], {
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        windowsHide: false,
      });
      managedProcessId = child.pid || null;
      browser = new CdpPipeBrowser(child);
      const launchFailure = new Promise((_, reject) => child.once("error", reject));
      await Promise.race([browser.open(), launchFailure]);
    } catch (error) {
      browser?.close();
      browser = null;
      child = null;
      managedProcessId = null;
      if (!windowsSpawnWasDenied(error)) throw error;
      console.warn("Direct Codex launch was denied by Windows (EPERM); retrying through the registered app AUMID.");
      const activated = await launchCodexWithWindowsActivation();
      browser = activated.browser;
      managedProcessId = activated.processId;
      console.log(`Chat Pin launched Codex through Windows app activation on loopback CDP port ${activated.port}.`);
    }
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && known.size === 0) {
    await inject(browser, known);
    if (known.size === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (known.size === 0) throw new Error("Codex started, but no main renderer was found within 45 seconds.");
  if (!shouldWatch) process.exit(0);
  console.log("Chat Pin is active. Keep this terminal open while using the injected Codex window.");
  const interval = setInterval(() => inject(browser, known).catch((error) => console.error(`Reinjection waiting: ${error.message}`)), 2_000);
  const stop = () => {
    clearInterval(interval);
    for (const { cdp } of known.values()) cdp.close();
    browser?.close();
    stopCollectionBackend();
    stopManagedCodex();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  if (process.platform === "win32") process.once("SIGBREAK", stop);
} catch (error) {
  const message = error.message === "CDP pipe ended" && !rendererWasInjected
    ? "Chat Pin 已经在使用同一个独立 Codex 配置运行。请继续使用已打开的 Pin 窗口，或先关闭它再重新启动。"
    : error.message;
  console.error(`Chat Pin launcher: ${message}`);
  browser?.close();
  stopCollectionBackend();
  stopManagedCodex();
  process.exitCode = 1;
}
