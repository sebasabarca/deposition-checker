// The only place that loads the local reranking models, both cross-encoders scoring a pair of passages:
//   ce   Xenova/ms-marco-MiniLM-L-6-v2 (ONNX of cross-encoder/ms-marco-MiniLM-L6-v2, Apache-2.0): passage relevance
//   nli  Xenova/nli-deberta-v3-xsmall (ONNX of cross-encoder/nli-deberta-v3-xsmall, Apache-2.0): contradiction,
//        entailment, neutral
// Each at a pinned hub revision with the ONNX file's SHA-256 checked, read from data/raw/models/ with remote
// loading disabled and fetch replaced by a counter that refuses, as minilm.ts does, so testimony never leaves the
// machine. The one-time download is in scripts/retrieval-rerank.ts's header.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AutoModelForSequenceClassification, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import { pairWindows, softmax } from "./rerank";

export const MODELS_DIR = path.resolve("data/raw/models");
export const RERANK_MODELS = {
  ce: { id: "Xenova/ms-marco-MiniLM-L-6-v2", revision: "a09144355adeed5f58c8ed011d209bf8ee5a1fec", sha256: "c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870", maxLen: 512 },
  nli: { id: "Xenova/nli-deberta-v3-xsmall", revision: "2a4f614a701367a02d51389039afc998faeda637", sha256: "2fd05dda1dd5a078b85857dfa23b751a680d8cc621e2450ea6d50d028eaaf104", maxLen: 512 },
} as const;
export type RerankModelName = keyof typeof RERANK_MODELS;
const NLI_CONTRADICTION = 0; // config.json id2label: 0 contradiction, 1 entailment, 2 neutral

export const rerankFilesPresent = (name: RerankModelName) => existsSync(path.join(MODELS_DIR, RERANK_MODELS[name].id, "onnx", "model.onnx"));

export type PairResult = { score: number; windows: number }; // ce: max logit; nli: max P(contradiction)
export type Reranker = {
  name: RerankModelName;
  // Each [first, second] input scored with first as query / premise; long inputs windowed, never truncated.
  score: (pairs: readonly [string, string][], batchSize?: number) => Promise<PairResult[]>;
  fetchAttempts: () => number;
};

export async function loadReranker(name: RerankModelName): Promise<Reranker> {
  const spec = RERANK_MODELS[name];
  const dir = path.join(MODELS_DIR, spec.id);
  if (!rerankFilesPresent(name)) throw new Error(`model files missing under ${dir}`);
  if (readFileSync(path.join(dir, "REVISION"), "utf8").trim() !== spec.revision) throw new Error(`${spec.id}: files are not the pinned revision`);
  if (createHash("sha256").update(readFileSync(path.join(dir, "onnx", "model.onnx"))).digest("hex") !== spec.sha256) throw new Error(`${spec.id}: model.onnx does not match the pinned SHA-256`);
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_DIR;
  env.useFSCache = false;
  let attempts = 0;
  env.fetch = async (input: string | URL) => { attempts++; throw new Error(`network access refused: ${String(input)}`); };
  const tokenizer = await AutoTokenizer.from_pretrained(spec.id, { local_files_only: true });
  const model = await AutoModelForSequenceClassification.from_pretrained(spec.id, { local_files_only: true, dtype: "fp32", revision: spec.revision });
  const special = tokenizer.encode("", { add_special_tokens: true });
  const [cls, sep] = [special[0], special.at(-1)!];
  const tokenize = (t: string) => tokenizer.encode(t, { add_special_tokens: false });

  async function run(inputs: [number[], number[]][]): Promise<number[]> {
    const len = Math.max(...inputs.map(([a, b]) => a.length + b.length)) + 3;
    const ids = new BigInt64Array(inputs.length * len), mask = new BigInt64Array(ids.length), types = new BigInt64Array(ids.length);
    inputs.forEach(([a, b], i) => {
      const seq = [cls, ...a, sep, ...b, sep];
      seq.forEach((id, t) => { ids[i * len + t] = BigInt(id); mask[i * len + t] = 1n; if (t > a.length + 1) types[i * len + t] = 1n; });
    });
    const shape = [inputs.length, len];
    const out = await model({ input_ids: new Tensor("int64", ids, shape), attention_mask: new Tensor("int64", mask, shape), token_type_ids: new Tensor("int64", types, shape) });
    const logits = out.logits as Tensor;
    const width = logits.dims[1];
    const data = logits.data as Float32Array;
    return inputs.map((_, i) => (name === "ce" ? data[i * width] : softmax(Array.from(data.subarray(i * width, (i + 1) * width)))[NLI_CONTRADICTION]));
  }

  async function score(pairs: readonly [string, string][], batchSize = 32): Promise<PairResult[]> {
    const tokens = new Map<string, number[]>();
    const tok = (t: string) => tokens.get(t) ?? tokens.set(t, tokenize(t)).get(t)!;
    const flat = pairs.flatMap(([x, y], p) => pairWindows(tok(x), tok(y), spec.maxLen).map((w) => ({ p, w })));
    const order = flat.map((_, k) => k).sort((x, y) => flat[x].w[0].length + flat[x].w[1].length - flat[y].w[0].length - flat[y].w[1].length);
    const s = new Array<number>(flat.length);
    for (let i = 0; i < order.length; i += batchSize) {
      const batch = order.slice(i, i + batchSize);
      (await run(batch.map((k) => flat[k].w))).forEach((v, j) => { s[batch[j]] = v; });
    }
    const out = pairs.map(() => ({ score: -Infinity, windows: 0 }));
    flat.forEach(({ p }, k) => { out[p].score = Math.max(out[p].score, s[k]); out[p].windows++; });
    return out;
  }

  return { name, score, fetchAttempts: () => attempts };
}
