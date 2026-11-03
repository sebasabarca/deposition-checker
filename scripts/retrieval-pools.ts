// Builds candidate pools (server/src/retrieve/frozen.ts) from a frozen benchmark's baseline paths plus any
// extra path files (e.g. the MiniLM path from scripts/retrieval-embed.ts), optionally dropping paths: the
// integration step whose pools scripts/retrieval-eval.ts and scripts/retrieval-triage.ts then read.
// No model or API call.
//
//   npx tsx scripts/retrieval-pools.ts --frozen <dir> --name <pool name> --out <dir under data/raw> [--extra <neighbours file>...] [--drop <path>...] [--per-item 5]

import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildPool, readJson, writeJson, type PathNeighbours } from "../server/src/retrieve/frozen";

const { values } = parseArgs({ options: { frozen: { type: "string" }, name: { type: "string" }, out: { type: "string" }, extra: { type: "string", multiple: true }, drop: { type: "string", multiple: true }, "per-item": { type: "string" } } });
if (!values.frozen || !values.name || !values.out) throw new Error("needs --frozen, --name and --out");
if (!path.resolve(values.out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out must be under data/raw/");
const baseline = readdirSync(values.frozen).filter((f) => /^neighbours-.*\.json$/.test(f)).map((f) => readJson<PathNeighbours>(path.join(values.frozen!, f)));
const paths = [...baseline, ...(values.extra ?? []).map((f) => readJson<PathNeighbours>(f))].filter((p) => !(values.drop ?? []).includes(p.path));
const pool = buildPool(values.name, paths, Number(values["per-item"] ?? 5));
mkdirSync(values.out, { recursive: true });
writeJson(path.join(values.out, `pool-${values.name}.json`), pool);
console.log(`${values.name}: ${pool.candidates.length} candidates from ${pool.paths.join(", ")}`);
