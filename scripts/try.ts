import "dotenv/config";
import { parseTranscript } from "../server/src/transcript";
import { findCandidates } from "../server/src/claude";
import { TRANSCRIPT_1, TRANSCRIPT_2 } from "../server/src/data/samples";

async function main() {
  const t1 = parseTranscript(TRANSCRIPT_1, "T1");
  const t2 = parseTranscript(TRANSCRIPT_2, "T2");
  const results = await findCandidates(t1, t2);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
