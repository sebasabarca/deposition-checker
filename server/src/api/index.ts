// Public entry point of the api module: the v2 endpoints, mounted under /api by server/src/index.ts.

export { depositionRoutes, depositionView, MAX_UPLOAD_MB, type ApiDeps } from "./depositions";
export { analysisFindings, analysisRoutes, analysisView, DEFAULT_BUDGET_USD, findingDetail, MAX_BUDGET_USD, MAX_CANDIDATES } from "./analyses";
export { caseDetail, caseRoutes, caseSummaries, DEFAULT_ORG } from "./cases";
export { reportData, reportRoutes } from "./report";
export { compareFindings, findingGroup, GROUP_LABELS, SOURCE_LABELS, type FindingGroup } from "./present";
