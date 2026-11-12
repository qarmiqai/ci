// The wire contract of Qarmiq's CI endpoints, as the server answers them. This package knows Qarmiq only through these three calls,
// the way any pipeline would: one trigger token, no other credential, no other surface.

export type CiVerdict = "go" | "stop" | "review";
export type CiRunState = "queued" | "running" | "finished" | "cancelled" | "timed_out" | "superseded";
export type ScenarioVerdict = "passed" | "failed" | "inconclusive" | null;

// Where the run came from, as the pipeline says. Every field is optional, and Qarmiq shows each as text.
export interface RunSource {
  provider?: string;
  repo?: string;
  pr?: string;
  url?: string;
  actor?: string;
}

export interface StartRequest {
  environment?: string;
  ref?: string;
  sha?: string;
  rerun?: boolean;
  source?: RunSource;
}

export interface RunRef {
  id: string;
  key: string;
  url: string;
}

export interface StartResponse {
  run: RunRef;
  status_url: string;
  state: CiRunState;
  deduplicated: boolean;
}

export interface RunStatus {
  state: CiRunState;
  verdict: CiVerdict | null;
  reason: string | null;
  summary: { scenarios: number; passed: number; failed: number; inconclusive: number; pending: number };
  scenarios: Array<{ id: string; ref: string; statement: string; verdict: ScenarioVerdict }>;
  run: RunRef;
  started_at: string;
  finished_at: string | null;
}

// A refusal the server explained: the status it answered, its code (rate_limited, concurrency, monthly_cap, empty_collection, ...),
// its message in plain words, and when to try again if it said.
export class QarmiqRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "QarmiqRefusal";
  }
}

export const ACTIVE_STATES: ReadonlySet<CiRunState> = new Set(["queued", "running"]);
