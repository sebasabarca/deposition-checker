import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CandidatesSchema, type Candidate } from "./schema";
import type { QAPair } from "./transcript";

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const { $schema, ...OUTPUT_SCHEMA } = z.toJSONSchema(CandidatesSchema);

const SYSTEM_PROMPT = `You review two deposition transcripts from the same witness and find places where the witness's story may have changed.

Classify every candidate as one of:
- direct: the two statements explicitly say opposite things about the same fact. Example: "I was home all night" vs "I stepped out around 7".
- inferential: each statement sounds fine alone, but both cannot be true at the same time. Example: "I went to sleep at 10" vs "I was up until midnight".
- false_positive: it looks like a change, but it is only imprecise or approximate language. Example: "around 8" vs "8:05".

Rules:
- Include false positives too, so the lawyer can see what was considered and rejected.
- t1_id and t2_id must be the IDs shown in brackets, like T1-3.
- t1_quote and t2_quote must be copied word for word from the answer with that ID. Never paraphrase.
- Do not report topics that only appear in one transcript.`;

function formatPairs(pairs: QAPair[]): string {
  return pairs
    .map((p) => `[${p.id}] Q:${p.question}\nA: ${p.answer}`)
    .join("\n\n");
}

export async function findCandidates(
  t1: QAPair[],
  t2: QAPair[],
): Promise<Candidate[]> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA,
      },
    },
    messages: [
      {
        role: "user",
        content: `TRANSCRIPT 1 (earlier):\n${formatPairs(t1)}\n\nTRANSCRIPT 2 (later):\n${formatPairs(t2)}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off before it finished.");
  }

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to analyze these transcripts.");
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return any results.");
  }

  const parsed = CandidatesSchema.safeParse(JSON.parse(textBlock.text));
  if (!parsed.success) {
    throw new Error("Claude returned results in an unexpected format.");
  }

  return parsed.data.contradictions;
}
