(() => {
  "use strict";

  const VERSION = "0.5.8"; // Use the exact-search result as the native file opening fast path.
  const API_KEY = "__codexChatPinInjection__";
  const STYLE_ID = "codex-chat-pin-style";
  const BUTTON_ATTRIBUTE = "data-codex-chat-pin-button";
  const OPEN_ATTRIBUTE = "data-codex-chat-pin-open";
  const HIGHLIGHT_CLASS = "codex-chat-pin-source";
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
  const pendingSaves = new Map();
  const pendingOpens = new Set();
  const contentCache = new WeakMap();

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
    const next = currentSessionIdentity();
    if (next.reliable || !identity.reliable) identity = next;
    return identity;
  }

  function hostRequest(message) {
    if (typeof window.__codexChatPinPersist !== "function") return false;
    window.__codexChatPinPersist(JSON.stringify(message));
    return true;
  }

  function style() {
    if (document.getElementById(STYLE_ID)) return;
    const node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = `
      [${BUTTON_ATTRIBUTE}="true"]{display:inline-flex!important;align-items:center;justify-content:center;min-width:32px!important;min-height:32px!important;padding:5px!important}
      [${BUTTON_ATTRIBUTE}="true"] svg{width:16px;height:16px;fill:currentColor}
      [${OPEN_ATTRIBUTE}="true"] svg{width:18px;height:18px;fill:currentColor}
      .${HIGHLIGHT_CLASS}{outline:1px solid #6798ff88;outline-offset:4px;border-radius:7px}
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

  function markdownFrom(node) {
    const walkChildren = (parent) => [...parent.childNodes].map(walk).join("");
    const walk = (current) => {
      if (current.nodeType === Node.TEXT_NODE) return (current.nodeValue || "").replace(/\u00a0/g, " ");
      if (current.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = current.tagName;
      if (tag === "BR") return "\n";
      if (tag === "PRE") {
        const code = (current.textContent || "").replace(/\n$/, "");
        const language = current.querySelector("code")?.className?.match(/language-([\w-]+)/)?.[1] || "";
        const ticks = code.includes("```") ? "````" : "```";
        return `\n${ticks}${language}\n${code}\n${ticks}\n\n`;
      }
      if (tag === "CODE") {
        const value = current.textContent || "";
        const fence = value.includes("`") ? "``" : "`";
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

  function pin(pair, button) {
    updateIdentity();
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
  }

  function receiveHostMessage(payload) {
    let message;
    try {
      message = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
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
    }, 180);
  }

  function mount() {
    style();
    refresh();
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function destroy() {
    observer?.disconnect();
    clearTimeout(timer);
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(`[${BUTTON_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${OPEN_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => node.classList.remove(HIGHLIGHT_CLASS));
    document.querySelector(".codex-chat-pin-toast")?.remove();
    pendingSaves.clear();
    pendingOpens.clear();
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
      customPanel: false,
      pendingSaves: pendingSaves.size,
      lastOpenResult,
      nativeTabs: [...document.querySelectorAll('[role="tab"]')].map((node) => (node.textContent || '').trim()).filter(Boolean),
    }),
  };

  mount();
})();
