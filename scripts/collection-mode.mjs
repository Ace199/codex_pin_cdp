import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const COLLECTION_MARKER = "[Chat Pin 采集任务]";
export const DEFAULT_COLLECTION_COMPACT_TOKEN_LIMIT = 100_000;

const ignoredCollectionSourceDirectories = new Set([".git", ".codex-pin-profile", "node_modules"]);
const ignoredCollectionSearchDirectories = new Set([
  ...ignoredCollectionSourceDirectories,
  ".next", ".venv", "__pycache__", "build", "coverage", "dist", "target", "vendor",
]);
const searchableCollectionExtensions = new Set([".csv", ".json", ".md", ".mdx", ".txt", ".yaml", ".yml"]);

const windowsDesktopCliPattern = /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex(?:\.exe)?$/i;

export function retryFailedCollectionItems(items, retriedAt = new Date().toISOString()) {
  let retriedCount = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status !== "failed") continue;
    item.status = "queued";
    item.startedAt = null;
    item.completedAt = null;
    item.threadId = null;
    item.turnId = null;
    item.output = "";
    item.outputTruncated = false;
    item.changedFiles = [];
    item.executionProfile = null;
    item.preflightSummary = null;
    item.metrics = null;
    item.error = "";
    item.retriedAt = retriedAt;
    item.retryCount = Number(item.retryCount || 0) + 1;
    retriedCount += 1;
  }
  return retriedCount;
}

export function clearCollectionItems(queue) {
  const clearedCount = Array.isArray(queue?.items) ? queue.items.length : 0;
  queue.generation = Number.isSafeInteger(queue?.generation) ? queue.generation + 1 : 1;
  queue.items = [];
  return clearedCount;
}

export function clearCompletedCollectionItems(queue) {
  if (!Array.isArray(queue?.items)) return 0;
  const previousCount = queue.items.length;
  queue.items = queue.items.filter((item) => item?.status !== "completed");
  return previousCount - queue.items.length;
}

export function collectionItemIsCurrent(queue, item, generation) {
  return queue?.generation === generation && Array.isArray(queue.items) && queue.items.includes(item);
}

export function recoverCollectionItems(items, queueVersion, recoveredAt = new Date().toISOString()) {
  let recoveredCount = 0;
  const legacyReadOnlyQueue = Number(queueVersion || 0) < 5;
  for (const item of Array.isArray(items) ? items : []) {
    if (legacyReadOnlyQueue && ["queued", "running"].includes(item?.status)) {
      item.status = "failed";
      item.error = "采集模式已升级为工作区写入；请确认规则后点击重试";
      item.startedAt = null;
      item.completedAt = recoveredAt;
      recoveredCount += 1;
    } else if (item?.status === "running") {
      item.status = "queued";
      item.error = "启动器重启后重新排队";
      item.startedAt = null;
      recoveredCount += 1;
    }
  }
  return recoveredCount;
}

function normalizedKey(value, platform) {
  const text = String(value || "");
  return platform === "win32" ? text.toLowerCase() : text;
}

function executableSpec(filePath, source, processExecPath, platform, pathExists) {
  const resolved = String(filePath || "").trim();
  if (!resolved || !pathExists(resolved)) return null;
  if (platform === "win32" && windowsDesktopCliPattern.test(resolved)) return null;
  if (/\.m?js$/i.test(resolved)) {
    return { command: processExecPath, prefixArgs: [resolved], displayPath: resolved, source };
  }
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(resolved)) {
    const npmEntry = path.win32.join(path.win32.dirname(resolved), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (pathExists(npmEntry)) {
      return { command: processExecPath, prefixArgs: [npmEntry], displayPath: npmEntry, source: `${source}-npm-entry` };
    }
    return null;
  }
  return { command: resolved, prefixArgs: [], displayPath: resolved, source };
}

