import { AnalysesPage } from "./pages/AnalysesPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { CasePage } from "./pages/CasePage";
import { CasesPage } from "./pages/CasesPage";
import { DepositionPage } from "./pages/DepositionPage";
import { DepositionsPage } from "./pages/DepositionsPage";
import { FindingsPage } from "./pages/FindingsPage";
import { HelpPage } from "./pages/HelpPage";
import { OverviewPage } from "./pages/OverviewPage";
import { href, sectionOf, useRoute } from "./lib/router";
import { Empty } from "./components/ui";
import { Shell } from "./components/Shell";

export default function App() {
  const route = useRoute();
  return (
    <Shell section={sectionOf(route)}>
      {route.name === "overview" && <OverviewPage />}
      {route.name === "cases" && <CasesPage />}
      {route.name === "case" && <CasePage key={route.id} id={route.id} />}
      {route.name === "depositions" && <DepositionsPage caseId={route.caseId} />}
      {route.name === "deposition" && <DepositionPage key={route.id} id={route.id} page={route.page} q={route.q} />}
      {route.name === "findings" && <FindingsPage />}
      {route.name === "analyses" && <AnalysesPage />}
      {route.name === "analysis" && <AnalysisPage key={route.id} id={route.id} findingId={route.findingId} />}
      {route.name === "help" && <HelpPage />}
      {route.name === "not_found" && <Empty title="Page not found">Go back to the <a className="underline" href={href.overview()}>overview</a>.</Empty>}
    </Shell>
  );
}
