// Hash routes, so the app needs no router library and works behind any static host:
//   #/                          cases
//   #/cases/:id                 one case
//   #/analyses/:id              an analysis and its findings
//   #/analyses/:id/findings/:f  the same, with a finding open
//   #/classic                   the v1 two-transcript analyzer

import { useEffect, useState } from "react";

export type Route =
  | { name: "cases" }
  | { name: "case"; id: number }
  | { name: "analysis"; id: number; findingId: number | null }
  | { name: "classic" }
  | { name: "not_found" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/" || path === "") return { name: "cases" };
  if (path === "/classic") return { name: "classic" };
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
  classic: () => "#/classic",
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
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
