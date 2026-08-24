/** Minimal Chrome DevTools Protocol client for Electron's --remote-debugging-pipe. */
export class CdpPipeBrowser {
  constructor(child) {
    this.child = child;
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.sequence = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.output.on("data", (chunk) => this.receive(chunk));
    this.output.once("error", (error) => this.fail(error));
    this.output.once("end", () => this.fail(new Error("CDP pipe ended")));
    this.input.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => this.fail(new Error(`Codex exited (${signal || code})`)));
  }

  async open() {
    await this.send("Browser.getVersion");
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let boundary = this.buffer.indexOf(0); boundary !== -1; boundary = this.buffer.indexOf(0)) {
      const raw = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else if (message.sessionId) {
        this.sessions.get(message.sessionId)?.dispatch(message.method, message.params);
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP pipe closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(`${JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })}\0`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async targets() {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  async connect(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const session = new CdpSession(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  detach(sessionId) {
    this.sessions.get(sessionId)?.fail(new Error("CDP session closed"));
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
    for (const session of this.sessions.values()) session.fail(error);
    this.sessions.clear();
  }

  close() {
    if (this.closed) return;
    this.input.destroy();
    this.output.destroy();
    this.fail(new Error("CDP pipe closed"));
  }
}

class CdpSession {
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

  close() { this.browser.detach(this.id); }
}
