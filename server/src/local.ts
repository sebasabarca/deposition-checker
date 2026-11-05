// Local mode (LOCAL_MODE=true): one person running Veridict on their own computer. Accounts and sessions work as
// usual, with three differences:
//   - the API listens on 127.0.0.1 only (server/src/index.ts), and refuses to start behind a proxy (TRUST_PROXY);
//   - every account may start paid analyses: the person who added ANTHROPIC_API_KEY is the one paying, and each run
//     still needs their explicit confirmation with a spending limit the server enforces;
//   - "Open the demo workspace" signs this browser in as LOCAL_DEMO_EMAIL, but only for a request that reached the
//     server over loopback with a localhost Host header (so not from another machine, nor a DNS-rebinding page),
//     and only for a reserved example.test address, so it can never open a real person's account.

import type { Request } from "express";

type Env = Record<string, string | undefined>;

export const localMode = (env: Env = process.env) => env.LOCAL_MODE === "true";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The socket's own address, never X-Forwarded-For: a header can be forged, the TCP peer can't.
export function fromLoopback(req: Pick<Request, "headers"> & { socket: { remoteAddress?: string } }) {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "") && LOOPBACK_HOSTS.has(host);
}

// The demo account's email when local demo access is turned on, or null.
export function localDemoEmail(env: Env = process.env) {
  const email = env.LOCAL_DEMO_EMAIL?.trim().toLowerCase();
  return localMode(env) && email && /^[^@\s]+@example\.test$/.test(email) ? email : null;
}
