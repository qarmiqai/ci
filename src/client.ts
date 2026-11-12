import { QarmiqRefusal, type RunStatus, type StartRequest, type StartResponse } from "./types.js";

export interface ClientOptions {
  // The Qarmiq origin, e.g. https://app.qarmiq.ai.
  baseUrl: string;
  // The trigger's token. Read from the CI's secrets; never written into a workflow file.
  token: string;
  fetch?: typeof fetch;
}

// The three calls. A failure the server explains becomes a QarmiqRefusal with the server's own code and words; anything else (a
// network error) is thrown as it is, so the pipeline's log shows what happened.
export class QarmiqCiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async start(triggerId: string, request: StartRequest = {}): Promise<StartResponse> {
    const url = `${this.baseUrl}/api/ci/triggers/${encodeURIComponent(triggerId)}/runs`;
    return (await this.call(url, { method: "POST", body: JSON.stringify(request) })) as StartResponse;
  }

  // One read, held open on the server for up to `waitSeconds` while the run is still in flight.
  async status(runId: string, waitSeconds = 0): Promise<RunStatus> {
    const url = new URL(`${this.baseUrl}/api/ci/runs/${encodeURIComponent(runId)}`);
    if (waitSeconds > 0) url.searchParams.set("wait", String(Math.floor(waitSeconds)));
    return (await this.call(url.toString(), { method: "GET" })) as RunStatus;
  }

  async cancel(runId: string): Promise<RunStatus> {
    const url = `${this.baseUrl}/api/ci/runs/${encodeURIComponent(runId)}`;
    return (await this.call(url, { method: "DELETE" })) as RunStatus;
  }

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers({ authorization: `Bearer ${this.token}`, accept: "application/json" });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(url, { ...init, headers });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the refusal below carries the status the server answered.
      }
    }
    if (response.ok) return body;
    const explained = (body ?? {}) as { error?: unknown; message?: unknown; retry_after?: unknown };
    const fallbackCode = response.status === 401 ? "unauthorized" : response.status === 404 ? "not_found" : `http_${response.status}`;
    // A refusal with a code answers { error: code, message }; a plain one answers { error: message }.
    const hasCode = typeof explained.message === "string";
    const code = hasCode && typeof explained.error === "string" ? explained.error : fallbackCode;
    const message = hasCode ? (explained.message as string) : typeof explained.error === "string" ? explained.error : `Qarmiq answered ${response.status}`;
    const header = Number(response.headers.get("retry-after"));
    const retryAfter = typeof explained.retry_after === "number" ? explained.retry_after : Number.isFinite(header) && header > 0 ? header : null;
    throw new QarmiqRefusal(response.status, code, message, retryAfter);
  }
}
