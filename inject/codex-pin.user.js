(() => {
  "use strict";

  const VERSION = "0.9.3"; // Collection terminal progress and heartbeat release.
  const API_KEY = "__codexChatPinInjection__";
  const STYLE_ID = "codex-chat-pin-style";
  const BUTTON_ATTRIBUTE = "data-codex-chat-pin-button";
  const OPEN_ATTRIBUTE = "data-codex-chat-pin-open";
  const REVISION_ATTRIBUTE = "data-codex-chat-pin-revision";
  const REVISION_CARD_ATTRIBUTE = "data-codex-chat-pin-revision-card";
  const COLLECTION_ATTRIBUTE = "data-codex-chat-pin-collection";
  const COLLECTION_CARD_ATTRIBUTE = "data-codex-chat-pin-collection-card";
  const COLLECTION_RESULTS_ATTRIBUTE = "data-codex-chat-pin-collection-results";
  const COLLECTION_SEND_GUARD_ATTRIBUTE = "data-codex-chat-pin-native-send-guard";
  const COLLECTION_SEND_OVERLAY_ATTRIBUTE = "data-codex-chat-pin-send-overlay";
  const HIGHLIGHT_CLASS = "codex-chat-pin-source";
  const REVISION_MARKER = "[Chat Pin 修订模式]";
  const PIN_ICON = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M648.728381 130.779429a73.142857 73.142857 0 0 1 22.674286 15.433142l191.561143 191.756191a73.142857 73.142857 0 0 1-22.137905 118.564571l-67.876572 30.061715-127.341714 127.488-10.093714 140.239238a73.142857 73.142857 0 0 1-124.684191 46.445714l-123.66019-123.782095-210.724572 211.699809-51.833904-51.614476 210.846476-211.821714-127.926857-128.024381a73.142857 73.142857 0 0 1 46.299428-124.635429l144.237715-10.776381 125.074285-125.220571 29.379048-67.779048a73.142857 73.142857 0 0 1 96.207238-38.034285z m-29.086476 67.120761l-34.913524 80.530286-154.087619 154.331429-171.398095 12.751238 303.323428 303.542857 12.044191-167.399619 156.233143-156.428191 80.384-35.59619-191.585524-191.73181z"/></svg>`;

  try {
    window[API_KEY]?.destroy?.();
  } catch {
    delete window[API_KEY];
  }

  let observer;
  let timer;
  let requestSequence = 0;
  let identity = currentSessionIdentity();
  let lastPinnedFingerprint = "";
  let lastOpenResult = null;
  const guardedNativeSendState = new WeakMap();
  const pendingSaves = new Map();
  const pendingOpens = new Set();
  const pendingRevisionRequests = new Map();
  const pendingCollectionRequests = new Map();
  const contentCache = new WeakMap();
  let revisionState = { enabled: false };
  let revisionTurn = null;
  let bypassRevisionSubmit = false;
  let revisionStatusSessionId = "";
  let revisionCleanupPending = false;
  let collectionState = { enabled: false };
  let collectionResults = [];
  let collectionResultsHidden = false;
  let collectionResultsCollapsed = false;
  const collectionResultOpenState = new Map();
  let collectionStatusSessionId = "";
  let collectionStatusPollTimer;
  let collectionSubmitting = false;

  const visible = (node) => node?.isConnected && node.getClientRects().length > 0;
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

  function hash(value) {
    let result = 2166136261;
    for (const char of String(value || "")) {
      result ^= char.charCodeAt(0);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  }

  function safeSessionId(value) {
    const raw = String(value || "").trim();
    if (/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(raw)) return raw;
    return `session_${hash(raw || "unknown")}`;
  }

  function extractSessionId(value) {
    let current = String(value || "");
    for (let pass = 0; pass < 3; pass += 1) {
      const parameter = current.match(/(?:thread|task|conversation|chat)(?:[_-]?id)?["'=:/\s]+([a-z0-9][a-z0-9_-]{7,127})/i);
      if (parameter) return safeSessionId(parameter[1]);
      const uuid = current.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
      if (uuid) return safeSessionId(uuid[0]);
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch {
        break;
      }
    }
    return "";
  }

  function idFromHistory(value, depth = 0, seen = new Set()) {
    if (!value || depth > 3 || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        const embedded = extractSessionId(child);
        if (embedded) return embedded;
        if (/(?:thread|task|conversation|chat)(?:id)?/i.test(key) && child.length >= 8) return safeSessionId(child);
      } else if (child && typeof child === "object") {
        const nested = idFromHistory(child, depth + 1, seen);
        if (nested) return nested;
      }
    }
    return "";
  }

  function idFromSelectedThreadRow() {
    const rows = document.querySelectorAll("[data-app-action-sidebar-thread-selected='true'],[data-app-action-sidebar-thread-active='true']");
    for (const row of rows) {
      const raw = row.getAttribute("data-app-action-sidebar-thread-id")
        || row.closest("[data-app-action-sidebar-thread-id]")?.getAttribute("data-app-action-sidebar-thread-id")
        || "";
      const found = extractSessionId(`threadId=${raw}`);
      if (found) return found;
    }
    return "";
  }

  function currentSessionIdentity() {
    const selected = idFromSelectedThreadRow();
    if (selected) return { id: selected, reliable: true };
    const historyId = idFromHistory(history.state);
    if (historyId) return { id: historyId, reliable: true };
    const sources = [location.href];
    const currentLink = [...document.querySelectorAll("a[aria-current='page'],a[aria-current='true'],a[data-state='active']")]
      .find((node) => node.getAttribute("href"));
    if (currentLink) sources.unshift(currentLink.getAttribute("href"));
    for (const source of sources) {
      const found = extractSessionId(source);
      if (found) return { id: found, reliable: true };
    }
    const basis = `${currentLink?.getAttribute("href") || ""}|${location.pathname}|${location.search}|${location.hash}`;
    return { id: `route_${hash(basis || location.origin)}`, reliable: false };
  }

  function fileName(sessionId = identity.id) {
    return `pin_${safeSessionId(sessionId)}.md`;
  }

  function updateIdentity() {
    const previousId = identity.id;
    const next = currentSessionIdentity();
    if (next.reliable || !identity.reliable) identity = next;
    if (identity.id !== previousId) {
      revisionState = { enabled: false };
      revisionTurn = null;
      revisionStatusSessionId = "";
      collectionState = { enabled: false };
      collectionResults = [];
      collectionResultsHidden = false;
      collectionResultsCollapsed = false;
      collectionResultOpenState.clear();
      collectionStatusSessionId = "";
      clearTimeout(collectionStatusPollTimer);
      collectionStatusPollTimer = undefined;
    }
    return identity;
  }

  function hostRequest(message) {
    if (typeof window.__codexChatPinPersist !== "function") return false;
    window.__codexChatPinPersist(JSON.stringify(message));
    return true;
  }

  function requestRevision(action, payload = {}, timeoutMs = 8000) {
    updateIdentity();
    const requestId = `revision-${action}-${Date.now()}-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRevisionRequests.delete(requestId);
        reject(new Error("Pin 启动器没有响应修订请求"));
      }, timeoutMs);
      pendingRevisionRequests.set(requestId, { action, resolve, reject, timeout });
      if (!hostRequest({
        type: `revision-${action}`,
        requestId,
        sessionId: identity.id,
        ...payload,
      })) {
        clearTimeout(timeout);
        pendingRevisionRequests.delete(requestId);
        reject(new Error("Pin 启动器未连接"));
      }
    });
  }

  function requestCollection(action, payload = {}, timeoutMs = 12_000) {
    updateIdentity();
    const requestId = `collection-${action}-${Date.now()}-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCollectionRequests.delete(requestId);
        reject(new Error("Pin 启动器没有响应采集请求"));
      }, timeoutMs);
      pendingCollectionRequests.set(requestId, { action, resolve, reject, timeout });
      if (!hostRequest({
        type: `collection-${action}`,
        requestId,
        sessionId: identity.id,
        ...payload,
      })) {
        clearTimeout(timeout);
        pendingCollectionRequests.delete(requestId);
        reject(new Error("Pin 启动器未连接"));
      }
    });
  }

  function applyRevisionState(value) {
    const next = value?.enabled === true && value.sessionId === identity.id
      ? value
      : { enabled: false };
    revisionState = next;
    if (!next.enabled) revisionTurn = null;
    schedule();
    return next;
  }

  function applyCollectionState(value) {
    if (Array.isArray(value?.results)) {
      collectionResults = value.results;
      const retained = new Set(collectionResults.map((item) => String(item?.id || "")));
      for (const id of collectionResultOpenState.keys()) {
        if (!retained.has(id)) collectionResultOpenState.delete(id);
      }
      if (collectionResults.length === 0) collectionResultsCollapsed = false;
    }
    const next = value?.enabled === true && value.sessionId === identity.id
      ? value
      : { enabled: false, ...(value?.counts ? {
        counts: value.counts,
        pendingCount: value.pendingCount,
        resultPath: value.resultPath,
        protocolVersion: value.protocolVersion,
        capabilities: value.capabilities,
      } : {}) };
    collectionState = next;
    guardNativeCollectionSend();
    scheduleCollectionStatusPoll();
    schedule();
    return next;
  }

  function scheduleCollectionStatusPoll(delayMs = 2_000) {
    clearTimeout(collectionStatusPollTimer);
    collectionStatusPollTimer = undefined;
    if (!collectionState.enabled || Number(collectionState.pendingCount || 0) <= 0) return;
    const sessionId = identity.id;
    collectionStatusPollTimer = setTimeout(() => {
      collectionStatusPollTimer = undefined;
      updateIdentity();
      if (identity.id !== sessionId || !collectionState.enabled || Number(collectionState.pendingCount || 0) <= 0) return;
      // Runtime events are the fast path. Polling is a bounded reconciliation
      // path for renderer reloads or missed CDP events so "running" cannot
      // remain stuck after the queue has already completed or been cleared.
      collectionStatusSessionId = "";
      void syncCollectionStatus();
    }, delayMs);
  }

  function collectionSupports(capability) {
    return Array.isArray(collectionState.capabilities) && collectionState.capabilities.includes(capability);
  }

  async function syncRevisionStatus() {
    updateIdentity();
    if (revisionStatusSessionId === identity.id) return;
    revisionStatusSessionId = identity.id;
    try {
      const message = await requestRevision("status");
      applyRevisionState(message.state);
    } catch (error) {
      revisionStatusSessionId = "";
      revisionState = { enabled: false };
    }
  }

  async function syncCollectionStatus() {
    updateIdentity();
    if (collectionStatusSessionId === identity.id) return;
    collectionStatusSessionId = identity.id;
    try {
      const message = await requestCollection("status");
      applyCollectionState(message.state);
    } catch {
      collectionStatusSessionId = "";
      // Preserve an already-active local mode while the launcher connection is
      // briefly unavailable. Disabling it here would release the native send
      // guard and could route one input to the Desktop conversation.
      if (!collectionState.enabled) collectionState = { enabled: false };
      scheduleCollectionStatusPoll();
    }
  }

  function style() {
    if (document.getElementById(STYLE_ID)) return;
    const node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = `
      [${BUTTON_ATTRIBUTE}="true"]{display:inline-flex!important;align-items:center;justify-content:center;min-width:32px!important;min-height:32px!important;padding:5px!important}
      [${BUTTON_ATTRIBUTE}="true"] svg{width:16px;height:16px;fill:currentColor}
      [${OPEN_ATTRIBUTE}="true"] svg{width:18px;height:18px;fill:currentColor}
      [${REVISION_ATTRIBUTE}="true"][aria-pressed="true"]{color:#8fb3ff!important;background:#6798ff20!important}
      [${REVISION_ATTRIBUTE}="true"]{white-space:nowrap}
      [${COLLECTION_ATTRIBUTE}="true"][aria-pressed="true"]{color:#9aebca!important;background:#287a5b55!important;box-shadow:inset 0 0 0 1px #65d6a688!important;font-weight:650!important}
      [${COLLECTION_ATTRIBUTE}="true"][aria-pressed="true"]::before{content:"●";color:#65d6a6;font-size:9px;margin-right:6px}
      [${COLLECTION_ATTRIBUTE}="true"]{white-space:nowrap}
      [${COLLECTION_SEND_GUARD_ATTRIBUTE}="true"]{pointer-events:none!important;opacity:1!important}
      [${COLLECTION_SEND_OVERLAY_ATTRIBUTE}="true"]{position:fixed!important;z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;border-radius:999px!important;background:transparent!important;color:transparent!important;cursor:pointer!important}
      [${COLLECTION_SEND_OVERLAY_ATTRIBUTE}="true"]:focus-visible{outline:2px solid #65d6a6!important;outline-offset:2px!important}
      .${HIGHLIGHT_CLASS}{outline:1px solid #6798ff88;outline-offset:4px;border-radius:7px}
      [${REVISION_CARD_ATTRIBUTE}="true"]{display:flex;align-items:center;gap:8px;margin:0 10px 8px;padding:7px 10px;border:1px solid #6798ff55;border-radius:8px;background:#6798ff14;color:inherit;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      [${REVISION_CARD_ATTRIBUTE}="true"] .codex-chat-pin-revision-label{font-weight:600;color:#9fbdff}
      [${REVISION_CARD_ATTRIBUTE}="true"] .codex-chat-pin-revision-file{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      [${REVISION_CARD_ATTRIBUTE}="true"] button{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;padding:2px 5px;border-radius:4px}
      [${REVISION_CARD_ATTRIBUTE}="true"] button:hover{background:#ffffff14}
      [${COLLECTION_CARD_ATTRIBUTE}="true"]{display:flex;align-items:center;gap:8px;margin:0 10px 8px;padding:7px 10px;border:1px solid #49b98955;border-radius:8px;background:#49b98914;color:inherit;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] .codex-chat-pin-collection-label{font-weight:600;color:#8be0bd}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] .codex-chat-pin-collection-file{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] .codex-chat-pin-collection-error{color:#ff9c94;white-space:nowrap}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] .codex-chat-pin-collection-actions{margin-left:auto;display:flex;align-items:center;gap:3px;white-space:nowrap}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] button{border:0;background:transparent;color:inherit;cursor:pointer;padding:2px 5px;border-radius:4px}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] button:hover{background:#ffffff14}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] button:disabled{opacity:.4;cursor:default;background:transparent}
      [${COLLECTION_CARD_ATTRIBUTE}="true"] [data-collection-action="retry"]{color:#ffb0aa}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"]{margin:0 10px 8px;padding:10px;border:1px solid #49b98945;border-radius:10px;background:#1f312aee;color:inherit;font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;max-height:42vh;overflow:auto}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] .codex-chat-pin-results-header{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-weight:650;color:#8be0bd}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] .codex-chat-pin-results-actions{margin-left:auto;display:flex;align-items:center;gap:3px;white-space:nowrap}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] details{border-top:1px solid #ffffff12;padding:6px 0}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] summary{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] .codex-chat-pin-results-files{margin:6px 0;color:#b9d9ca;white-space:pre-wrap;overflow-wrap:anywhere}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] pre{margin:7px 0 3px;padding:9px;border-radius:7px;background:#00000028;white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] button{border:0;background:transparent;color:inherit;cursor:pointer;padding:2px 5px;border-radius:4px}
      [${COLLECTION_RESULTS_ATTRIBUTE}="true"] button:hover{background:#ffffff14}
      [data-codex-chat-pin-submitting="true"] [data-codex-composer="true"][contenteditable="true"],
      [data-codex-chat-pin-submitting="true"] [contenteditable="true"][role="textbox"],
      [data-codex-chat-pin-submitting="true"] textarea{opacity:0!important;caret-color:transparent!important}
      .codex-chat-pin-toast{position:fixed;z-index:2147483647;right:18px;bottom:18px;max-width:380px;padding:10px 12px;border:1px solid #ffffff24;border-radius:8px;background:#262626;color:#f2f2f2;box-shadow:0 8px 30px #0008;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      .codex-chat-pin-toast[data-kind="error"]{border-color:#d96b6255;background:#402726;color:#ffd7d3}
    `;
    document.head.appendChild(node);
  }

  function toast(text, kind = "info") {
    document.querySelector(".codex-chat-pin-toast")?.remove();
    const node = document.createElement("div");
    node.className = "codex-chat-pin-toast";
    node.dataset.kind = kind;
    node.setAttribute("role", kind === "error" ? "alert" : "status");
    node.textContent = text;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), kind === "error" ? 8000 : 3000);
  }

  function footers() {
    const result = new Set();
    for (const copy of [...document.querySelectorAll("button")]) {
      const label = norm(`${copy.getAttribute("aria-label")} ${copy.title}`);
      if (label !== "复制" && label !== "copy") continue;
      if (!copy.closest("[data-local-conversation-final-assistant='true']")) continue;
      let candidate = null;
      for (let parent = copy.parentElement, depth = 0; parent && depth < 7; parent = parent.parentElement, depth += 1) {
        const buttons = [...parent.querySelectorAll("button")].filter(visible);
        const rect = parent.getBoundingClientRect();
        if (visible(parent) && buttons.length >= 1 && buttons.length <= 8 && rect.height >= 20 && rect.height <= 44 && rect.width <= 520) candidate = parent;
        else if (candidate && rect.height > 44) break;
      }
      if (candidate) result.add(candidate);
    }
    return [...result];
  }

  function messageFor(footer, bars) {
    const annotated = footer.closest("[data-response-annotation-target]");
    if (annotated) return annotated;
    const assistant = footer.closest("[data-local-conversation-final-assistant='true']");
    if (assistant) return assistant;
    let fallback;
    for (let parent = footer.parentElement, depth = 0; parent && parent !== document.body && depth < 12; parent = parent.parentElement, depth += 1) {
      const value = (parent.innerText || "").trim();
      if (value.length < 8) continue;
      if (!fallback && bars.filter((bar) => parent.contains(bar)).length === 1) fallback = parent;
      if (parent.matches("[data-message-author-role],[data-testid*='message'],article")) return parent;
      if (fallback && parent.querySelectorAll("[data-message-author-role],[data-testid*='message'],article").length > 1) break;
    }
    return fallback;
  }

  function pairs() {
    const bars = footers();
    return bars.map((footer) => ({ footer, message: messageFor(footer, bars) })).filter((pair) => pair.message);
  }

  function safeUrl(value) {
    const url = String(value || "").trim();
    return /^(https?:|data:image\/|app:|blob:|#|\/)/i.test(url) ? url : "";
  }

  function markdownTable(table) {
    const rows = [...table.querySelectorAll("tr")].map((row) => [...row.children]
      .filter((cell) => cell.matches("th,td"))
      .map((cell) => markdownFrom(cell).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()));
    if (!rows.length || !rows[0].length) return (table.innerText || "").trim();
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    const header = normalized[0];
    return [header, header.map(() => "---"), ...normalized.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n");
  }

  function normalizedCodeLanguage(...values) {
    const aliases = new Map([
      ["py", "python"],
      ["python", "python"],
      ["js", "javascript"],
      ["javascript", "javascript"],
      ["jsx", "jsx"],
      ["ts", "typescript"],
      ["typescript", "typescript"],
      ["tsx", "tsx"],
      ["sh", "bash"],
      ["shell", "bash"],
      ["bash", "bash"],
      ["powershell", "powershell"],
      ["ps1", "powershell"],
      ["纯文本", ""],
      ["纯文字", ""],
      ["plaintext", ""],
      ["plain text", ""],
      ["text", ""],
      ["text/plain", ""],
    ]);
    for (const value of values) {
      let candidate = String(value || "").replace(/复制(?:代码)?|copy(?: code)?/gi, "").trim().toLowerCase();
      if (!candidate) continue;
      const classLanguage = candidate.match(/(?:^|\s)language-([\w.+#-]+)/)?.[1];
      if (classLanguage) candidate = classLanguage;
      if (aliases.has(candidate)) return aliases.get(candidate);
      if (/^[a-z0-9][\w.+#-]{0,23}$/i.test(candidate)) return candidate;
    }
    return "";
  }

  function codeLanguage(code, fallback = "") {
    const owner = code.closest?.("[data-language],[data-lang],[data-code-language]");
    return normalizedCodeLanguage(
      code.getAttribute?.("data-codex-pin-language"),
      code.getAttribute?.("data-language"),
      code.getAttribute?.("data-lang"),
      code.getAttribute?.("data-code-language"),
      code.className,
      owner?.getAttribute?.("data-language"),
      owner?.getAttribute?.("data-lang"),
      owner?.getAttribute?.("data-code-language"),
      fallback,
    );
  }

  function fencedCode(value, language = "") {
    const code = String(value || "").replace(/^\n|\n$/g, "");
    const longestTicks = Math.max(0, ...(code.match(/`+/g) || []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestTicks + 1));
    return `\n${fence}${language}\n${code}\n${fence}\n\n`;
  }

  function prepareCodeBlocks(rootNode) {
    for (const code of rootNode.querySelectorAll("code")) {
      const value = code.textContent || "";
      let copyButton = null;
      let blockContainer = null;
      for (let parent = code.parentElement, depth = 0; parent && parent !== rootNode.parentElement && depth < 7; parent = parent.parentElement, depth += 1) {
        if (parent === rootNode || parent.matches?.("[data-message-content],[data-response-annotation-target],[data-local-conversation-final-assistant='true']")) break;
        const parentText = parent.textContent || "";
        const surroundingText = parentText.includes(value) ? parentText.replace(value, "").trim() : parentText.trim();
        const candidate = [...parent.querySelectorAll("button")].find((button) => {
          const label = [button.textContent, button.title, button.getAttribute("aria-label")].filter(Boolean).join(" ");
          const specificallyCode = /复制代码|copy code/i.test(label);
          const genericCopy = /^(?:复制|copy)$/i.test(label.trim());
          return specificallyCode || (genericCopy && surroundingText.length <= 60);
        });
        if (candidate) {
          copyButton = candidate;
          blockContainer = parent;
          break;
        }
        if (parent.tagName === "PRE") blockContainer ||= parent;
      }
      const isBlock = Boolean(code.closest("pre") || copyButton || value.includes("\n"));
      if (!isBlock) continue;

      const chromeText = copyButton && blockContainer
        ? (blockContainer.innerText || blockContainer.textContent || "").replace(value, "")
        : "";
      code.setAttribute("data-codex-pin-block", "true");
      code.setAttribute("data-codex-pin-language", codeLanguage(code, chromeText));

      if (copyButton) {
        let chrome = copyButton;
        for (let parent = copyButton.parentElement; parent && parent !== blockContainer; parent = parent.parentElement) {
          if (parent.contains(code)) break;
          chrome = parent;
        }
        if (chrome !== blockContainer && !chrome.contains(code)) chrome.remove();
        else copyButton.remove();
      }
    }
  }

  function markdownFrom(node) {
    const walkChildren = (parent) => [...parent.childNodes].map(walk).join("");
    const walk = (current) => {
      if (current.nodeType === Node.TEXT_NODE) return (current.nodeValue || "").replace(/\u00a0/g, " ");
      if (current.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = current.tagName;
      if (tag === "BR") return "\n";
      if (tag === "PRE") {
        const codeNode = current.querySelector("code");
        return fencedCode(codeNode?.textContent ?? current.textContent ?? "", codeNode ? codeLanguage(codeNode) : "");
      }
      if (tag === "CODE") {
        const value = current.textContent || "";
        if (current.getAttribute("data-codex-pin-block") === "true" || value.includes("\n")) {
          return fencedCode(value, codeLanguage(current));
        }
        const longestTicks = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
        const fence = "`".repeat(longestTicks + 1);
        return `${fence}${value}${fence}`;
      }
      if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${walkChildren(current).trim()}\n\n`;
      if (["P", "DIV", "SECTION", "ARTICLE", "FIGURE", "FIGCAPTION"].includes(tag)) return `${walkChildren(current).trim()}\n\n`;
      if (tag === "STRONG" || tag === "B") return `**${walkChildren(current)}**`;
      if (tag === "EM" || tag === "I") return `*${walkChildren(current)}*`;
      if (tag === "DEL" || tag === "S") return `~~${walkChildren(current)}~~`;
      if (tag === "BLOCKQUOTE") return `${walkChildren(current).trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      if (tag === "UL" || tag === "OL") return `${[...current.children].filter((child) => child.tagName === "LI").map((child, index) => `${tag === "OL" ? `${index + 1}.` : "-"} ${walkChildren(child).trim()}`).join("\n")}\n\n`;
      if (tag === "A") {
        const label = walkChildren(current).trim() || current.getAttribute("href") || "";
        const href = safeUrl(current.getAttribute("href"));
        return href ? `[${label}](${href})` : label;
      }
      if (tag === "IMG") {
        const src = safeUrl(current.getAttribute("src"));
        return src ? `![${current.getAttribute("alt") || "图片"}](${src})` : "";
      }
      if (tag === "HR") return "\n---\n\n";
      if (tag === "TABLE") return `\n${markdownTable(current)}\n\n`;
      return walkChildren(current);
    };
    return walk(node).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function content(messageNode) {
    const raw = messageNode.innerText || "";
    const cached = contentCache.get(messageNode);
    if (cached?.raw === raw) return cached.value;
    const clone = messageNode.cloneNode(true);
    prepareCodeBlocks(clone);
    clone.querySelectorAll(".sr-only,[data-assistant-message-sent-time]").forEach((node) => node.remove());
    clone.querySelectorAll(`button,input,textarea,script,style,[${BUTTON_ATTRIBUTE}]`).forEach((node) => node.remove());
    const specific = [...clone.querySelectorAll("[data-message-content]")]
      .map((node) => ({ node, plain: (node.innerText || "").trim() }))
      .filter((item) => item.plain.length >= 8)
      .sort((a, b) => b.plain.length - a.plain.length);
    const option = specific[0] || { node: clone, plain: (clone.innerText || "").trim() };
    const text = markdownFrom(option.node) || option.plain;
    if (!text) return null;
    const value = { text: `${text.trim()}\n`, fingerprint: hash(text) };
    contentCache.set(messageNode, { raw, value });
    return value;
  }

  async function pin(pair, button) {
    updateIdentity();
    if (revisionState.enabled && revisionState.sessionId === identity.id) {
      const confirmed = window.confirm("当前 Pin 正在修订。继续会用这条回复替换 Pin 文件并退出修订模式，是否继续？");
      if (!confirmed) return;
      try {
        const message = await requestRevision("disable");
        applyRevisionState(message.state);
      } catch (error) {
        toast(`无法安全退出修订模式：${error.message}`, "error");
        return;
      }
    }
    const value = content(pair.message);
    if (!value) {
      toast("没有识别到可保存的助手回复。", "error");
      return;
    }
    const requestId = `save-${Date.now()}-${++requestSequence}`;
    pendingSaves.set(requestId, { button, fingerprint: value.fingerprint, sessionId: identity.id });
    button.disabled = true;
    button.setAttribute("aria-label", "正在保存并打开 Markdown");
    const accepted = hostRequest({ type: "document", requestId, sessionId: identity.id, text: value.text, openAfterSave: true });
    if (!accepted) {
      pendingSaves.delete(requestId);
      button.disabled = false;
      button.setAttribute("aria-label", "保存为 Markdown 并打开");
      toast("Pin 启动器未连接，无法保存 Markdown。", "error");
    }
  }

  function addPin(pair) {
    if (pair.footer.querySelector(`[${BUTTON_ATTRIBUTE}="true"]`)) return;
    const reference = [...pair.footer.querySelectorAll("button")].filter(visible).at(-1);
    if (!reference) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = reference.className;
    button.setAttribute(BUTTON_ATTRIBUTE, "true");
    button.setAttribute("aria-label", "保存为 Markdown 并打开");
    button.title = "保存为 Markdown 并打开";
    button.innerHTML = PIN_ICON;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      pin(pair, button);
    });
    pair.footer.appendChild(button);
  }

  function openPinFile(fileMenuPoint = null) {
    updateIdentity();
    const requestId = `open-${Date.now()}-${++requestSequence}`;
    pendingOpens.add(requestId);
    if (!hostRequest({ type: "open", requestId, sessionId: identity.id, fileMenuPoint })) {
      pendingOpens.delete(requestId);
      toast("Pin 启动器未连接，无法打开 Markdown。", "error");
    }
  }

  function menuTerminalItems() {
    return [...document.querySelectorAll('[role="menuitem"],button')].filter((node) => {
      if (!visible(node) || node.hasAttribute(OPEN_ATTRIBUTE)) return false;
      const text = norm(node.textContent);
      if (!/^(终端|terminal)/i.test(text)) return false;
      const container = node.closest('ul,[role="menu"]') || node.parentElement;
      if (!container) return false;
      const siblingText = norm(container.textContent);
      return /(文件|file)/i.test(siblingText) && /(浏览器|browser)/i.test(siblingText);
    });
  }

  function nativeFileMenuPoint(preferredContainer = null) {
    const containers = preferredContainer
      ? [preferredContainer]
      : menuTerminalItems().map((terminal) => terminal.closest('ul,[role="menu"]') || terminal.parentElement).filter(Boolean);
    for (const container of [...new Set(containers)]) {
      const fileEntry = [...container.querySelectorAll('button,[role="menuitem"]')]
        .find((node) => visible(node) && /^(文件|file)/i.test(norm(node.textContent)));
      const rect = fileEntry?.getBoundingClientRect();
      if (rect?.width > 0 && rect?.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }

  function addOpenPinEntries() {
    for (const terminal of menuTerminalItems()) {
      const container = terminal.closest('ul,[role="menu"]') || terminal.parentElement;
      if (!container || container.querySelector(`[${OPEN_ATTRIBUTE}="true"]`)) continue;
      const row = terminal.closest('li,[role="menuitem"]') || terminal;
      const item = row.cloneNode(true);
      item.removeAttribute("id");
      item.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      item.setAttribute(OPEN_ATTRIBUTE, "true");
      const interactive = item.matches('button,[role="menuitem"]') ? item : item.querySelector('button,[role="menuitem"]') || item;
      interactive.setAttribute("aria-label", "打开 Pin 文件");
      interactive.title = "打开当前任务的 Pin Markdown 文件";

      const leaves = [...item.querySelectorAll("*")].filter((node) => node.children.length === 0 && norm(node.textContent));
      const label = leaves.find((node) => /^(终端|terminal)$/i.test(norm(node.textContent)));
      if (label) label.textContent = "打开 Pin 文件";
      else interactive.append(document.createTextNode("打开 Pin 文件"));
      for (const shortcut of leaves.filter((node) => /^ctrl\s*\+/i.test(norm(node.textContent)))) shortcut.textContent = "";
      const icon = item.querySelector("svg");
      if (icon) icon.outerHTML = PIN_ICON;

      interactive.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPinFile(nativeFileMenuPoint(container));
      });
      row.insertAdjacentElement("afterend", item);
    }
  }

  function activeNativeMarkdownFile() {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((candidate) => {
      if (!visible(candidate)) return false;
      return candidate.getAttribute("aria-selected") === "true"
        || candidate.getAttribute("data-state") === "active"
        || candidate.matches("[data-selected='true']");
    });
    if (!tab) return null;
    const labels = [tab.textContent, tab.getAttribute("aria-label"), tab.title].filter(Boolean);
    for (const label of labels) {
      const match = String(label).match(/([^\\/:*?"<>|\r\n]+\.md)\b/i);
      if (match) return { tab, fileName: match[1].trim() };
    }
    return null;
  }

  function sourceCodeButtons() {
    if (!activeNativeMarkdownFile()) return [];
    return [...document.querySelectorAll("button,a")].filter((node) => {
      if (!visible(node) || node.hasAttribute(REVISION_ATTRIBUTE) || node.hasAttribute(COLLECTION_ATTRIBUTE)) return false;
      const labels = [node.textContent, node.getAttribute("aria-label"), node.title].map(norm).filter(Boolean);
      return labels.some((label) => /^(查看源代码|view source(?: code)?)$/.test(label));
    });
  }

  async function toggleRevision(button) {
    button.disabled = true;
    try {
      if (!revisionState.enabled && collectionState.enabled) {
        const confirmed = window.confirm("采集模式正在运行。切换到修订模式会停止接收新的采集请求，是否继续？");
        if (!confirmed) return;
        const collectionMessage = await requestCollection("disable");
        applyCollectionState(collectionMessage.state);
      }
      const action = revisionState.enabled ? "disable" : "enable";
      const message = await requestRevision(action);
      applyRevisionState(message.state);
      revisionStatusSessionId = identity.id;
      toast(message.state?.enabled
        ? `已启用修订：${message.state.relativePath}`
        : "已关闭修订模式");
    } catch (error) {
      toast(`修订模式切换失败：${error.message}`, "error");
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function toggleCollection(button, sourceFileName) {
    button.disabled = true;
    try {
      const wasEnabled = collectionState.enabled;
      const sameSource = wasEnabled
        && norm(collectionState.fileName) === norm(sourceFileName);
      if (!sameSource && !collectionSupports("workspace-write")) {
        const statusMessage = await requestCollection("status", {}, 12_000);
        applyCollectionState(statusMessage.state);
        if (!collectionSupports("workspace-write")) {
          throw new Error("启动器仍是旧版只读采集，请完全关闭 ChatGPT_Pin.cmd 和专用 Codex 后重新启动");
        }
      }
      if (!wasEnabled && revisionState.enabled) {
        const confirmed = window.confirm("修订模式正在运行。切换到采集模式会先关闭修订模式，是否继续？");
        if (!confirmed) return;
        const revisionMessage = await requestRevision("disable");
        applyRevisionState(revisionMessage.state);
      }
      const action = sameSource ? "disable" : "enable";
      const message = await requestCollection(action, action === "enable" ? { sourceFileName } : {}, 20_000);
      applyCollectionState(message.state);
      collectionStatusSessionId = identity.id;
      toast(message.state?.enabled
        ? `${wasEnabled && !sameSource ? "已切换采集" : "已启用采集"}：${message.state.fileName}`
        : "已关闭采集模式");
    } catch (error) {
      toast(`采集模式切换失败：${error.message}`, "error");
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function addModeButtons() {
    const sources = sourceCodeButtons();
    const activeFile = activeNativeMarkdownFile();
    const activeFileName = activeFile?.fileName || "";
    const pinFileActive = norm(activeFileName) === norm(fileName());
    const validRevision = new Set();
    const validCollection = new Set();
    for (const source of sources) {
      const container = source.parentElement;
      if (!container) continue;
      let revisionButton = container.querySelector(`:scope > [${REVISION_ATTRIBUTE}="true"]`);
      if (pinFileActive && !revisionButton) {
        revisionButton = source.cloneNode(true);
        revisionButton.removeAttribute("id");
        revisionButton.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        revisionButton.setAttribute(REVISION_ATTRIBUTE, "true");
        revisionButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void toggleRevision(revisionButton);
        });
        source.insertAdjacentElement("beforebegin", revisionButton);
      }
      if (!pinFileActive && revisionButton) {
        revisionButton.remove();
        revisionButton = null;
      }
      if (revisionButton) {
        const revisionEnabled = revisionState.enabled && revisionState.sessionId === identity.id;
        revisionButton.textContent = revisionEnabled ? "修订中" : "修订";
        revisionButton.setAttribute("aria-label", revisionEnabled ? "关闭 Pin 文件修订模式" : "启用 Pin 文件修订模式");
        revisionButton.setAttribute("aria-pressed", String(revisionEnabled));
        revisionButton.title = revisionEnabled ? "关闭修订模式" : "后续消息将直接修改当前 Pin 文件";
        validRevision.add(revisionButton);
      }

      let collectionButton = container.querySelector(`:scope > [${COLLECTION_ATTRIBUTE}="true"]`);
      if (!collectionButton) {
        collectionButton = source.cloneNode(true);
        collectionButton.removeAttribute("id");
        collectionButton.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        collectionButton.setAttribute(COLLECTION_ATTRIBUTE, "true");
        collectionButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void toggleCollection(collectionButton, collectionButton.dataset.codexCollectionSourceFile || "");
        });
        (revisionButton || source).insertAdjacentElement("beforebegin", collectionButton);
      }
      collectionButton.dataset.codexCollectionSourceFile = activeFileName;
      const collectionEnabled = collectionState.enabled
        && collectionState.sessionId === identity.id
        && norm(collectionState.fileName) === norm(activeFileName);
      collectionButton.textContent = collectionEnabled ? "采集中" : "采集";
      collectionButton.setAttribute("aria-label", collectionEnabled ? "关闭文件采集模式" : "将当前文件用作采集规则");
      collectionButton.setAttribute("aria-pressed", String(collectionEnabled));
      collectionButton.title = collectionEnabled ? "关闭采集模式" : `以 ${activeFileName} 为规则，将后续输入作为独立任务落实到当前工作区`;
      validCollection.add(collectionButton);
    }
    document.querySelectorAll(`[${REVISION_ATTRIBUTE}="true"]`).forEach((button) => {
      if (!validRevision.has(button)) button.remove();
    });
    document.querySelectorAll(`[${COLLECTION_ATTRIBUTE}="true"]`).forEach((button) => {
      if (!validCollection.has(button)) button.remove();
    });
  }

  function threadComposerRoot() {
    return [...document.querySelectorAll('[data-codex-composer-root][data-composer-placement="thread"]')]
      .find(visible) || null;
  }

  function composerEditor(rootNode = threadComposerRoot()) {
    return [...(rootNode?.querySelectorAll(
      '[data-codex-composer="true"][contenteditable="true"],[contenteditable="true"][role="textbox"],textarea',
    ) || [])].find(visible) || null;
  }

  function composerValue(editor) {
    if (!editor) return "";
    return editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || "";
  }

  function dispatchComposerInput(editor, text) {
    try {
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null,
      }));
    } catch {
      editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
  }

  function replaceComposerValueImmediately(editor, text) {
    if (!editor?.isConnected) return false;
    const next = String(text || "");
    try {
      editor.focus();
      if (editor instanceof HTMLTextAreaElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        if (descriptor?.set) descriptor.set.call(editor, next);
        else editor.value = next;
        dispatchComposerInput(editor, next);
      } else {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        const changed = document.execCommand(next ? "insertText" : "delete", false, next);
        if (!changed || composerValue(editor).trim() !== next.trim()) {
          editor.textContent = next;
          dispatchComposerInput(editor, next);
        }
      }
      return composerValue(editor).trim() === next.trim();
    } catch {
      return false;
    }
  }

  function addRevisionCard() {
    const enabled = revisionState.enabled && revisionState.sessionId === identity.id;
    const rootNode = enabled ? threadComposerRoot() : null;
    const existingCards = [...document.querySelectorAll(`[${REVISION_CARD_ATTRIBUTE}="true"]`)];
    if (!rootNode) {
      existingCards.forEach((node) => node.remove());
      return;
    }
    let card = existingCards.find((node) => rootNode.contains(node));
    existingCards.filter((node) => node !== card).forEach((node) => node.remove());
    if (!card) {
      card = document.createElement("div");
      card.setAttribute(REVISION_CARD_ATTRIBUTE, "true");
      card.innerHTML = '<span class="codex-chat-pin-revision-label">修订中</span><span class="codex-chat-pin-revision-file"></span><button type="button" aria-label="退出修订模式">退出</button>';
      card.querySelector("button").addEventListener("click", async () => {
        try {
          const message = await requestRevision("disable");
          applyRevisionState(message.state);
          toast("已关闭修订模式");
        } catch (error) {
          toast(`关闭修订模式失败：${error.message}`, "error");
        }
      });
      const editor = composerEditor(rootNode);
      let anchor = editor;
      while (anchor?.parentElement && anchor.parentElement !== rootNode) anchor = anchor.parentElement;
      if (anchor?.parentElement === rootNode) rootNode.insertBefore(card, anchor);
      else rootNode.prepend(card);
    }
    card.querySelector(".codex-chat-pin-revision-file").textContent = revisionState.relativePath;
    card.title = `下一条消息将直接修改 ${revisionState.relativePath}`;
  }

  function addCollectionCard() {
    const enabled = collectionState.enabled && collectionState.sessionId === identity.id;
    const rootNode = enabled ? threadComposerRoot() : null;
    const existingCards = [...document.querySelectorAll(`[${COLLECTION_CARD_ATTRIBUTE}="true"]`)];
    if (!rootNode) {
      existingCards.forEach((node) => node.remove());
      return;
    }
    let card = existingCards.find((node) => rootNode.contains(node));
    existingCards.filter((node) => node !== card).forEach((node) => node.remove());
    if (!card) {
      card = document.createElement("div");
      card.setAttribute(COLLECTION_CARD_ATTRIBUTE, "true");
      card.innerHTML = '<span class="codex-chat-pin-collection-label">采集中</span><span class="codex-chat-pin-collection-file"></span><span class="codex-chat-pin-collection-error"></span><span class="codex-chat-pin-collection-actions"><button type="button" data-collection-action="retry" aria-label="重试失败的采集项" hidden>重试</button><button type="button" data-collection-action="clear" aria-label="清空采集队列">清空</button><button type="button" data-collection-action="exit" aria-label="退出采集模式">退出</button></span>';
      card.querySelector('[data-collection-action="retry"]').addEventListener("click", async () => {
        try {
          const message = await requestCollection("retry");
          applyCollectionState(message.state);
          const count = Number(message.state?.retriedCount || 0);
          toast(count ? `已重新排队 ${count} 项失败任务` : "没有需要重试的失败任务");
        } catch (error) {
          toast(`重试采集失败：${error.message}`, "error");
        }
      });
      card.querySelector('[data-collection-action="clear"]').addEventListener("click", async () => {
        try {
          const message = await requestCollection("clear");
          applyCollectionState(message.state);
          const count = Number(message.state?.clearedCount || 0);
          toast(count ? `已清空 ${count} 项采集记录` : "采集队列已经为空");
        } catch (error) {
          toast(`清空采集队列失败：${error.message}`, "error");
        }
      });
      card.querySelector('[data-collection-action="exit"]').addEventListener("click", async () => {
        try {
          const message = await requestCollection("disable");
          applyCollectionState(message.state);
          toast("已关闭采集模式；已入队任务会继续完成");
        } catch (error) {
          toast(`关闭采集模式失败：${error.message}`, "error");
        }
      });
      const editor = composerEditor(rootNode);
      let anchor = editor;
      while (anchor?.parentElement && anchor.parentElement !== rootNode) anchor = anchor.parentElement;
      if (anchor?.parentElement === rootNode) rootNode.insertBefore(card, anchor);
      else rootNode.prepend(card);
    }
    const pending = Number(collectionState.pendingCount || 0);
    const running = Number(collectionState.counts?.running || 0);
    const queued = Number(collectionState.counts?.queued || 0);
    const failed = Number(collectionState.counts?.failed || 0);
    const completed = Number(collectionState.counts?.completed || 0);
    const total = Object.values(collectionState.counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
    const phaseLabels = {
      preparing: "准备 CLI 与预处理",
      "starting-turn": "启动独立任务",
      executing: "独立 CLI 执行中",
    };
    const startedAt = Date.parse(collectionState.runningStartedAt || "");
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    const elapsed = elapsedMs >= 60_000
      ? `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`
      : elapsedMs >= 1_000
        ? `${Math.floor(elapsedMs / 1000)}s`
        : "";
    const activeStatus = running
      ? `${phaseLabels[collectionState.runningPhase] || "执行中"}${elapsed ? ` ${elapsed}` : ""}${queued ? ` · 另有 ${queued} 项排队` : ""}`
      : "";
    const suffix = pending
      ? ` · ${activeStatus || `${pending} 项待处理`}${completed ? ` · 已完成 ${completed} 项` : ""}`
      : completed
        ? ` · 已完成 ${completed} 项`
        : " · 队列空闲";
    const fileText = `${collectionState.fileName}${suffix}`;
    const fileNode = card.querySelector(".codex-chat-pin-collection-file");
    if (fileNode.textContent !== fileText) fileNode.textContent = fileText;
    const statusErrors = [];
    if (failed) statusErrors.push(`${failed} 项失败`);
    const retryButton = card.querySelector('[data-collection-action="retry"]');
    const hideRetry = failed === 0;
    if (retryButton.hidden !== hideRetry) retryButton.hidden = hideRetry;
    const errorText = statusErrors.length ? `· ${statusErrors.join(" · ")}` : "";
    const errorNode = card.querySelector(".codex-chat-pin-collection-error");
    if (errorNode.textContent !== errorText) errorNode.textContent = errorText;
    const clearButton = card.querySelector('[data-collection-action="clear"]');
    const disableClear = total === 0;
    if (clearButton.disabled !== disableClear) clearButton.disabled = disableClear;
    const cardTitle = collectionState.workspacePath
      ? `执行工作区：${collectionState.workspacePath}`
      : "后续输入将作为独立任务加入采集队列并落实到当前工作区";
    if (card.title !== cardTitle) card.title = cardTitle;
  }

  function upsertCollectionResult(value) {
    if (!value?.id || !value.output) return;
    const next = {
      id: String(value.id),
      input: String(value.input || ""),
      output: String(value.output || ""),
      truncated: value.truncated === true,
      changedFiles: Array.isArray(value.changedFiles) ? value.changedFiles : [],
      completedAt: String(value.completedAt || ""),
      executionProfile: value.executionProfile || null,
      metrics: value.metrics || null,
    };
    collectionResults = [...collectionResults.filter((item) => item.id !== next.id), next].slice(-20);
    collectionResultOpenState.delete(next.id);
    collectionResultsHidden = false;
    schedule();
  }

  function addCollectionResultCards() {
    const rootNode = threadComposerRoot();
    const parent = rootNode?.parentElement;
    const existing = [...document.querySelectorAll(`[${COLLECTION_RESULTS_ATTRIBUTE}="true"]`)];
    if (!parent || collectionResults.length === 0 || collectionResultsHidden) {
      existing.forEach((node) => node.remove());
      return;
    }
    let panel = existing.find((node) => node.parentElement === parent);
    existing.filter((node) => node !== panel).forEach((node) => node.remove());
    if (!panel) {
      panel = document.createElement("section");
      panel.setAttribute(COLLECTION_RESULTS_ATTRIBUTE, "true");
      panel.innerHTML = '<div class="codex-chat-pin-results-header"><span></span><div class="codex-chat-pin-results-actions"><button type="button" data-results-action="collapse">收起</button><button type="button" data-results-action="clear">清空报告</button><button type="button" data-results-action="close">关闭</button></div></div><div class="codex-chat-pin-results-list"></div>';
      panel.querySelector('[data-results-action="collapse"]').addEventListener("click", (event) => {
        const list = panel.querySelector(".codex-chat-pin-results-list");
        collectionResultsCollapsed = !collectionResultsCollapsed;
        list.hidden = collectionResultsCollapsed;
        event.currentTarget.textContent = collectionResultsCollapsed ? "展开" : "收起";
      });
      panel.querySelector('[data-results-action="clear"]').addEventListener("click", async (event) => {
        const clearButton = event.currentTarget;
        if (!collectionSupports("clear-reports")) {
          toast("启动器版本过旧，请完全重启 ChatGPT_Pin.cmd 和专用 Codex", "error");
          return;
        }
        if (!window.confirm("清空当前任务的采集执行报告？这不会撤销已修改的文件，也不会关闭采集模式。")) return;
        clearButton.disabled = true;
        try {
          const message = await requestCollection("clear-reports");
          collectionResultsHidden = false;
          collectionResultsCollapsed = false;
          collectionResultOpenState.clear();
          applyCollectionState(message.state);
          const count = Number(message.state?.clearedReportCount || 0);
          toast(count ? `已清空 ${count} 项采集执行报告` : "没有可清空的采集执行报告");
        } catch (error) {
          toast(`清空采集执行报告失败：${error.message}`, "error");
        } finally {
          if (clearButton.isConnected) clearButton.disabled = false;
        }
      });
      panel.querySelector('[data-results-action="close"]').addEventListener("click", () => {
        collectionResultsHidden = true;
        schedule();
      });
      parent.insertBefore(panel, rootNode);
    }
    const headerText = `采集执行报告（本地） · ${collectionResults.length} 项`;
    const header = panel.querySelector(".codex-chat-pin-results-header span");
    if (header.textContent !== headerText) header.textContent = headerText;
    const clearButton = panel.querySelector('[data-results-action="clear"]');
    const hideClear = !collectionSupports("clear-reports");
    if (clearButton.hidden !== hideClear) clearButton.hidden = hideClear;
    const collapseButton = panel.querySelector('[data-results-action="collapse"]');
    const collapseText = collectionResultsCollapsed ? "展开" : "收起";
    if (collapseButton.textContent !== collapseText) collapseButton.textContent = collapseText;
    const list = panel.querySelector(".codex-chat-pin-results-list");
    list.hidden = collectionResultsCollapsed;
    const shown = collectionResults.slice(-8);
    const renderKey = hash(JSON.stringify(shown));
    if (list.dataset.renderKey === renderKey) return;
    const fragment = document.createDocumentFragment();
    shown.forEach((result, index) => {
      const details = document.createElement("details");
      const resultId = String(result.id);
      details.dataset.collectionResultId = resultId;
      details.open = collectionResultOpenState.has(resultId)
        ? collectionResultOpenState.get(resultId) === true
        : index === shown.length - 1;
      details.addEventListener("toggle", () => {
        collectionResultOpenState.set(resultId, details.open);
      });
      const summary = document.createElement("summary");
      const input = result.input.replace(/\s+/g, " ").trim();
      summary.textContent = `${result.completedAt || "已完成"} · ${input.slice(0, 90) || "采集项"}`;
      const output = document.createElement("pre");
      output.textContent = `${result.output}${result.truncated ? "\n\n……执行报告较长，界面仅显示前 6000 个字符。" : ""}`;
      const changedFiles = document.createElement("div");
      changedFiles.className = "codex-chat-pin-results-files";
      const paths = (result.changedFiles || []).map((change) => change.path).filter(Boolean);
      changedFiles.textContent = paths.length ? `App Server 文件变更：${paths.join("、")}` : "App Server 未返回结构化 fileChange；请以执行报告和磁盘文件为准。";
      const performance = document.createElement("div");
      performance.className = "codex-chat-pin-results-files";
      const formatDuration = (milliseconds) => {
        const value = Number(milliseconds);
        if (!Number.isFinite(value) || value < 0) return "";
        if (value < 1000) return `${Math.round(value)}ms`;
        if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
        return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
      };
      const metrics = result.metrics || {};
      const profile = result.executionProfile || {};
      const parts = [
        metrics.totalMs != null ? `总耗时 ${formatDuration(metrics.totalMs)}` : "",
        metrics.preflightMs != null ? `预处理 ${formatDuration(metrics.preflightMs)}` : "",
        metrics.firstToolMs != null ? `首次工具 ${formatDuration(metrics.firstToolMs)}` : "",
        metrics.firstWriteMs != null ? `首次写入 ${formatDuration(metrics.firstWriteMs)}` : "",
        Number(metrics.compactionCount || 0) ? `压缩 ${metrics.compactionCount} 次` : "",
        profile.model ? `${profile.effectiveModel || profile.model} / ${profile.effectiveEffort || profile.effort || "default"}${profile.fallback ? " (fallback)" : ""}` : "",
      ].filter(Boolean);
      performance.textContent = parts.length ? `性能：${parts.join(" · ")}` : "";
      performance.hidden = parts.length === 0;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "复制报告";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(result.output);
          toast("已复制采集执行报告");
        } catch (error) {
          toast(`复制采集执行报告失败：${error.message}`, "error");
        }
      });
      details.append(summary, changedFiles, performance, output, copy);
      fragment.appendChild(details);
    });
    list.replaceChildren(fragment);
    list.dataset.renderKey = renderKey;
  }

  function sendButton(rootNode) {
    const candidates = [...(rootNode?.querySelectorAll("button") || [])].filter((button) => {
      if (!visible(button) || button.disabled) return false;
      const label = norm(`${button.textContent} ${button.getAttribute("aria-label")} ${button.title}`);
      return !/(停止|stop|取消|cancel)/.test(label);
    });
    const labelled = candidates.find((button) => {
      const labels = [button.textContent, button.getAttribute("aria-label"), button.title].map(norm).filter(Boolean);
      return labels.some((label) => /发送|send|submit/.test(label));
    });
    return labelled || candidates.findLast((button) => button.getAttribute("type") === "submit") || null;
  }

  function desktopExecutionLabel(rootNode) {
    const buttons = [...(rootNode?.querySelectorAll("button") || [])].filter((button) => {
      if (!visible(button) || button.hasAttribute(COLLECTION_SEND_OVERLAY_ATTRIBUTE)) return false;
      if (button.hasAttribute(BUTTON_ATTRIBUTE)
        || button.hasAttribute(OPEN_ATTRIBUTE)
        || button.hasAttribute(REVISION_ATTRIBUTE)
        || button.hasAttribute(COLLECTION_ATTRIBUTE)) return false;
      return true;
    });
    for (const button of buttons) {
      const label = String(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.title || ""}`)
        .replace(/\s+/g, " ")
        .trim();
      if (/(?:gpt[- ]*)?5\.\d+\s*(?:sol|terra|luna)\b/i.test(label)
        || /(?:gpt[- ]*)?5\.[45]\b/i.test(label)) return label;
    }
    return "";
  }

  function submitRoot(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (target?.closest?.(`[${COLLECTION_SEND_OVERLAY_ATTRIBUTE}="true"]`)) return threadComposerRoot();
    return target?.closest?.('[data-codex-composer-root][data-composer-placement="thread"]') || null;
  }

  function isNativeSendButton(button, rootNode) {
    if (button?.hasAttribute(COLLECTION_SEND_OVERLAY_ATTRIBUTE)) return Boolean(rootNode);
    if (!button || !rootNode?.contains(button)) return false;
    if (button.hasAttribute(BUTTON_ATTRIBUTE)
      || button.hasAttribute(OPEN_ATTRIBUTE)
      || button.hasAttribute(REVISION_ATTRIBUTE)
      || button.hasAttribute(COLLECTION_ATTRIBUTE)
      || button.closest(`[${REVISION_CARD_ATTRIBUTE}="true"],[${COLLECTION_CARD_ATTRIBUTE}="true"]`)) return false;
    if (button === sendButton(rootNode) || button.getAttribute("type") === "submit") return true;
    const label = norm(`${button.textContent} ${button.getAttribute("aria-label")} ${button.title}`);
    return /(^|\s)(发送|send|submit)(\s|$)/.test(label) && !/(停止|stop|取消|cancel)/.test(label);
  }

  function restoreNativeCollectionSend(button) {
    if (!(button instanceof HTMLButtonElement)) return;
    const previous = guardedNativeSendState.get(button);
    if (previous) {
      button.disabled = previous.disabled;
      if (previous.ariaDisabled === null) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", previous.ariaDisabled);
      guardedNativeSendState.delete(button);
    }
    button.removeAttribute(COLLECTION_SEND_GUARD_ATTRIBUTE);
  }

  function guardNativeCollectionSend() {
    const enabled = collectionState.enabled && collectionState.sessionId === identity.id;
    const rootNode = enabled ? threadComposerRoot() : null;
    const overlays = [...document.querySelectorAll(`[${COLLECTION_SEND_OVERLAY_ATTRIBUTE}="true"]`)];
    document.querySelectorAll(`[${COLLECTION_SEND_GUARD_ATTRIBUTE}="true"]`).forEach((button) => {
      if (!rootNode?.contains(button)) restoreNativeCollectionSend(button);
    });
    if (!rootNode) {
      overlays.forEach((overlay) => overlay.remove());
      return;
    }
    const guarded = [...rootNode.querySelectorAll(`[${COLLECTION_SEND_GUARD_ATTRIBUTE}="true"]`)]
      .find((candidate) => visible(candidate));
    const button = guarded || sendButton(rootNode);
    if (!button) {
      overlays.forEach((overlay) => overlay.remove());
      return;
    }
    if (!guardedNativeSendState.has(button)) {
      guardedNativeSendState.set(button, {
        disabled: button.disabled,
        ariaDisabled: button.getAttribute("aria-disabled"),
      });
    }
    button.setAttribute(COLLECTION_SEND_GUARD_ATTRIBUTE, "true");
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    let overlay = overlays[0];
    overlays.slice(1).forEach((candidate) => candidate.remove());
    if (!overlay) {
      overlay = document.createElement("button");
      overlay.type = "button";
      overlay.setAttribute(COLLECTION_SEND_OVERLAY_ATTRIBUTE, "true");
      overlay.setAttribute("aria-label", "发送到采集队列");
      overlay.title = "发送到采集队列";
      document.body.appendChild(overlay);
    }
    const rect = button.getBoundingClientRect();
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      display: rect.width > 0 && rect.height > 0 ? "block" : "none",
    });
  }

  function handleCollectionViewportChange() {
    if (collectionState.enabled) guardNativeCollectionSend();
  }

  function handleCollectionComposerInput() {
    if (!collectionState.enabled) return;
    guardNativeCollectionSend();
    schedule();
  }

  function guardedSendButtonAtPoint(rootNode, event) {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [...rootNode.querySelectorAll(`[${COLLECTION_SEND_GUARD_ATTRIBUTE}="true"]`)].find((button) => {
      const rect = button.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  }

  function cleanupLegacyRevisionComposer() {
    const editor = composerEditor();
    if (!editor || revisionCleanupPending) return;
    const text = editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || "";
    if (text.includes(REVISION_MARKER)) {
      revisionCleanupPending = true;
      void requestRevision("cleanup")
        .catch((error) => toast(`残留修订指令清理失败：${error.message}`, "error"))
        .finally(() => { revisionCleanupPending = false; });
    }
  }

  async function finishActiveRevisionTurn(reason = "reply") {
    const turn = revisionTurn;
    if (!turn || turn.finishing) return;
    turn.finishing = true;
    clearTimeout(turn.timeout);
    try {
      const message = await requestRevision("turn-finish", { turnId: turn.turnId }, 12_000);
      applyRevisionState(message.state);
      if (message.state?.changed) {
        toast(`已修订 ${message.state.relativePath}`);
      } else {
        toast(reason === "timeout"
          ? "修订等待超时，目标文件没有发生变化"
          : "回答已完成，但目标 Pin 文件没有发生变化", "error");
      }
    } catch (error) {
      toast(`修订结果核验失败：${error.message}`, "error");
    } finally {
      if (revisionTurn === turn) revisionTurn = null;
    }
  }

  function maybeFinishRevisionTurn(activePairs) {
    if (!revisionTurn || revisionTurn.finishing) return;
    const fingerprints = activePairs.map((pair) => content(pair.message)?.fingerprint).filter(Boolean);
    const hasNewReply = activePairs.length > revisionTurn.replyCount
      || fingerprints.some((fingerprint) => !revisionTurn.replyFingerprints.has(fingerprint));
    if (hasNewReply && Date.now() - revisionTurn.startedAt > 400) {
      void finishActiveRevisionTurn();
    }
  }

  async function prepareRevisionSubmit(event, rootNode) {
    if (!revisionState.enabled || revisionState.sessionId !== identity.id) return;
    if (bypassRevisionSubmit) {
      bypassRevisionSubmit = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (revisionTurn) {
      toast("上一轮修订仍在处理中，请等待完成后再发送", "error");
      return;
    }
    const editor = composerEditor(rootNode);
    const input = (editor instanceof HTMLTextAreaElement ? editor.value : editor?.innerText || "").trim();
    if (!editor || !input) {
      toast("请输入本次文档修改要求", "error");
      return;
    }
    const button = sendButton(rootNode);
    if (!button) {
      toast("无法开始修订：未找到可用的 Codex 发送按钮", "error");
      return;
    }
    const activePairs = pairs();
    const turnId = `turn-${Date.now()}-${++requestSequence}`;
    let turnStarted = false;
    try {
      await requestRevision("turn-start", { turnId, input }, 12_000);
      turnStarted = true;
      revisionTurn = {
        turnId,
        sessionId: identity.id,
        startedAt: Date.now(),
        replyCount: activePairs.length,
        replyFingerprints: new Set(activePairs.map((pair) => content(pair.message)?.fingerprint).filter(Boolean)),
        finishing: false,
        timeout: setTimeout(() => void finishActiveRevisionTurn("timeout"), 10 * 60 * 1000),
      };
      bypassRevisionSubmit = true;
      button.click();
      setTimeout(() => {
        rootNode.removeAttribute("data-codex-chat-pin-submitting");
      }, 250);
      queueMicrotask(() => { bypassRevisionSubmit = false; });
    } catch (error) {
      if (turnStarted) {
        void requestRevision("turn-finish", { turnId }, 12_000).catch(() => {});
      }
      toast(`无法开始修订：${error.message}`, "error");
    }
  }

  async function prepareCollectionSubmit(event, rootNode) {
    if (!collectionState.enabled || collectionState.sessionId !== identity.id) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!collectionSupports("workspace-write")) {
      toast("无法执行采集：启动器仍是旧版，请完全关闭 ChatGPT_Pin.cmd 和专用 Codex 后重新启动", "error");
      return;
    }
    if (collectionSubmitting) return;
    const editor = composerEditor(rootNode);
    const input = composerValue(editor).trim();
    if (!editor || !input) {
      toast("请输入本次采集要求", "error");
      return;
    }
    collectionSubmitting = true;
    const detached = replaceComposerValueImmediately(editor, "");
    if (!detached) {
      collectionSubmitting = false;
      toast("无法接管 Codex 输入框，本次内容未加入采集队列", "error");
      return;
    }
    try {
      const currentExecutionLabel = collectionSupports("desktop-execution-selection")
        ? desktopExecutionLabel(rootNode)
        : "";
      const message = await requestCollection("enqueue", {
        input,
        composerCleared: true,
        ...(currentExecutionLabel ? { desktopExecutionLabel: currentExecutionLabel } : {}),
      }, 20_000);
      applyCollectionState(message.state);
      const pending = Number(message.state?.pendingCount || 0);
      if (message.state?.composer?.cleared === false) {
        toast(`已加入采集队列，但输入框未清空：${message.state.composer.error || "请手动清空"}`, "error");
      } else {
        toast(`已加入采集队列${pending ? `（${pending} 项待处理）` : ""}`);
      }
    } catch (error) {
      setTimeout(() => {
        if (editor.isConnected && !composerValue(editor).trim()) {
          replaceComposerValueImmediately(editor, input);
        }
      }, 900);
      toast(`无法加入采集队列：${error.message}`, "error");
    } finally {
      setTimeout(() => { collectionSubmitting = false; }, 750);
    }
  }

  function handleSubmitClick(event) {
    const rootNode = submitRoot(event);
    if (!rootNode || (!revisionState.enabled && !collectionState.enabled)) return;
    const button = event.target?.closest?.("button") || guardedSendButtonAtPoint(rootNode, event);
    if (!isNativeSendButton(button, rootNode)) return;
    if (collectionState.enabled) void prepareCollectionSubmit(event, rootNode);
    else void prepareRevisionSubmit(event, rootNode);
  }

  function handleCollectionPointerSubmit(event) {
    if (!collectionState.enabled || collectionState.sessionId !== identity.id) return;
    if (Number.isFinite(event.button) && event.button !== 0) return;
    const rootNode = submitRoot(event);
    const button = event.target?.closest?.("button") || guardedSendButtonAtPoint(rootNode, event);
    if (!rootNode || !isNativeSendButton(button, rootNode)) return;
    void prepareCollectionSubmit(event, rootNode);
  }

  function handleNativeFormSubmit(event) {
    if (!collectionState.enabled || collectionState.sessionId !== identity.id) return;
    const rootNode = submitRoot(event)
      || (event.target instanceof HTMLFormElement && event.target.contains(threadComposerRoot()) ? threadComposerRoot() : null);
    if (!rootNode) return;
    void prepareCollectionSubmit(event, rootNode);
  }

  function handleSubmitKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const rootNode = event.target?.closest?.('[data-codex-composer-root][data-composer-placement="thread"]');
    if (!rootNode || (!revisionState.enabled && !collectionState.enabled) || !composerEditor(rootNode)?.contains(event.target)) return;
    if (collectionState.enabled) void prepareCollectionSubmit(event, rootNode);
    else void prepareRevisionSubmit(event, rootNode);
  }

  function handleCollectionKeyup(event) {
    if (event.key !== "Enter" || !collectionState.enabled || event.isComposing) return;
    const rootNode = event.target?.closest?.('[data-codex-composer-root][data-composer-placement="thread"]');
    if (!rootNode || !composerEditor(rootNode)?.contains(event.target)) return;
    void prepareCollectionSubmit(event, rootNode);
  }

  function handleCollectionBeforeInput(event) {
    if (!collectionState.enabled || !["insertParagraph", "insertLineBreak"].includes(event.inputType)) return;
    const rootNode = event.target?.closest?.('[data-codex-composer-root][data-composer-placement="thread"]');
    if (!rootNode || !composerEditor(rootNode)?.contains(event.target)) return;
    void prepareCollectionSubmit(event, rootNode);
  }

  function refresh() {
    const activePairs = pairs();
    const activeFooters = new Set(activePairs.map((pair) => pair.footer));
    document.querySelectorAll(`[${BUTTON_ATTRIBUTE}="true"]`).forEach((button) => {
      if (![...activeFooters].some((footer) => footer.contains(button))) button.remove();
    });
    for (const pair of activePairs) {
      addPin(pair);
      const value = content(pair.message);
      pair.message.classList.toggle(HIGHLIGHT_CLASS, Boolean(lastPinnedFingerprint && value?.fingerprint === lastPinnedFingerprint));
    }
    addOpenPinEntries();
    addModeButtons();
    addRevisionCard();
    addCollectionCard();
    addCollectionResultCards();
    guardNativeCollectionSend();
    cleanupLegacyRevisionComposer();
    maybeFinishRevisionTurn(activePairs);
  }

  function receiveHostMessage(payload) {
    let message;
    try {
      message = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      return;
    }
    if (message?.type === "collection-event") {
      if (message.sessionId !== identity.id) return;
      applyCollectionState(message.state);
      if (message.event === "item-completed") {
        upsertCollectionResult(message.item);
        toast("采集执行完成；报告已显示在当前任务输入框上方");
      } else if (message.event === "item-failed") {
        toast(`采集失败：${message.item?.error || "未知错误"}`, "error");
      }
      return;
    }
    if (message?.type === "collection-result") {
      const pending = pendingCollectionRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingCollectionRequests.delete(message.requestId);
      if (!message.ok) pending.reject(new Error(message.error || "采集请求失败"));
      else pending.resolve(message);
      return;
    }
    if (message?.type === "revision-result") {
      const pending = pendingRevisionRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRevisionRequests.delete(message.requestId);
      if (!message.ok) pending.reject(new Error(message.error || "修订请求失败"));
      else pending.resolve(message);
      return;
    }
    if (message?.type === "open-result") {
      if (!pendingOpens.has(message.requestId)) return;
      pendingOpens.delete(message.requestId);
      lastOpenResult = message.openResult || null;
      if (!message.ok || !message.openResult?.ok) {
        toast(`Pin 文件打开失败：${message.error || message.openResult?.error || "未知错误"}`, "error");
      } else {
        toast(`已打开 ${message.fileName}`);
      }
      return;
    }
    if (message?.type !== "save-result") return;
    const pending = pendingSaves.get(message.requestId);
    if (!pending) return;
    pendingSaves.delete(message.requestId);
    if (pending.button?.isConnected) {
      pending.button.disabled = false;
      pending.button.setAttribute("aria-label", "保存为 Markdown 并打开");
    }
    lastOpenResult = message.openResult || null;
    if (!message.ok) {
      toast(`Markdown 保存失败：${message.error || "未知错误"}`, "error");
      return;
    }
    if (message.revisionDisabled) {
      revisionState = { enabled: false };
      revisionTurn = null;
    }
    if (message.collectionDisabled) collectionState = { enabled: false };
    if (!message.openResult?.ok) {
      toast(`已保存 ${message.fileName}，但原生文件页打开失败：${message.openResult?.error || "未找到文件入口"}`, "error");
      return;
    }
    lastPinnedFingerprint = pending.fingerprint;
    refresh();
    const elapsed = Number.isFinite(message.openResult?.elapsedMs) ? `（${message.openResult.elapsedMs}ms）` : "";
    toast(`已保存并打开 ${message.fileName}${elapsed}`);
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      updateIdentity();
      refresh();
      void syncRevisionStatus();
      void syncCollectionStatus();
    }, 180);
  }

  function mount() {
    style();
    refresh();
    window.addEventListener("pointerdown", handleCollectionPointerSubmit, true);
    window.addEventListener("mousedown", handleCollectionPointerSubmit, true);
    window.addEventListener("pointerup", handleCollectionPointerSubmit, true);
    window.addEventListener("click", handleSubmitClick, true);
    window.addEventListener("keydown", handleSubmitKeydown, true);
    window.addEventListener("keyup", handleCollectionKeyup, true);
    window.addEventListener("beforeinput", handleCollectionBeforeInput, true);
    window.addEventListener("submit", handleNativeFormSubmit, true);
    window.addEventListener("input", handleCollectionComposerInput, true);
    window.addEventListener("resize", handleCollectionViewportChange, true);
    window.addEventListener("scroll", handleCollectionViewportChange, true);
    observer = new MutationObserver(() => {
      if (collectionState.enabled) guardNativeCollectionSend();
      schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void syncRevisionStatus();
    void syncCollectionStatus();
  }

  function destroy() {
    observer?.disconnect();
    clearTimeout(timer);
    clearTimeout(collectionStatusPollTimer);
    clearTimeout(revisionTurn?.timeout);
    window.removeEventListener("pointerdown", handleCollectionPointerSubmit, true);
    window.removeEventListener("mousedown", handleCollectionPointerSubmit, true);
    window.removeEventListener("pointerup", handleCollectionPointerSubmit, true);
    window.removeEventListener("click", handleSubmitClick, true);
    window.removeEventListener("keydown", handleSubmitKeydown, true);
    window.removeEventListener("keyup", handleCollectionKeyup, true);
    window.removeEventListener("beforeinput", handleCollectionBeforeInput, true);
    window.removeEventListener("submit", handleNativeFormSubmit, true);
    window.removeEventListener("input", handleCollectionComposerInput, true);
    window.removeEventListener("resize", handleCollectionViewportChange, true);
    window.removeEventListener("scroll", handleCollectionViewportChange, true);
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(`[${BUTTON_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${OPEN_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${REVISION_ATTRIBUTE}="true"],[${REVISION_CARD_ATTRIBUTE}="true"],[${COLLECTION_ATTRIBUTE}="true"],[${COLLECTION_CARD_ATTRIBUTE}="true"],[${COLLECTION_RESULTS_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${COLLECTION_SEND_GUARD_ATTRIBUTE}="true"]`).forEach(restoreNativeCollectionSend);
    document.querySelectorAll(`[${COLLECTION_SEND_OVERLAY_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => node.classList.remove(HIGHLIGHT_CLASS));
    document.querySelector(".codex-chat-pin-toast")?.remove();
    pendingSaves.clear();
    pendingOpens.clear();
    for (const pending of pendingRevisionRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Chat Pin 注入已重新加载"));
    }
    pendingRevisionRequests.clear();
    for (const pending of pendingCollectionRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Chat Pin 注入已重新加载"));
    }
    pendingCollectionRequests.clear();
  }

  window[API_KEY] = {
    version: VERSION,
    sourceHash: window.__CODEX_PIN_SOURCE_HASH__ || "",
    receiveHostMessage,
    destroy,
    refresh,
    nativeFileMenuPoint,
    diagnostics: () => ({
      version: VERSION,
      sessionId: identity.id,
      reliableSessionId: identity.reliable,
      fileName: fileName(),
      assistantReplies: pairs().length,
      pinButtons: document.querySelectorAll(`[${BUTTON_ATTRIBUTE}="true"]`).length,
      openPinEntries: document.querySelectorAll(`[${OPEN_ATTRIBUTE}="true"]`).length,
      revisionButtons: document.querySelectorAll(`[${REVISION_ATTRIBUTE}="true"]`).length,
      collectionButtons: document.querySelectorAll(`[${COLLECTION_ATTRIBUTE}="true"]`).length,
      collectionResultCards: collectionResults.length,
      collectionSendOverlays: document.querySelectorAll(`[${COLLECTION_SEND_OVERLAY_ATTRIBUTE}="true"]`).length,
      revisionState,
      collectionState,
      revisionTurn: revisionTurn ? { turnId: revisionTurn.turnId, startedAt: revisionTurn.startedAt } : null,
      customPanel: false,
      pendingSaves: pendingSaves.size,
      lastOpenResult,
      nativeTabs: [...document.querySelectorAll('[role="tab"]')].map((node) => (node.textContent || '').trim()).filter(Boolean),
    }),
  };

  mount();
})();
