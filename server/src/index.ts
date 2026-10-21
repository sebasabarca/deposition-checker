import "dotenv/config";
import express from "express";
import { z } from "zod";
import { parseTranscript } from "./transcript";
import { analyze } from "./analyze";

const app = express();
app.use(express.json({ limit: "200kb" }));

const AnalyzeRequest = z.object({
  transcript1: z.string().trim().min(1).max(50_000),
  transcript2: z.string().trim().min(1).max(50_000),
});

app.post("/api/analyze", async (req, res) => {
  const body = AnalyzeRequest.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      error:
        "Both transcripts are required and must be under 50,000 characters.",
    });
  }

  const t1 = parseTranscript(body.data.transcript1, "T1");
  const t2 = parseTranscript(body.data.transcript2, "T2");

  if (t1.length === 0 || t2.length === 0) {
    return res
      .status(400)
      .json({ error: "Each transcript needs at least one Q: and A: pair." });
  }

  try {
    const findings = await analyze(t1, t2);
    return res.status(200).json({ t1, t2, findings });
  } catch (error) {
    return res
      .status(502)
      .json({ error: "The analysis failed. Please try again." });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
