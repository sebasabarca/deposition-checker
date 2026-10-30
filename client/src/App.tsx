import ClassicApp from "./ClassicApp";
import { AnalysisPage } from "./pages/AnalysisPage";
import { CasePage } from "./pages/CasePage";
import { CasesPage } from "./pages/CasesPage";
import { href, useRoute } from "./lib/router";
import { Empty } from "./components/ui";

export default function App() {
  const route = useRoute();
  if (route.name === "classic") return <ClassicApp />;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href={href.cases()} className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Deposition Checker</span>
            <span className="hidden text-xs text-slate-500 sm:inline">Testimony consistency review</span>
          </a>
          <nav className="flex items-center gap-4 text-sm text-slate-600">
            <a href={href.cases()} className="hover:text-slate-900">Cases</a>
            <a href={href.classic()} className="hover:text-slate-900" title="The original two-transcript analyzer">Quick compare (v1)</a>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        {route.name === "cases" && <CasesPage />}
        {route.name === "case" && <CasePage key={route.id} id={route.id} />}
        {route.name === "analysis" && <AnalysisPage key={route.id} id={route.id} findingId={route.findingId} />}
        {route.name === "not_found" && <Empty title="Page not found">Go back to the <a className="underline" href={href.cases()}>cases</a>.</Empty>}
      </main>
      <footer className="mx-auto max-w-screen-2xl px-4 pb-8 text-xs text-slate-500 sm:px-6">
        Findings are leads for review, not conclusions. Quotations are shown verbatim from the stored transcript; assessments are labelled as model interpretation.
      </footer>
    </div>
  );
}
