// How to use Veridict, as a short guide with its contents beside it.

import type { ReactNode } from "react";
import { Compass } from "lucide-react";
import { TranscriptRows } from "../components/FindingView";
import { useTour } from "../components/Shell";
import { Button, HumanMark, ModelMark, OcrMark, PageHeader, TestimonyMark, VerifiedMark } from "../components/ui";

const SECTIONS = [
  ["workflow", "How a review works"],
  ["reading", "Reading a finding"],
  ["categories", "Finding categories"],
  ["marks", "What each mark means"],
  ["strength", "Evidence strength"],
  ["text", "Text transcripts"],
  ["keys", "Keyboard"],
  ["data", "Your data and cost"],
] as const;

// Labelled as an example: these lines are invented for this guide and belong to no deposition.
const EXAMPLE = [
  { id: 1, ref: "11:14", text: "Q.  And where were you that morning?" },
  { id: 2, ref: "11:15", text: "A.  At the depot on Kerr Street. I got", highlighted: true },
  { id: 3, ref: "11:16", text: "there around six, like every Tuesday.", highlighted: true },
  { id: 4, ref: "11:17", text: "Q.  Did anyone see you arrive?" },
].map((l) => ({ ...l, ocrConfidence: null }));

export function HelpPage() {
  const tour = useTour();
  return (
    <>
      <PageHeader title="Help" description="How to use Veridict to find and review potential contradictions in a witness's testimony." actions={<Button onClick={tour}><Compass aria-hidden className="size-4" />Show me around</Button>} />
      <div className="grid items-start gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="lg:sticky lg:top-8">
          <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm lg:flex-col lg:border-l lg:border-line">
            {SECTIONS.map(([id, label]) => <li key={id}><a href={`#/help`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }} className="block py-1 text-muted hover:text-ink lg:-ml-px lg:border-l lg:border-transparent lg:pl-4 lg:hover:border-navy">{label}</a></li>)}
          </ol>
        </nav>

        <div className="max-w-[44rem] space-y-12 text-[15px] leading-7">
          <Section id="workflow" title="How a review works">
            <ol className="space-y-4">
              <Step n={1} title="Add the depositions">Use <strong>Add deposition</strong> in the sidebar. Upload a PDF, a .txt file, or paste the transcript. Each one is a single session of one witness, in a case. Veridict reads it into page and line references; you can read and search it from the Depositions screen.</Step>
              <Step n={2} title="Check two sessions">In the case, select two sessions of the same witness and choose <strong>Check these sessions</strong>. Veridict's analysis reads both in full and proposes places where the testimony may conflict. It takes about ten minutes. Before you start, Veridict shows an estimate of the cost from the length of the two sessions; each check has a budget it can never exceed. You can close the page while it runs.</Step>
              <Step n={3} title="Review each finding">Open the analysis. Each finding shows the two passages side by side with the cited lines highlighted. Read them, then decide: <strong>Keep</strong>, <strong>Needs context</strong> or <strong>Dismiss</strong>, with a note for the file.</Step>
              <Step n={4} title="Use what you kept">Copy the pinpoint citation from any finding. Your decisions stay with the case and carry over if the same sessions are checked again.</Step>
            </ol>
          </Section>

          <Section id="reading" title="Reading a finding">
            <p>Testimony is always shown as the transcript itself: the page and line in the margin, the words exactly as stored, and the lines the finding cites in yellow. Nothing in the transcript column is written by the model.</p>
            <figure className="overflow-hidden rounded-lg border border-line bg-sheet">
              <div className="transcript py-3"><TranscriptRows lines={EXAMPLE} /></div>
              <figcaption className="border-t border-rule px-4 py-2 text-xs text-faint">An example made up for this guide. It is not from any deposition.</figcaption>
            </figure>
            <p>Below the passages, <strong>Why the statements may conflict</strong> is Veridict's analysis, and <strong>the innocent explanation</strong> is the most plausible way both statements could be true. Read both before deciding.</p>
          </Section>

          <Section id="categories" title="Finding categories">
            <dl className="divide-y divide-rule rounded-lg border border-line bg-sheet text-[14px] leading-6">
              <Def term="Potential contradictions">Verified statements that may conflict. Worth your review, not proof of a contradiction.</Def>
              <Def term="Needs context">They may conflict, but the testimony is incomplete or qualified. Not a contradiction as it stands.</Def>
              <Def term="Compatible">Not established as conflicting. Shown so nothing is hidden.</Def>
              <Def term="Unverified">A citation, quotation or speaker check failed. Read the source before relying on it.</Def>
            </dl>
          </Section>

          <Section id="marks" title="What each mark means">
            <dl className="divide-y divide-rule rounded-lg border border-line bg-sheet text-[14px] leading-6">
              <Def term={<TestimonyMark />}>Stored transcript lines, verbatim, with their page:line.</Def>
              <Def term={<OcrMark />}>The PDF was a scanned image with no selectable text, so Veridict read the words from a picture of each page. A word can be misread now and then; lines that were hard to read are flagged. Compare with the page image before quoting.</Def>
              <Def term={<ModelMark />}>Written by Veridict's analysis, an AI system. It is not testimony and not a legal conclusion.</Def>
              <Def term={<VerifiedMark />}>Code found the cited words in the stored transcript. The citation is real; that says nothing about whether the contradiction is.</Def>
              <Def term={<HumanMark>Kept</HumanMark>}>Your decision, never the model's.</Def>
            </dl>
          </Section>

          <Section id="strength" title="Evidence strength">
            <p>Potential contradictions carry an evidence strength from 0 to 100: five equal checks on the quotations, who said them, how clearly, and whether both passages are about one subject with a conflict that holds without more context. It is calculated by code from fixed checks, not by the analysis. It is not a probability that the witness contradicted themselves, and it sets neither the category nor the priority.</p>
          </Section>

          <Section id="text" title="Text transcripts">
            <p>A text transcript with page and line numbers keeps them, so findings cite it like a PDF. Text without numbers is still accepted: findings cite the line of the text (“Line 240”), which is not an official citation, and they are held at Needs context until you check them against the certified transcript.</p>
          </Section>

          <Section id="keys" title="Keyboard">
            <dl className="divide-y divide-rule rounded-lg border border-line bg-sheet text-[14px] leading-6">
              <Def term={<Key>j</Key>}>Next finding in the analysis.</Def>
              <Def term={<Key>k</Key>}>Previous finding.</Def>
            </dl>
          </Section>

          <Section id="data" title="Your data and cost">
            <p>Files and results are stored by the server running Veridict. A check sends the text of both sessions to the AI model that powers Veridict's analysis; nothing is sent until you start one. Example analyses make no model calls. Every check shows what it cost.</p>
            <p>Veridict makes no certification or compliance claim. A qualified person must confirm any use of a finding.</p>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8 space-y-4">
      <h2 id={`${id}-title`} className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3">
      <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-navy font-serif text-sm font-semibold text-white">{n}</span>
      <div><p className="font-semibold">{title}</p><p className="text-muted">{children}</p></div>
    </li>
  );
}

function Def({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="font-semibold">{term}</dt>
      <dd className="text-muted">{children}</dd>
    </div>
  );
}

const Key = ({ children }: { children: ReactNode }) => <kbd className="inline-flex size-6 items-center justify-center rounded border border-control bg-well font-mono text-xs">{children}</kbd>;
