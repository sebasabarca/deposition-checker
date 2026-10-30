// A real headless Chrome driven over the DevTools protocol, for the product benchmark: real clicks,
// real screenshots, and times measured from the action until the element is on screen. Uses only
// Node's fetch and WebSocket and the installed Chrome, so it adds no dependency.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORT = { width: 1440, height: 1000 };

export type BrowserProblem = { kind: string; text: string };

export class Page {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  problems: BrowserProblem[] = [];
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { entry?: { level: string; text: string } } };
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(m.error.message));
        else w?.resolve(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.problems.push({ kind: "exception", text: JSON.stringify(m.params).slice(0, 500) });
      } else if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") {
        this.problems.push({ kind: "console", text: m.params.entry.text.slice(0, 500) });
      }
    });
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  // Waits for a condition, then for the next painted frame. Returns the milliseconds taken.
  async waitFor(condition: string, timeoutMs = 20_000, from = performance.now()): Promise<number> {
    while (performance.now() - from < timeoutMs) {
      if (await this.eval<boolean>(`!!(${condition})`)) {
        await this.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        return performance.now() - from;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out waiting for ${condition}`);
  }

  // Loads a URL from nothing (a full page load), and waits for the condition.
  async load(url: string, condition: string): Promise<number> {
    await this.send("Page.navigate", { url: "about:blank" });
    const started = performance.now();
    await this.send("Page.navigate", { url });
    return this.waitFor(condition, 20_000, started);
  }

  // A real mouse click at the centre of an element, chosen by a JavaScript expression.
  async click(element: string): Promise<void> {
    const box = await this.eval<{ x: number; y: number } | null>(`(() => { const e = ${element}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`Nothing to click: ${element}`);
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }

  async screenshot(file: string, { fullPage = true } = {}): Promise<void> {
    const size = await this.send<{ cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
    const clip = { x: 0, y: 0, width: VIEWPORT.width, height: fullPage ? Math.ceil(size.cssContentSize.height) : VIEWPORT.height, scale: 1 };
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
  }
}

export type Browser = { page: Page; version: string; close: () => void };

export async function openBrowser(): Promise<Browser> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);
  const profile = mkdtempSync(path.join(tmpdir(), "benchmark-chrome-"));
  const chrome: ChildProcess = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const version = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser: string }).Browser;
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const page = new Page(ws);
  await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Log.enable")]);
  await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  return {
    page,
    version,
    close: () => {
      ws.close();
      chrome.kill();
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref();
    },
  };
}