export function resolveCodexCli({
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
  processExecPath = process.execPath,
  pathExists = existsSync,
} = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const candidates = [];
  const seen = new Set();
  const add = (filePath, source) => {
    const key = normalizedKey(filePath, platform);
    if (!filePath || seen.has(key)) return;
    seen.add(key);
    candidates.push({ filePath, source });
  };

  const explicit = String(environment.CODEX_PIN_CLI_PATH || "").trim();
  if (explicit) add(platformPath.resolve(explicit), "explicit");

  const pathEntries = String(environment.PATH || "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of pathEntries) {
    if (platform === "win32") {
      add(path.win32.join(directory, "codex.cmd"), "path");
      add(path.win32.join(directory, "codex.exe"), "path");
      add(path.win32.join(directory, "codex"), "path");
    } else {
      add(path.posix.join(directory, "codex"), "path");
    }
  }

  if (platform === "win32") {
    const npmRoot = environment.APPDATA && path.win32.join(environment.APPDATA, "npm");
    if (npmRoot) {
      add(path.win32.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js"), "npm-global");
      add(path.win32.join(npmRoot, "codex.cmd"), "npm-global");
    }
  } else {
    for (const npmEntry of [
      "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
      "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
      path.posix.join(homeDirectory, ".npm-global", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.posix.join(homeDirectory, ".npm-packages", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    ]) add(npmEntry, "npm-global");
  }

  for (const candidate of candidates) {
    const spec = executableSpec(candidate.filePath, candidate.source, processExecPath, platform, pathExists);
    if (spec) return spec;
  }
  return null;
}

export async function resolveCollectionSourceInWorkspace(workspacePath, fileName, { maxEntries = 50_000 } = {}) {
  const rawWorkspace = String(workspacePath || "").trim();
  if (!rawWorkspace || !path.isAbsolute(rawWorkspace)) throw new Error("当前任务没有可确认的本地工作区");
  const workspace = path.resolve(rawWorkspace);
  const requested = String(fileName || "").trim();
  if (!requested || path.basename(requested) !== requested || path.extname(requested).toLowerCase() !== ".md") {
    throw new Error("当前打开的文件不是可用的 Markdown 采集规则文件");
  }
  const rootInfo = await stat(workspace).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error("当前任务的工作区路径不可访问");

  const matches = [];
  const pending = [workspace];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        throw new Error(`工作区文件过多，无法可靠定位 ${requested}`);
      }
      if (entry.isDirectory()) {
        if (!ignoredCollectionSourceDirectories.has(entry.name)) pending.push(path.join(directory, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase() === requested.toLowerCase()) {
        matches.push(path.join(directory, entry.name));
      }
    }
  }
  if (!matches.length) throw new Error(`当前工作区中未找到 ${requested}`);
  if (matches.length > 1) {
    throw new Error(`当前工作区中存在 ${matches.length} 个同名文件 ${requested}，无法确定采集规则来源`);
  }
  return matches[0];
}

function spawnCli(cli, args, options = {}) {
  return spawn(cli.command, [...(cli.prefixArgs || []), ...args], {
    windowsHide: true,
    ...options,
  });
}

function runCliCommand(cli, args, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnCli(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once("error", (error) => finish({ ok: false, error: error.message, code: error.code }));
    child.once("exit", (code, signal) => finish({
      ok: code === 0,
      exitCode: code,
      signal,
      error: code === 0 ? "" : (stderr.trim() || stdout.trim() || `退出码 ${code}`),
    }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `命令在 ${timeoutMs}ms 内没有结束`, timeout: true });
    }, timeoutMs);
  });
}

export async function probeCodexCli(cli) {
  if (!cli) return { ok: false, error: "未检测到独立 Codex CLI" };
  const version = await runCliCommand(cli, ["--version"]);
  if (!version.ok) {
    return { ok: false, stage: "version", error: version.error || "Codex CLI 无法执行", cli };
  }
  const appServer = await runCliCommand(cli, ["app-server", "--help"]);
  if (!appServer.ok) {
    return { ok: false, stage: "app-server", error: appServer.error || "Codex CLI 不支持 app-server", cli };
  }
  return {
    ok: true,
    cli,
    version: version.stdout.trim() || version.stderr.trim(),
  };
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanedUrl(value) {
  return String(value || "").replace(/[),.;:!?，。；：！？】》]+$/u, "");
}

function extractedUrls(text, origin) {
  const results = [];
  for (const match of String(text || "").matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    const url = cleanedUrl(match[0]);
    if (url) results.push({ url, origin });
  }
  return results;
}

function normalizedGithubRepository(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!owner || !repository) return null;
  return {
    owner,
    repository,
    canonicalUrl: `https://github.com/${owner}/${repository}`,
  };
}

