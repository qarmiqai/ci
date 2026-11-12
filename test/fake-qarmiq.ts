import type { RunStatus, StartResponse } from "../src/types.js";

// A stand-in for Qarmiq's three CI endpoints, given to the client as its fetch: it answers from a script of responses and records every
// request, so a test can say what the server answered and check what was sent. No network.

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export function fakeQarmiq(script: { start?: Answer; statuses?: Answer[]; cancel?: Answer }) {
  const requests: Recorded[] = [];
  const statuses = [...(script.statuses ?? [])];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    let answer: Answer | undefined;
    if (method === "POST" && /\/api\/ci\/triggers\/[^/]+\/runs$/.test(url.pathname)) answer = script.start;
    else if (method === "GET" && /\/api\/ci\/runs\/[^/]+$/.test(url.pathname)) answer = statuses.length > 1 ? statuses.shift() : statuses[0];
    else if (method === "DELETE" && /\/api\/ci\/runs\/[^/]+$/.test(url.pathname)) answer = script.cancel;
    if (!answer) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  };
  return { fetch: fetchImpl, requests };
}

export const RUN = { id: "65f000000000000000000001", key: "SHOP-R12", url: "https://app.qarmiq.ai/projects/p/runs/65f000000000000000000001" };

export const started = (overrides: Partial<StartResponse> = {}): StartResponse => ({
  run: RUN,
  status_url: `https://app.qarmiq.ai/api/ci/runs/${RUN.id}`,
  state: "running",
  deduplicated: false,
  ...overrides,
});

export const status = (overrides: Partial<RunStatus> = {}): RunStatus => ({
  state: "running",
  verdict: null,
  reason: null,
  summary: { scenarios: 2, passed: 0, failed: 0, inconclusive: 0, pending: 2 },
  scenarios: [
    { id: "s1", ref: "SHOP-S1", statement: "A customer can always check out", verdict: null },
    { id: "s2", ref: "SHOP-S2", statement: "Free shipping applies over the threshold", verdict: null },
  ],
  run: RUN,
  started_at: "2026-11-12T00:00:00.000Z",
  finished_at: null,
  ...overrides,
});

export const noSleep = async () => {};
