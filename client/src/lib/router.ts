// Hash routes, so the app needs no router library and works behind any static host:
//   #/                          overview: what needs the reviewer now
//   #/cases, #/cases/:id        cases, and one case; #/cases/:id/report its kept findings, to print
//   #/depositions[?case=]       every deposition, filtered by case; #/depositions/:id[?page=&q=] one, readable
//   #/findings                  every finding across cases
//   #/analyses, #/analyses/:id  every analysis; one, with its findings beside the selected one
//   #/analyses/:id/findings/:f  the same analysis with finding f open
//   #/help                      how to use Veridict

import { useEffect, useState } from "react";

export type Route =
  | { name: "overview" }
  | { name: "cases" }
  | { name: "case"; id: number }
  | { name: "report"; id: number }
  | { name: "depositions"; caseId: number | null }
  | { name: "deposition"; id: number; page: number | null; q: string }
  | { name: "findings" }
  | { name: "analyses" }
  | { name: "analysis"; id: number; findingId: number | null }
  | { name: "help" }
  | { name: "not_found" };

export type Section = "overview" | "cases" | "depositions" | "findings" | "analyses" | "help";

const STATIC: Record<string, Route> = {
  "/": { name: "overview" },
  "/cases": { name: "cases" },
  "/findings": { name: "findings" },
  "/analyses": { name: "analyses" },
  "/help": { name: "help" },
};

export function parseRoute(hash: string): Route {
  const [path = "/", search = ""] = (hash.replace(/^#/, "") || "/").split("?");
  const q = new URLSearchParams(search);
  const num = (k: string) => (/^\d+$/.test(q.get(k) ?? "") ? Number(q.get(k)) : null);
  if (STATIC[path]) return STATIC[path];
  if (path === "/depositions") return { name: "depositions", caseId: num("case") };
  let m = path.match(/^\/cases\/(\d+)$/);
  if (m) return { name: "case", id: Number(m[1]) };
  m = path.match(/^\/cases\/(\d+)\/report$/);
  if (m) return { name: "report", id: Number(m[1]) };
  m = path.match(/^\/depositions\/(\d+)$/);
  if (m) return { name: "deposition", id: Number(m[1]), page: num("page"), q: q.get("q") ?? "" };
  m = path.match(/^\/analyses\/(\d+)(?:\/findings\/(\d+))?$/);
  if (m) return { name: "analysis", id: Number(m[1]), findingId: m[2] ? Number(m[2]) : null };
  return { name: "not_found" };
}

export const sectionOf = (r: Route): Section | null =>
  ({ overview: "overview", cases: "cases", case: "cases", report: "cases", depositions: "depositions", deposition: "depositions", findings: "findings", analyses: "analyses", analysis: "analyses", help: "help", not_found: null } as const)[r.name];

const withQuery = (path: string, q: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();
  return s ? `${path}?${s}` : path;
};

export const href = {
  overview: () => "#/",
  cases: () => "#/cases",
  case: (id: number) => `#/cases/${id}`,
  report: (caseId: number) => `#/cases/${caseId}/report`,
  depositions: (caseId?: number | null) => withQuery("#/depositions", { case: caseId }),
  deposition: (id: number, at?: { page?: number | null; q?: string }) => withQuery(`#/depositions/${id}`, { page: at?.page, q: at?.q }),
  findings: () => "#/findings",
  analyses: () => "#/analyses",
  analysis: (id: number, findingId?: number) => (findingId ? `#/analyses/${id}/findings/${findingId}` : `#/analyses/${id}`),
  help: () => "#/help",
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      const next = parseRoute(window.location.hash);
      setRoute((prev) => {
        // Moving between findings of one analysis keeps the list where it was.
        const sameAnalysis = prev.name === "analysis" && next.name === "analysis" && prev.id === next.id;
        const samePage = prev.name === next.name && (prev.name === "deposition" || prev.name === "depositions");
        if (!sameAnalysis && !samePage) window.scrollTo(0, 0);
        return next;
      });
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