function extractedDates(text, origin) {
  const patterns = [
    /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/gu,
    /(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日/gu,
  ];
  return patterns.flatMap((pattern) => [...String(text || "").matchAll(pattern)].map((match) => ({ value: match[0], origin })));
}

function extractedMarkdownLabels(text, origin) {
  const labels = [];
  for (const match of String(text || "").matchAll(/\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s]+)\)/gu)) {
    const name = match[1].trim();
    const url = cleanedUrl(match[2]);
    if (name && url) labels.push({ name, origin, evidence: "markdown-link", url });
  }
  return labels;
}

export function extractCollectionMetadata(sourceMarkdown, userInput) {
  const inputs = [
    { text: String(sourceMarkdown ?? ""), origin: "rules" },
    { text: String(userInput ?? ""), origin: "input" },
  ];
  const urlOccurrences = inputs.flatMap(({ text, origin }) => extractedUrls(text, origin));
  const urlMap = new Map();
  for (const occurrence of urlOccurrences) {
    const current = urlMap.get(occurrence.url) || { url: occurrence.url, origins: [] };
    if (!current.origins.includes(occurrence.origin)) current.origins.push(occurrence.origin);
    urlMap.set(occurrence.url, current);
  }
  const urls = [...urlMap.values()];
  const githubRepositories = uniqueBy(urls.map((entry) => {
    const repository = normalizedGithubRepository(entry.url);
    return repository ? { ...repository, origins: entry.origins } : null;
  }).filter(Boolean), (entry) => entry.canonicalUrl.toLowerCase());
  const projectCandidates = [
    ...inputs.flatMap(({ text, origin }) => extractedMarkdownLabels(text, origin)),
    ...githubRepositories.map((entry) => ({
      name: entry.repository,
      origin: entry.origins.includes("input") ? "input" : "rules",
      evidence: "github-repository-slug",
      url: entry.canonicalUrl,
    })),
  ];
  return {
    version: 1,
    urls,
    githubRepositories,
    dates: uniqueBy(inputs.flatMap(({ text, origin }) => extractedDates(text, origin)), (entry) => `${entry.origin}:${entry.value}`),
    projectCandidates: uniqueBy(projectCandidates, (entry) => `${entry.origin}:${entry.name}:${entry.url}`.toLowerCase()),
  };
}

function normalizedRelativePath(workspace, filePath) {
  return path.relative(workspace, filePath).split(path.sep).join("/");
}

