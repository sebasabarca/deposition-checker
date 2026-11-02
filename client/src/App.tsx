import { AnalysisPage } from "./pages/AnalysisPage";
import { CasePage } from "./pages/CasePage";
import { CasesPage } from "./pages/CasesPage";
import { HelpPage } from "./pages/HelpPage";
import { WorkbenchPage } from "./pages/WorkbenchPage";
import { href, useRoute } from "./lib/router";
import { Empty } from "./components/ui";
import { Shell } from "./components/Shell";

export default function App() {
  const route = useRoute();
  return (
    <Shell>
      {route.name === "cases" && <CasesPage />}
      {route.name === "case" && <CasePage key={route.id} id={route.id} />}
      {route.name === "analysis" && (route.findingId === null ? <AnalysisPage key={route.id} id={route.id} /> : <WorkbenchPage key={route.findingId} analysisId={route.id} id={route.findingId} />)}
      {route.name === "help" && <HelpPage />}
      {route.name === "not_found" && <Empty title="Page not found">Go back to your <a className="underline" href={href.cases()}>cases</a>.</Empty>}
    </Shell>
  );
}
