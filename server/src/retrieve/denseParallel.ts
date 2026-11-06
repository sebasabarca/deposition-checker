// denseNeighbours (independent.ts) split over worker threads by rows, for large cases: every pair is still scored, with
// the same products summed in the same order, and each row keeps the k best by (score desc, id asc), so the lists are
// identical. The dense path is the one that stays n^2 x dims; threads divide its wall time, not its work (each worker
// scores its rows against every item, so W threads do about the work of W/2 rows-once passes).

import { Worker } from "node:worker_threads";
import { TopK, type Item, type Neighbour } from "./independent";

// Plain JavaScript, so it runs in a worker without a TypeScript loader. Returns, per row, up to k (id, score) pairs.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { flat, sessions, dims, n, lo, hi, k } = workerData;
const ids = new Int32Array((hi - lo) * k).fill(-1), scores = new Float64Array((hi - lo) * k);
const hid = new Int32Array(k), hsc = new Float64Array(k);
const worse = (i, j) => hsc[i] < hsc[j] || (hsc[i] === hsc[j] && hid[i] > hid[j]);
const swap = (i, j) => { const a = hid[i]; hid[i] = hid[j]; hid[j] = a; const b = hsc[i]; hsc[i] = hsc[j]; hsc[j] = b; };
for (let d = lo; d < hi; d++) {
  let size = 0;
  const a = d * dims;
  for (let e = 0; e < n; e++) {
    if (e === d || sessions[e] === sessions[d]) continue;
    let s = 0; const b = e * dims;
    for (let j = 0; j < dims; j++) s += flat[a + j] * flat[b + j];
    if (!(s > 0)) continue;
    if (size < k) { hid[size] = e; hsc[size] = s; for (let i = size++; i > 0;) { const p = (i - 1) >> 1; if (!worse(i, p)) break; swap(i, p); i = p; } continue; }
    if (s < hsc[0] || (s === hsc[0] && e > hid[0])) continue;
    hid[0] = e; hsc[0] = s;
    for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < size && worse(l, m)) m = l; if (r < size && worse(r, m)) m = r; if (m === i) break; swap(i, m); i = m; }
  }
  for (let i = 0; i < size; i++) { ids[(d - lo) * k + i] = hid[i]; scores[(d - lo) * k + i] = hsc[i]; }
}
parentPort.postMessage({ ids, scores }, [ids.buffer, scores.buffer]);
`;

export async function denseNeighboursParallel(items: readonly Item[], vectors: readonly Float64Array[], k: number, threads: number): Promise<Neighbour[][]> {
  if (!(Number.isInteger(threads) && threads >= 1)) throw new Error("threads must be a positive integer");
  const n = vectors.length;
  const dims = n ? vectors[0].length : 0;
  if (!n || k <= 0) return vectors.map(() => []);
  const flat = new Float64Array(new SharedArrayBuffer(n * dims * 8));
  vectors.forEach((v, d) => flat.set(v, d * dims));
  // Sessions as small integers, so the worker compares numbers.
  const sessionIds = new Map<number, number>();
  const sessions = new Int32Array(new SharedArrayBuffer(n * 4));
  items.forEach((it, d) => { sessions[d] = sessionIds.get(it.session) ?? sessionIds.set(it.session, sessionIds.size).get(it.session)!; });
  const kk = Math.min(k, n);
  const size = Math.ceil(n / threads);
  const ranges = Array.from({ length: threads }, (_, w) => [w * size, Math.min(n, (w + 1) * size)] as const).filter(([lo, hi]) => lo < hi);
  const parts = await Promise.all(ranges.map(([lo, hi]) => new Promise<{ ids: Int32Array; scores: Float64Array }>((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { flat, sessions, dims, n, lo, hi, k: kk } });
    worker.once("message", (m) => { resolve(m); void worker.terminate(); });
    worker.once("error", reject);
  })));
  const out: Neighbour[][] = [];
  ranges.forEach(([lo, hi], w) => {
    for (let d = lo; d < hi; d++) {
      const top = new TopK(kk);
      for (let i = 0; i < kk; i++) { const id = parts[w].ids[(d - lo) * kk + i]; if (id >= 0) top.offer(id, parts[w].scores[(d - lo) * kk + i]); }
      out.push(top.sorted());
    }
  });
  return out;
}
