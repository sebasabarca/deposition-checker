export type QAPair = {
  id: string;
  questions: string;
  answers: string;
};

export function parseTranscript(text: string, prefix: string): QAPair[] {
  const pairs: QAPair[] = [];
  const blocks = ("\n" + text).split(/\n\s*Q:\s*/).slice(1);
  blocks.forEach((block, index) => {
    const [question, ...rest] = block.split(/\n\s*A:\s*/);
    const answer = rest.join(" ").trim();
    if (!question.trim() || !answer) return;
    pairs.push({
      id: `${prefix}-${index + 1}`,
      questions: question.trim(),
      answers: answer,
    });
  });

  return pairs;
}
