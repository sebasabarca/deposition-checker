// Whether this server may make paid model calls.
// Whole-case runs in the app (API and worker), Fast and Economy: possible once the server has its analysis key. No
// server flag is needed, because each run already waits for the person's explicit confirmation with a spending
// limit, which the server enforces. Developer scripts keep paidCallsAllowed (ALLOW_PAID_CALLS=true per command).
export const analysisKeySet = (env: Record<string, string | undefined>) => Boolean(env.ANTHROPIC_API_KEY?.trim());
export const paidCallsAllowed = (env: NodeJS.ProcessEnv) => Boolean(env.ANTHROPIC_API_KEY) && env.ALLOW_PAID_CALLS === "true";
