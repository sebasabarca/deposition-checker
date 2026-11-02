import { AnalysesPage } from "./pages/AnalysesPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { CasePage } from "./pages/CasePage";
import { CasesPage } from "./pages/CasesPage";
import { DepositionPage } from "./pages/DepositionPage";
import { DepositionsPage } from "./pages/DepositionsPage";
import { FindingsPage } from "./pages/FindingsPage";
import { HelpPage } from "./pages/HelpPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ReportPage } from "./pages/ReportPage";
import { useEffect, useState } from "react";
import { SignInPage } from "./pages/SignInPage";
import { api, SIGNED_OUT, type User } from "./lib/api";
import { href, sectionOf, useRoute } from "./lib/router";
import { Empty } from "./components/ui";
import { Shell } from "./components/Shell";

export default function App() {
  const route = useRoute();
  // undefined while the session is being checked; null when signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
    const out = () => setUser(null);
    window.addEventListener(SIGNED_OUT, out);
    return () => window.removeEventListener(SIGNED_OUT, out);
  }, []);
  if (user === undefined) return null;
  if (user === null) return <SignInPage onSignedIn={setUser} />;
  const signOut = () => void api.signOut().finally(() => setUser(null));

  return (
    <Shell section={sectionOf(route)} user={user} onSignOut={signOut}>
      {route.name === "overview" && <OverviewPage />}
      {route.name === "cases" && <CasesPage />}
      {route.name === "case" && <CasePage key={route.id} id={route.id} />}
      {route.name === "report" && <ReportPage key={route.id} id={route.id} />}
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
