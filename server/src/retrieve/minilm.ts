// The only place that loads the local embedding model: all-MiniLM-L6-v2 (Apache-2.0), ONNX export
// Xenova/all-MiniLM-L6-v2 at a pinned hub revision, read from data/raw/models/ with remote loading
// disabled, so transcript text never leaves the machine. Fetch the files once with the commands in
// scripts/retrieval-embed.ts's header.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AutoModel, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import { meanPool, normalize, poolWindows, windowsOf } from "./embeddings";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const ONNX_SHA256 = "759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e";
export const MODELS_DIR = path.resolve("data/raw/models");
// MiniLM was trained on sequences of at most 256 word pieces, [CLS] and [SEP] included.
export const WINDOW_TOKENS = 254;
export const WINDOW_OVERLAP = 64;
export const WINDOWING = `w${WINDOW_TOKENS}o${WINDOW_OVERLAP}`;

export const modelFilesPresent = () => existsSync(path.join(MODELS_DIR, MODEL_ID, "onnx", "model.onnx"));

export type MiniLM = {
  tokenize: (text: string) => number[];
  // One normalized vector per text, and how many windows each needed.
  embed: (texts: readonly string[], batchSize?: number) => Promise<{ vectors: Float32Array[]; windows: number[] }>;
  // Fetch calls the library attempted (each refused): must stay 0.
  fetchAttempts: () => number;
};

export async function loadMiniLM(): Promise<MiniLM> {
  if (!modelFilesPresent()) throw new Error(`model files missing under ${MODELS_DIR}/${MODEL_ID}`);
  const dir = path.join(MODELS_DIR, MODEL_ID);
  if (readFileSync(path.join(dir, "REVISION"), "utf8").trim() !== MODEL_REVISION) throw new Error("model files are not the pinned revision");
  if (createHash("sha256").update(readFileSync(path.join(dir, "onnx", "model.onnx"))).digest("hex") !== ONNX_SHA256) throw new Error("model.onnx does not match the pinned SHA-256");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_DIR;
  env.useFSCache = false;
  let attempts = 0;
  env.fetch = async (input: string | URL) => { attempts++; throw new Error(`network access refused: ${String(input)}`); };
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { local_files_only: true });
  const model = await AutoModel.from_pretrained(MODEL_ID, { local_files_only: true, dtype: "fp32", revision: MODEL_REVISION });
  const [cls, sep] = [tokenizer.encode("", { add_special_tokens: true })[0], tokenizer.encode("", { add_special_tokens: true }).at(-1)!];
  const tokenize = (text: string) => tokenizer.encode(text, { add_special_tokens: false });

  async function embedWindows(windows: number[][]): Promise<Float32Array[]> {
    const len = Math.max(...windows.map((w) => w.length)) + 2;
    const ids = new BigInt64Array(windows.length * len);
    const mask = new BigInt64Array(windows.length * len);
    windows.forEach((w, b) => [cls, ...w, sep].forEach((id, t) => { ids[b * len + t] = BigInt(id); mask[b * len + t] = 1n; }));
    const shape = [windows.length, len];
    const out = await model({ input_ids: new Tensor("int64", ids, shape), attention_mask: new Tensor("int64", mask, shape), token_type_ids: new Tensor("int64", new BigInt64Array(ids.length), shape) });
    const hidden = out.last_hidden_state as Tensor;
    const dim = hidden.dims[2];
    const data = hidden.data as Float32Array;
    return windows.map((_, b) => normalize(meanPool(data.subarray(b * len * dim, (b + 1) * len * dim), Array.from(mask.subarray(b * len, (b + 1) * len), Number), dim)));
  }

  async function embed(texts: readonly string[], batchSize = 32) {
    const perText = texts.map((t) => windowsOf(tokenize(t), WINDOW_TOKENS, WINDOW_OVERLAP));
    const flat = perText.flatMap((ws, i) => ws.map((w) => ({ i, w })));
    // Similar lengths together: less padding per batch.
    const order = flat.map((_, k) => k).sort((x, y) => flat[x].w.length - flat[y].w.length);
    const vecs: Float32Array[] = new Array(flat.length);
    for (let s = 0; s < order.length; s += batchSize) {
      const batch = order.slice(s, s + batchSize);
      (await embedWindows(batch.map((k) => flat[k].w))).forEach((v, j) => { vecs[batch[j]] = v; });
    }
    const vectors: Float32Array[] = [];
    let k = 0;
    for (const ws of perText) {
      const vs = vecs.slice(k, k + ws.length);
      vectors.push(ws.length === 1 ? vs[0] : poolWindows(vs, ws.map((w) => w.length)));
      k += ws.length;
    }
    return { vectors, windows: perText.map((ws) => ws.length) };
  }

  return { tokenize, embed, fetchAttempts: () => attempts };
}
