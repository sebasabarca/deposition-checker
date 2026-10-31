// Hash routes, so the app needs no router library and works behind any static host:
//   #/                          dashboard
//   #/cases                     cases
//   #/cases/:id                 one case: its depositions and analyses
//   #/depositions               the depositions of the most recent case
//   #/analyses                  every analysis
//   #/analyses/:id              an analysis and its findings
//   #/analyses/:id/findings/:f  the evidence-review workbench for one finding
//   #/findings                  every finding
//   #/review                    findings without a human decision
//   #/help                      how to read the results

import { useEffect, useState } from "react";

export type Route =
  | { name: "dashboard" }
  | { name: "cases" }
  | { name: "case"; id: number }
  | { name: "depositions" }
  | { name: "analyses" }
  | { name: "analysis"; id: number; findingId: number | null }
  | { name: "findings" }
  | { name: "review" }
  | { name: "help" }
  | { name: "not_found" };

const STATIC: Record<string, Route> = {
  "/": { name: "dashboard" },
  "/cases": { name: "cases" },
  "/depositions": { name: "depositions" },
  "/analyses": { name: "analyses" },
  "/findings": { name: "findings" },
  "/review": { name: "review" },
  "/help": { name: "help" },
};

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (STATIC[path]) return STATIC[path];
  let m = path.match(/^\/cases\/(\d+)$/);
  if (m) return { name: "case", id: Number(m[1]) };
  m = path.match(/^\/analyses\/(\d+)(?:\/findings\/(\d+))?$/);
  if (m) return { name: "analysis", id: Number(m[1]), findingId: m[2] ? Number(m[2]) : null };
  return { name: "not_found" };
}

export const href = {
  dashboard: () => "#/",
  cases: () => "#/cases",
  case: (id: number) => `#/cases/${id}`,
  depositions: () => "#/depositions",
  analyses: () => "#/analyses",
  analysis: (id: number, findingId?: number) => (findingId ? `#/analyses/${id}/findings/${findingId}` : `#/analyses/${id}`),
  findings: () => "#/findings",
  review: () => "#/review",
  help: () => "#/help",
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

// Re-runs `load` every `ms` while `active` is true: for analyses still running.
export function usePoll(active: boolean, ms: number, load: () => void) {
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(load, ms);
    return () => window.clearInterval(t);
  }, [active, ms, load]);
}
