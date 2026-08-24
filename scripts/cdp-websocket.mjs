/** Chrome DevTools Protocol client for a loopback WebSocket endpoint. */
export class CdpWebSocketBrowser {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.closed = false;
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleFailure);
        this.socket.removeEventListener("close", handleFailure);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleFailure = () => {
        cleanup();
        reject(new Error("Codex CDP WebSocket connection failed"));
      };
      this.socket.addEventListener("open", handleOpen);
      this.socket.addEventListener("error", handleFailure);
      this.socket.addEventListener("close", handleFailure);
    });
    this.socket.addEventListener("message", (event) => this.receive(event.data));
    this.socket.addEventListener("error", () => this.fail(new Error("Codex CDP WebSocket failed")));
    this.socket.addEventListener("close", () => this.fail(new Error("Codex CDP WebSocket closed")));
    await this.send("Browser.getVersion");
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  receive(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      return;
    }
    if (message.sessionId) this.sessions.get(message.sessionId)?.dispatch(message.method, message.params);
  }

  send(method, params = {}, sessionId) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex CDP WebSocket is closed"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async targets() {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  async connect(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const session = new CdpWebSocketSession(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  detach(sessionId) {
    this.sessions.get(sessionId)?.fail();
    this.sessions.delete(sessionId);
    if (!this.closed) this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    for (const session of this.sessions.values()) session.fail();
    this.sessions.clear();
  }

  close() {
    if (this.closed) return;
    this.socket?.close();
    this.fail(new Error("Codex CDP WebSocket closed"));
  }
}

class CdpWebSocketSession {
  constructor(browser, id) {
    this.browser = browser;
    this.id = id;
    this.handlers = new Map();
    this.closed = false;
  }

  send(method, params = {}) {
    return this.closed
      ? Promise.reject(new Error("CDP session closed"))
      : this.browser.send(method, params, this.id);
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  dispatch(method, params) {
    for (const handler of this.handlers.get(method) || []) Promise.resolve(handler(params)).catch(() => {});
  }

  fail() {
    this.closed = true;
    this.handlers.clear();
  }

  close() {
    this.browser.detach(this.id);
  }
}

