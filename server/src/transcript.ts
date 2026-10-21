export type QAPair = {
  id: string;
  question: string;
  answer: string;
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
      question: question.trim(),
      answer: answer,
    });
  });

  return pairs;
}
