import { describe, expect, it } from "vitest";
import { fromLoopback, localDemoEmail, localMode } from "../server/src/local";

const req = (remoteAddress: string, host: string) => ({ headers: { host }, socket: { remoteAddress } });

describe("local mode", () => {
  it("is on only when LOCAL_MODE is exactly true", () => {
    expect(localMode({})).toBe(false);
    expect(localMode({ LOCAL_MODE: "1" })).toBe(false);
    expect(localMode({ LOCAL_MODE: "true" })).toBe(true);
  });
  it("treats a request as local only from a loopback socket with a localhost Host", () => {
    expect(fromLoopback(req("127.0.0.1", "localhost:5173"))).toBe(true);
    expect(fromLoopback(req("::1", "127.0.0.1:3001"))).toBe(true);
    expect(fromLoopback(req("::ffff:127.0.0.1", "[::1]:3001"))).toBe(true);
    expect(fromLoopback(req("192.168.1.20", "localhost:5173"))).toBe(false); // another machine
    expect(fromLoopback(req("127.0.0.1", "192.168.1.5:5173"))).toBe(false); // a dev proxy reached over the network
    expect(fromLoopback(req("127.0.0.1", "evil.example:5173"))).toBe(false); // DNS rebinding
    expect(fromLoopback(req("127.0.0.1", ""))).toBe(false);
  });
  it("opens demo access only in local mode and only for a reserved example.test account", () => {
    expect(localDemoEmail({ LOCAL_DEMO_EMAIL: "demo@example.test" })).toBeNull(); // not local mode
    expect(localDemoEmail({ LOCAL_MODE: "true" })).toBeNull();
    expect(localDemoEmail({ LOCAL_MODE: "true", LOCAL_DEMO_EMAIL: "partner@firm.law" })).toBeNull(); // a real address
    expect(localDemoEmail({ LOCAL_MODE: "true", LOCAL_DEMO_EMAIL: "x@example.test.evil.com" })).toBeNull();
    expect(localDemoEmail({ LOCAL_MODE: "true", LOCAL_DEMO_EMAIL: " Demo@Example.test " })).toBe("demo@example.test");
  });
});
