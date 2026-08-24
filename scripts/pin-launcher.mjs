#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexDesktop } from "./codex-app.mjs";
import { CdpPipeBrowser } from "./cdp-pipe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = path.join(root, ".codex-pin-profile");
const userScriptPath = path.join(root, "inject", "codex-pin.user.js");
const pinDirectory = path.join(root, "pins");
const legacyPinDirectory = path.join(root, "temp");
const localGitExcludePath = path.join(root, ".git", "info", "exclude");
const pinGitExcludeRule = "/pins/pin_*.md";
const argv = process.argv.slice(2);
const args = new Set(argv);
const shouldLaunch = args.has("--launch");
const shouldWatch = args.has("--watch");
const writeQueues = new Map();
let pinVisibilityQueue = Promise.resolve();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  await mkdir(pinDirectory, { recursive: true });

  if (existsSync(localGitExcludePath)) {
    try {
      const current = await readFile(localGitExcludePath, "utf8");
      const rules = current.split(/\r?\n/).map((line) => line.trim());
      if (!rules.includes(pinGitExcludeRule)) {
        const separator = current && !current.endsWith("\n") ? "\n" : "";
        await writeFile(localGitExcludePath, `${current}${separator}${pinGitExcludeRule}\n`, "utf8");
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

async function withPinVisibleToNativeIndexer(action) {
  const run = async () => {
    let excludeRuleRemoved = false;
    try {
      if (existsSync(localGitExcludePath)) {
        const current = await readFile(localGitExcludePath, "utf8");
        const newline = current.includes("\r\n") ? "\r\n" : "\n";
        const lines = current.split(/\r?\n/);
        const filtered = lines.filter((line) => line.trim() !== pinGitExcludeRule);
        if (filtered.length !== lines.length) {
          await writeFile(localGitExcludePath, filtered.join(newline), "utf8");
          excludeRuleRemoved = true;
          // Codex maintains its own workspace file list. Give its watcher one
          // short turn to observe the local exclude change before searching.
          await delay(120);
        }
      }
      return await action();
    } finally {
      if (excludeRuleRemoved) {
        try {
          const current = await readFile(localGitExcludePath, "utf8");
          const rules = current.split(/\r?\n/).map((line) => line.trim());
          if (!rules.includes(pinGitExcludeRule)) {
            const separator = current && !current.endsWith("\n") ? "\n" : "";
            await writeFile(localGitExcludePath, `${current}${separator}${pinGitExcludeRule}\n`, "utf8");
          }
        } catch (error) {
          console.warn(`Chat Pin could not restore .git/info/exclude: ${error.message}`);
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

async function explainNativeOpenFailure(cdp, result, filePath) {
  if (result?.ok === true) return result;
  const context = await nativeWorkspaceContext(cdp);
  const workspacePath = context?.workspacePath?.trim();
  if (!workspacePath) return result;
  const relative = path.relative(workspacePath, filePath);
  const fileIsInWorkspace = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (fileIsInWorkspace) return result;
  return {
    ...result,
    error: `${result?.error || "原生文件打开失败"}；当前任务工作区是 ${workspacePath}，Pin 文件保存在 ${root}`,
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
            const label = [node.title, node.getAttribute('aria-label')].filter(Boolean).join(' ');
            return visible(node) && /显示.{0,3}隐藏侧边面板|切换侧边面板|show.{0,4}hide side panel|toggle side panel/i.test(label);
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
    if (!fileMenuPoint) {
      toggleState = await evaluateValue(cdp, togglePointExpression);
      if (toggleState && !toggleState.open) {
        await clickPoint(cdp, toggleState);
        fileMenuPoint = await waitForStablePoint(cdp, fileMenuPointExpression(), 1_500);
      }
    }
    for (let attempt = 0; attempt < 24 && !fileMenuPoint && !addTabPoint; attempt += 1) {
      fileMenuPoint = await evaluateValue(cdp, fileMenuPointExpression());
      if (!fileMenuPoint) addTabPoint = await evaluateValue(cdp, addTabExpression);
      if (!fileMenuPoint && !addTabPoint) await delay(150);
    }

    if (!fileMenuPoint && !addTabPoint) {
      toggleState = await evaluateValue(cdp, togglePointExpression);
      if (!toggleState) return { ok: false, error: "未找到 Codex 原生侧栏开关" };
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

  await clickPoint(cdp, filterPoint);
  await pressKey(cdp, { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await pressKey(cdp, { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp.send("Input.insertText", { text: wantedFileName });
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
    // A genuinely slow workspace index is waited on, but the polling exits on
    // the first rendered filename rather than imposing a fixed delay.
    candidate = await waitForPoint(cdp, candidateExpression, 3_000, 50);
    if (candidate) {
      await clickPoint(cdp, candidate);
      opened = await waitForNativeFileTab(cdp, wantedFileName, 1_200);
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
        const pinFilePath = pinFileFor(sessionId);
        if (change.type === "document" && typeof change.text === "string") {
          await mkdir(pinDirectory, { recursive: true });
          await writePinFile(pinFilePath, change.text);
          let openResult = change.openAfterSave === true
            ? await withPinVisibleToNativeIndexer(() => (
              openNativeFileTab(cdp, pinFilePath)
            )).catch((error) => ({ ok: false, error: error.message }))
            : null;
          if (openResult && openResult.ok !== true) {
            openResult = await explainNativeOpenFailure(cdp, openResult, pinFilePath);
          }
          await postHostMessage(cdp, {
            type: "save-result",
            requestId: change.requestId,
            sessionId,
            ok: true,
            fileName: path.basename(pinFilePath),
            openResult,
          });
        } else if (change.type === "open") {
          let openResult;
          try {
            await stat(pinFilePath);
            const requestedPoint = change.fileMenuPoint;
            const fileMenuPoint = requestedPoint && Number.isFinite(requestedPoint.x) && Number.isFinite(requestedPoint.y)
              ? { x: requestedPoint.x, y: requestedPoint.y }
              : null;
            openResult = await withPinVisibleToNativeIndexer(() => (
              openNativeFileTab(cdp, pinFilePath, { fileMenuPoint })
            )).catch((error) => ({ ok: false, error: error.message }));
            if (openResult.ok !== true) {
              openResult = await explainNativeOpenFailure(cdp, openResult, pinFilePath);
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
            fileName: path.basename(pinFilePath),
            openResult,
          });
        } else if (change.type === "load") {
          try {
            const [text, info] = await Promise.all([
              readFile(pinFilePath, "utf8"),
              stat(pinFilePath),
            ]);
            await postHostMessage(cdp, {
              type: "load-result",
              requestId: change.requestId,
              sessionId,
              ok: true,
              exists: true,
              text,
              modifiedAt: info.mtimeMs,
              fileName: path.basename(pinFilePath),
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await postHostMessage(cdp, {
              type: "load-result",
              requestId: change.requestId,
              sessionId,
              ok: true,
              exists: false,
              fileName: path.basename(pinFilePath),
            });
          }
        }
      } catch (error) {
        console.error(`Chat Pin persistence failed: ${error.message}`);
        if (change?.requestId) {
          await postHostMessage(cdp, {
            type: change.type === "load" ? "load-result" : "save-result",
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
let rendererWasInjected = false;
const known = new Map();

function stopManagedCodex() {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

process.once("exit", stopManagedCodex);

try {
  if (!shouldLaunch) throw new Error("Existing Codex windows cannot be injected without CDP. Use: npm start");
  child = spawn(appPath, [
    `--user-data-dir=${profilePath}`,
    "--remote-debugging-pipe",
  ], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  browser = new CdpPipeBrowser(child);
  const launchFailure = new Promise((_, reject) => {
    child.once("error", (error) => {
      const hint = error.code === "EPERM" && process.platform === "win32"
        ? "；当前启动的是 app\\ChatGPT.exe，而不是 resources\\codex.exe。请确认当前账户可启动 Microsoft Store Codex，或用 --app-path 指定可执行文件"
        : "";
      reject(new Error(`无法启动 Codex Desktop (${error.code || error.message})${hint}`));
    });
  });
  await Promise.race([browser.open(), launchFailure]);
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
  stopManagedCodex();
  process.exitCode = 1;
}