export async function findExactWorkspaceUrlMatches(workspacePath, urls, {
  maxFiles = 4_000,
  maxEntries = 25_000,
  maxBytes = 24 * 1024 * 1024,
  maxFileBytes = 2 * 1024 * 1024,
  maxMatches = 80,
} = {}) {
  const workspace = path.resolve(String(workspacePath || ""));
  const needles = uniqueBy((Array.isArray(urls) ? urls : []).map(cleanedUrl).filter(Boolean), (value) => value);
  if (!needles.length) return { matches: [], scannedFiles: 0, examinedEntries: 0, scannedBytes: 0, truncated: false };
  const pending = [workspace];
  const matches = [];
  let scannedFiles = 0;
  let examinedEntries = 0;
  let scannedBytes = 0;
  let truncated = false;
  while (pending.length && !truncated) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      examinedEntries += 1;
      if (examinedEntries > maxEntries) {
        truncated = true;
        break;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredCollectionSearchDirectories.has(entry.name)) pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !searchableCollectionExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (scannedFiles >= maxFiles || scannedBytes >= maxBytes) {
        truncated = true;
        break;
      }
      const info = await stat(entryPath).catch(() => null);
      if (!info || info.size > maxFileBytes || scannedBytes + info.size > maxBytes) continue;
      const content = await readFile(entryPath, "utf8").catch(() => "");
      scannedFiles += 1;
      scannedBytes += info.size;
      if (!content) continue;
      const lines = content.split(/\r?\n/);
      for (const needle of needles) {
        const lineIndex = lines.findIndex((line) => line.includes(needle));
        if (lineIndex === -1) continue;
        matches.push({
          url: needle,
          path: normalizedRelativePath(workspace, entryPath),
          line: lineIndex + 1,
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
  }
  return { matches, scannedFiles, examinedEntries, scannedBytes, truncated };
}

export async function verifyGithubRepositories(repositories, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 4_000,
  concurrency = 4,
  maxRepositories = 30,
} = {}) {
  const targets = (Array.isArray(repositories) ? repositories : []).slice(0, maxRepositories);
  if (!targets.length || typeof fetchImpl !== "function") return [];
  const results = new Array(targets.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(target.canonicalUrl, {
          method: "HEAD",
          redirect: "follow",
          headers: { "user-agent": "codex-chat-pin/0.9" },
          signal: controller.signal,
        });
        const canonicalUrl = cleanedUrl(response.url || target.canonicalUrl).replace(/\.git$/i, "");
        results[index] = {
          requestedUrl: target.canonicalUrl,
          status: response.status === 404 ? "not-found-or-private" : response.ok ? "reachable" : "unknown",
          httpStatus: Number(response.status || 0),
          canonicalUrl,
          redirected: canonicalUrl.toLowerCase() !== target.canonicalUrl.toLowerCase(),
        };
      } catch (error) {
        results[index] = {
          requestedUrl: target.canonicalUrl,
          status: "unknown",
          httpStatus: 0,
          canonicalUrl: target.canonicalUrl,
          redirected: false,
          error: error?.name === "AbortError" ? "timeout" : String(error?.message || error).slice(0, 160),
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results.filter(Boolean);
}

export async function prepareCollectionPreflight({ workspacePath, sourceMarkdown, userInput, fetchImpl } = {}) {
  const startedAt = Date.now();
  const metadata = extractCollectionMetadata(sourceMarkdown, userInput);
  const inputUrls = metadata.urls.filter((entry) => entry.origins.includes("input")).map((entry) => entry.url);
  const inputRepositories = metadata.githubRepositories.filter((entry) => entry.origins.includes("input"));
  const [workspaceSearch, githubVerification] = await Promise.all([
    findExactWorkspaceUrlMatches(workspacePath, inputUrls).catch((error) => ({
      matches: [], scannedFiles: 0, examinedEntries: 0, scannedBytes: 0, truncated: true, error: String(error?.message || error).slice(0, 200),
    })),
    verifyGithubRepositories(inputRepositories, { fetchImpl }),
  ]);
  return {
    version: 1,
    metadata,
    workspaceSearch,
    githubVerification,
    durationMs: Date.now() - startedAt,
  };
}

export function parseDesktopExecutionPreference(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label) return null;
  const normalized = label.toLowerCase();
  const variantMatch = normalized.match(/(?:gpt[- ]*)?(5\.\d+)\s*(sol|terra|luna)\b/i);
  const baseMatch = normalized.match(/(?:gpt[- ]*)?(5\.[45])\b/i);
  const model = variantMatch
    ? `gpt-${variantMatch[1]}-${variantMatch[2].toLowerCase()}`
    : baseMatch
      ? `gpt-${baseMatch[1]}`
      : "";
  if (!model) return null;
  let effort = "";
  if (/\bultra\b|极致/iu.test(normalized)) effort = "ultra";
  else if (/\bxhigh\b|超高/iu.test(normalized)) effort = "xhigh";
  else if (/\bmax\b|最高/iu.test(normalized)) effort = "max";
  else if (/\bhigh\b|高/iu.test(normalized)) effort = "high";
  else if (/\bmedium\b|中/iu.test(normalized)) effort = "medium";
  else if (/\blow\b|低/iu.test(normalized)) effort = "low";
  return { source: "desktop-ui", label, model, effort };
}

export function selectCollectionExecutionProfile(
  preflight,
  sourceMarkdown,
  userInput,
  environment = process.env,
  desktopPreference = null,
) {
  const forcedProfile = String(environment.CODEX_PIN_COLLECTION_PROFILE || "").trim().toLowerCase();
  if (forcedProfile === "inherit") return { profile: "inherit", model: "", effort: "", reasons: ["environment"] };
  const text = `${sourceMarkdown || ""}\n${userInput || ""}`;
  const duplicateRepositoryNames = new Set();
  const ownersByRepository = new Map();
  for (const entry of preflight?.metadata?.githubRepositories || []) {
    const key = entry.repository.toLowerCase();
    const owners = ownersByRepository.get(key) || new Set();
    owners.add(entry.owner.toLowerCase());
    ownersByRepository.set(key, owners);
    if (owners.size > 1) duplicateRepositoryNames.add(key);
  }
  const reasons = [];
  if (/(?:CVE-\d+|\bsecurity\b|安全审计|漏洞|恶意代码|供应链攻击)/iu.test(text)) reasons.push("security");
  if (/(?:迁移|重定向|更名|改名|\brenamed?\b|\bmoved?\b)/iu.test(text)) reasons.push("repository-migration");
  if (/(?:同名|冲突|\bduplicate\b|\bcollision\b)/iu.test(text) || duplicateRepositoryNames.size) reasons.push("name-conflict");
  if ((preflight?.githubVerification || []).some((entry) => entry.redirected)) reasons.push("github-redirect");
  const complex = forcedProfile === "complex" || (forcedProfile !== "routine" && reasons.length > 0);
  const environmentModel = String(environment.CODEX_PIN_COLLECTION_MODEL || "").trim();
  const environmentEffort = String(environment.CODEX_PIN_COLLECTION_EFFORT || "").trim();
  const useDesktopPreference = !forcedProfile && !environmentModel && !environmentEffort && desktopPreference?.model;
  if (useDesktopPreference) {
    return {
      profile: "desktop-selection",
      model: String(desktopPreference.model).trim(),
      effort: String(desktopPreference.effort || "").trim(),
      reasons: ["desktop-ui"],
      desktopLabel: String(desktopPreference.label || "").trim(),
    };
  }
  return {
    profile: complex ? "complex" : "routine",
    model: environmentModel || (complex ? "gpt-5.6-sol" : "gpt-5.6-terra"),
    effort: environmentEffort || (complex ? "high" : "medium"),
    reasons,
  };
}

export function collectionRuntimeOptions(environment = process.env) {
  const rawLimit = String(environment.CODEX_PIN_COLLECTION_COMPACT_TOKENS ?? DEFAULT_COLLECTION_COMPACT_TOKEN_LIMIT).trim();
  const parsedLimit = Number(rawLimit);
  const compactTokenLimit = Number.isSafeInteger(parsedLimit) && parsedLimit >= 0
    ? parsedLimit
    : DEFAULT_COLLECTION_COMPACT_TOKEN_LIMIT;
  const requestedScope = String(environment.CODEX_PIN_COLLECTION_COMPACT_SCOPE || "body_after_prefix").trim();
  return {
    compactTokenLimit,
    compactTokenLimitScope: ["total", "body_after_prefix"].includes(requestedScope) ? requestedScope : "body_after_prefix",
  };
}

export function collectionPrompt(sourceMarkdown, userInput, preflight = null) {
  const pin = String(sourceMarkdown ?? "");
  const input = String(userInput ?? "");
  if (!pin.trim()) throw new Error("当前采集规则文件是空的，无法开始采集");
  if (!input.trim()) throw new Error("采集要求不能为空");
  const extracted = preflight || { version: 1, metadata: extractCollectionMetadata(pin, input) };
  return `${COLLECTION_MARKER}

你正在执行一个独立采集项。不要使用或假设存在此前的对话或采集结果，
也不要补充本消息未提供且无法可靠确认的信息。

请将“采集目标与处理规则”作为必须落实的工作流程，根据当前输入的数据类型选择合适的处理方式。
输入可能包含单条或批量资料、链接、项目清单、原始数据、交易记录、文章、观点、代码或其他内容，
不要强制套用固定摘要格式。

执行要求：

- 优先服从采集规则中明确规定的字段、分类、格式和输出要求。
- 尽量完整保留有价值的原始信息，尤其是名称、日期、数值、单位、代码、链接和来源。
- 批量输入应逐项处理，不要遗漏或擅自合并不同记录。
- 明确区分原始事实、用户观点、模型推断和待核实信息。
- 不编造缺失内容；无法确认的信息标记为“待补充”或“未核实”。
- 只有采集规则明确要求时才进行摘要、分析、评分或改写。
- 先检查当前工作区已有目录、记录和索引，再按照采集规则实际创建或修改工作区文件。
- 采集规则要求写入来源记录、索引、标签或其他文件时，必须完成实际写入；不得只返回建议、草稿或待写入的 Markdown。
- 不修改作为规则来源的 Markdown 文件，除非当前输入明确要求修改该规则本身。
- 完成写入后执行规则要求的检查，并复核实际文件；无法执行的步骤必须说明具体阻碍。
- 最终回答只报告实际创建或修改的文件、验证结果、尚未核验的内容和剩余风险，不要重复输出完整采集文档。

工具与上下文预算：

- 优先使用下方脚本预提取的 URL、日期、项目名候选、精确匹配和 GitHub 核验结果；它们只是检索键，不替代原始规则和当前输入。
- 本地搜索只返回精确匹配行、计数和必要的少量上下文；禁止枚举完整文件树、输出整份索引或大段无关文本。
- 单次搜索最多保留 80 条匹配或 12000 个字符，达到上限时改用更精确的路径或关键字继续。
- GitHub 仓库优先批量核验，只保留可达性、最终地址、重定向和必要状态；只有重定向、同名冲突或仓库身份不明时才读取详细页面。
- 在修改前只读取目标文件的相关区段；在修改后使用精确 URL、相对路径和必需字段做定向验证。

## 脚本预提取（仅作检索键）
${JSON.stringify(extracted, null, 2)}

## 采集目标与处理规则
${pin}

## 当前输入
${input}`;
}

function errorMessage(value, fallback = "Codex App Server 请求失败") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value?.message) return String(value.message);
  return fallback;
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    cli,
    cwd,
    requestTimeoutMs = 20_000,
    compactTokenLimit = DEFAULT_COLLECTION_COMPACT_TOKEN_LIMIT,
    compactTokenLimitScope = "body_after_prefix",
  } = {}) {
    super();
    if (!cli) throw new Error("Codex CLI 配置缺失");
    this.setMaxListeners(50);
    this.cli = cli;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.compactTokenLimit = Number.isSafeInteger(compactTokenLimit) && compactTokenLimit >= 0
      ? compactTokenLimit
      : DEFAULT_COLLECTION_COMPACT_TOKEN_LIMIT;
    this.compactTokenLimitScope = ["total", "body_after_prefix"].includes(compactTokenLimitScope)
      ? compactTokenLimitScope
      : "body_after_prefix";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.child = null;
    this.startPromise = null;
    this.stderr = "";
  }

  async start() {
    if (this.child && this.child.exitCode === null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        await this.#start();
      } catch (error) {
        const message = String(error?.message || "");
        if (this.compactTokenLimit > 0 && /(?:model_auto_compact|compact.*(?:config|unknown)|unknown.*config)/i.test(message)) {
          this.compactTokenLimit = 0;
          await this.#start();
          return;
        }
        throw error;
      }
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    const appServerArgs = ["app-server"];
    if (this.compactTokenLimit > 0) {
      appServerArgs.push(
        "-c", `model_auto_compact_token_limit=${this.compactTokenLimit}`,
        "-c", `model_auto_compact_token_limit_scope="${this.compactTokenLimitScope}"`,
      );
    }
    const child = spawnCli(this.cli, appServerArgs, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderr = "";
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receiveLine(line));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_000); });
    child.stdin.on("error", (error) => this.#fail(error));
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      const suffix = this.stderr.trim();
      this.#fail(new Error(suffix || `Codex App Server 已退出（code=${code}, signal=${signal || "none"}）`));
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "chat_pin_collection",
          title: "Chat Pin Collection",
          version: "0.1.0",
        },
      }, this.requestTimeoutMs);
      this.notify("initialized", {});
    } catch (error) {
      // An initialize timeout previously left an orphaned App Server process
      // behind. That made later attempts look permanently busy even though no
      // collection item had entered the queue.
      await this.stop().catch(() => {});
      throw error;
    }
  }

  #receiveLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (line.trim()) this.stderr = `${this.stderr}\n${line}`.slice(-16_000);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#answerServerRequest(message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #answerServerRequest(message) {
    const approval = /requestApproval$/i.test(message.method);
    if (approval && /(?:commandExecution|fileChange)/.test(message.method)) {
      this.#write({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (approval && /permissions/.test(message.method)) {
      this.#write({ id: message.id, result: { permissions: {} } });
      return;
    }
    this.#write({
      id: message.id,
      error: { code: -32601, message: `Chat Pin 采集模式不支持交互请求：${message.method}` },
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex App Server 输入流不可用");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();
    if (child) this.emit("exit", failure);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  async runFreshCollection({
    prompt,
    cwd = this.cwd,
    timeoutMs = 10 * 60 * 1000,
    sandboxMode = "workspaceWrite",
    networkAccess = true,
    model = "",
    effort = "",
    signal,
    onTurnStarted,
    onProgress,
  } = {}) {
    const runStartedAt = Date.now();
    const reportProgress = (event) => {
      if (typeof onProgress !== "function") return;
      try {
        const pending = onProgress({ at: new Date().toISOString(), ...event });
        if (pending && typeof pending.catch === "function") void pending.catch(() => {});
      } catch {
        // Terminal progress reporting must never fail a collection turn.
      }
    };
    if (signal?.aborted) throw new Error("采集任务已取消");
    await this.start();
    const appServerReadyAt = Date.now();
    reportProgress({ type: "app-server-ready", elapsedMs: appServerReadyAt - runStartedAt });
    if (signal?.aborted) throw new Error("采集任务已取消");
    const alternateSandboxType = (error, attempted) => {
      const message = String(error?.message || "");
      const expected = message.match(/expected(?: one of)?\s+([\s\S]+)/i)?.[1] || "";
      if (!/unknown variant/i.test(message)) return "";
      const alternates = {
        readOnly: "read-only",
        "read-only": "readOnly",
        workspaceWrite: "workspace-write",
        "workspace-write": "workspaceWrite",
      };
      const candidate = alternates[attempted] || "";
      if (candidate && expected.toLowerCase().includes(candidate.toLowerCase())) {
        return candidate;
      }
      return "";
    };
    const requestWithSandboxFallback = async (method, makeParams) => {
      const preferred = sandboxMode;
      try {
        return await this.request(method, makeParams(preferred));
      } catch (error) {
        const fallback = alternateSandboxType(error, preferred);
        if (!fallback) throw error;
        return this.request(method, makeParams(fallback));
      }
    };
    const modelOverrideUnavailable = (error) => /(?:(?:model|reasoning|effort).*(?:unknown|unavailable|not found|unsupported|invalid)|(?:unknown|unavailable|not found|unsupported|invalid).*(?:model|reasoning|effort))/i
      .test(String(error?.message || ""));
    let effectiveModel = String(model || "");
    let effectiveEffort = String(effort || "");
    let profileFallback = false;
    let threadResult;
    const startThread = () => requestWithSandboxFallback("thread/start", (sandbox) => ({
      cwd,
      approvalPolicy: "never",
      sandbox,
      serviceName: "chat_pin_collection",
      ...(effectiveModel ? { model: effectiveModel } : {}),
    }));
    try {
      threadResult = await startThread();
    } catch (error) {
      if (!effectiveModel || !modelOverrideUnavailable(error)) throw error;
      reportProgress({ type: "model-fallback", stage: "thread-start", error: String(error.message || error) });
      effectiveModel = "";
      effectiveEffort = "";
      profileFallback = true;
      threadResult = await startThread();
    }
    const threadStartedAt = Date.now();
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error("Codex App Server 没有返回 threadId");
    reportProgress({ type: "thread-started", threadId, elapsedMs: threadStartedAt - appServerReadyAt });

    const agentMessages = [];
    const fileChanges = [];
    let firstToolAt = 0;
    let firstWriteAt = 0;
    let compactionCount = 0;
    let legacyCompactionSeen = false;
    let latestTokenUsage = null;
    let completionResolve;
    let completionReject;
    const completion = new Promise((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    const timeout = setTimeout(() => completionReject(new Error("采集任务等待 Codex 回答超时")), timeoutMs);
    const abort = () => completionReject(new Error("采集任务已取消"));
    const onNotification = (message) => {
      const params = message.params || {};
      if (params.threadId !== threadId) return;
      if (message.method === "thread/tokenUsage/updated") latestTokenUsage = params.tokenUsage || null;
      if (message.method === "thread/compacted") legacyCompactionSeen = true;
      if (["item/started", "item/completed"].includes(message.method) && params.item) {
        const itemType = String(params.item.type || "");
        reportProgress({
          type: "item",
          event: message.method === "item/started" ? "started" : "completed",
          itemType,
          changes: itemType === "fileChange" && Array.isArray(params.item.changes)
            ? params.item.changes.map((change) => ({
              path: String(change?.path || ""),
              kind: String(change?.kind || ""),
            })).filter((change) => change.path)
            : [],
        });
        if (!firstToolAt && !["agentMessage", "reasoning", "contextCompaction"].includes(itemType)) firstToolAt = Date.now();
        if (itemType === "contextCompaction" && message.method === "item/completed") compactionCount += 1;
        if (itemType === "fileChange" && message.method === "item/completed") {
          if (!firstWriteAt) firstWriteAt = Date.now();
          if (Array.isArray(params.item.changes)) {
            fileChanges.push(...params.item.changes.map((change) => ({
              path: String(change?.path || ""),
              kind: String(change?.kind || ""),
            })).filter((change) => change.path));
          }
        }
        if (itemType === "agentMessage" && message.method === "item/completed" && String(params.item.text || "").trim()) {
          agentMessages.push(params.item);
        }
      }
      if (message.method === "error" && params.willRetry === true) {
        reportProgress({ type: "retry", error: errorMessage(params.error, "Codex 正在自动重试") });
      }
      if (message.method === "error" && params.willRetry !== true) {
        completionReject(new Error(errorMessage(params.error, "Codex 采集任务失败")));
      }
      if (message.method === "turn/completed") {
        reportProgress({ type: "turn-completed", status: params.turn?.status || params.status || "" });
        completionResolve(params.turn || params);
      }
    };
    this.on("notification", onNotification);
    let turnId = "";
    try {
      const turnParams = (sandboxType) => ({
        threadId,
        input: [{ type: "text", text: String(prompt || "") }],
        cwd,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: sandboxType,
          writableRoots: [path.resolve(cwd)],
          networkAccess: networkAccess === true,
        },
      });
      let turnResult;
      try {
        turnResult = await requestWithSandboxFallback("turn/start", turnParams);
      } catch (error) {
        if ((!effectiveModel && !effectiveEffort) || !modelOverrideUnavailable(error)) throw error;
        reportProgress({ type: "model-fallback", stage: "turn-start", error: String(error.message || error) });
        effectiveModel = "";
        effectiveEffort = "";
        profileFallback = true;
        turnResult = await requestWithSandboxFallback("turn/start", turnParams);
      }
      const turnStartedAt = Date.now();
      turnId = turnResult?.turn?.id || "";
      reportProgress({ type: "turn-started", threadId, turnId, model: effectiveModel, effort: effectiveEffort });
      signal?.addEventListener("abort", abort, { once: true });
      if (typeof onTurnStarted === "function") await onTurnStarted({ threadId, turnId });
      if (signal?.aborted) abort();
      const completedTurn = await completion;
      const status = completedTurn?.status || "";
      if (status && !["completed", "complete"].includes(status)) {
        throw new Error(errorMessage(completedTurn?.error, `Codex 采集任务状态：${status}`));
      }
      const finalItem = agentMessages.findLast((item) => item.phase === "final_answer") || agentMessages.at(-1);
      if (!finalItem) throw new Error("Codex 采集任务没有返回可保存的最终文本");
      const completedAt = Date.now();
      return {
        threadId,
        turnId,
        output: String(finalItem.text).trim(),
        fileChanges,
        executionProfile: {
          model: effectiveModel,
          effort: effectiveEffort,
          fallback: profileFallback,
        },
        metrics: {
          appServerReadyMs: appServerReadyAt - runStartedAt,
          threadStartMs: threadStartedAt - appServerReadyAt,
          turnStartMs: turnStartedAt - threadStartedAt,
          firstToolMs: firstToolAt ? firstToolAt - turnStartedAt : null,
          firstWriteMs: firstWriteAt ? firstWriteAt - turnStartedAt : null,
          cliTotalMs: completedAt - runStartedAt,
          compactionCount: Math.max(compactionCount, legacyCompactionSeen ? 1 : 0),
          tokenUsage: latestTokenUsage,
        },
      };
    } catch (error) {
      if (turnId) {
        await this.request("turn/interrupt", { threadId, turnId }, 3_000).catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.off("notification", onNotification);
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin?.end();
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}
