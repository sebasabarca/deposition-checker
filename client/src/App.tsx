import { AnalysesPage } from "./pages/AnalysesPage";
import { CaseRunPage } from "./pages/CaseRunPage";
import { CasePage } from "./pages/CasePage";
import { CasesPage } from "./pages/CasesPage";
import { DepositionPage } from "./pages/DepositionPage";
import { DepositionsPage } from "./pages/DepositionsPage";
import { FindingsPage } from "./pages/FindingsPage";
import { HelpPage } from "./pages/HelpPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProfilePage } from "./pages/ProfilePage";
import { useEffect, useState } from "react";
import { ForgotPage, RegisterPage, ResetPage, SignInPage, VerifyPage } from "./pages/AuthPages";
import { LandingPage } from "./pages/LandingPage";
import { UserContext } from "./lib/session";
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
  // A verification link works signed in or out; the other account pages are for signed-out visitors.
  if (route.name === "verify") return <VerifyPage token={route.token} onSignedIn={setUser} />;
  if (user === null) {
    if (route.name === "signin") return <SignInPage onSignedIn={setUser} />;
    if (route.name === "register") return <RegisterPage />;
    if (route.name === "forgot") return <ForgotPage />;
    if (route.name === "reset") return <ResetPage token={route.token} onSignedIn={setUser} />;
    return <LandingPage />;
  }
  if (["signin", "register", "forgot", "reset"].includes(route.name)) {
    window.location.hash = href.overview();
    return null;
  }
  const signOut = () => void api.signOut().finally(() => {
    setUser(null);
    window.location.hash = href.overview();
  });

  return (
    <UserContext.Provider value={user}>
    <Shell section={sectionOf(route)} user={user} onSignOut={signOut} onUser={setUser}>
      {route.name === "overview" && <OverviewPage />}
      {route.name === "cases" && <CasesPage />}
      {route.name === "case" && <CasePage key={route.id} id={route.id} />}
      {route.name === "case_run" && <CaseRunPage key={route.id} id={route.id} />}
      {route.name === "depositions" && <DepositionsPage caseId={route.caseId} />}
      {route.name === "deposition" && <DepositionPage key={route.id} id={route.id} page={route.page} q={route.q} mark={route.mark} />}
      {route.name === "findings" && <FindingsPage />}
      {route.name === "analyses" && <AnalysesPage />}
      {route.name === "help" && <HelpPage />}
      {route.name === "profile" && <ProfilePage user={user} onUser={setUser} />}
      {route.name === "not_found" && <Empty title="Page not found">Go back to the <a className="underline" href={href.overview()}>overview</a>.</Empty>}
    </Shell>
    </UserContext.Provider>
  );
}
