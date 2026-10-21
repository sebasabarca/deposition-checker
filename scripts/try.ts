import "dotenv/config";
import { parseTranscript } from "../server/src/transcript";
import { analyze } from "../server/src/analyze";
import { TRANSCRIPT_1, TRANSCRIPT_2 } from "../server/src/data/samples";

async function main() {
  const t1 = parseTranscript(TRANSCRIPT_1, "T1");
  const t2 = parseTranscript(TRANSCRIPT_2, "T2");
  const findings = await analyze(t1, t2);

  for (const f of findings) {
    const score =
      f.confidence === null ? "unverified" : `${f.confidence} (${f.band})`;
    console.log(
      `\n[${f.priority}] ${f.type.toUpperCase()}  ${f.t1_id} vs ${f.t2_id}  confidence: ${score}`,
    );
    console.log(`  T1: "${f.t1_quote}"`);
    console.log(`  T2: "${f.t2_quote}"`);
    for (const reason of f.reasons) console.log(`  - ${reason}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
