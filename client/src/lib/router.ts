// Hash routes, so the app needs no router library and works behind any static host:
//   #/                          cases
//   #/cases/:id                 one case: its depositions, a new check, and its reports
//   #/analyses/:id              a report: one comparison and its findings
//   #/analyses/:id/findings/:f  one finding: both passages side by side
//   #/help                      how to read the results

import { useEffect, useState } from "react";

export type Route =
  | { name: "cases" }
  | { name: "case"; id: number }
  | { name: "analysis"; id: number; findingId: number | null }
  | { name: "help" }
  | { name: "not_found" };

const STATIC: Record<string, Route> = {
  "/": { name: "cases" },
  "/cases": { name: "cases" },
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
  cases: () => "#/",
  case: (id: number) => `#/cases/${id}`,
  analysis: (id: number, findingId?: number) => (findingId ? `#/analyses/${id}/findings/${findingId}` : `#/analyses/${id}`),
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
