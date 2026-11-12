import type { CheckConclusion } from "./report.js";

// The few GitHub REST calls the action makes, with the job's own token: one check run, created then updated, and one comment on the pull
// request, found by its marker and edited in place. Each call answers ok or the status GitHub gave, so the caller can say plainly what
// it could not do (most often a token without checks or pull-requests write) and carry on with the rest.

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

// GitHub's check run output fields are capped; past it the call fails. The summary is cut well inside it, with a note.
const MAX_OUTPUT_CHARS = 60_000;
// The most pages of comments read looking for the action's own one: a long-running pull request's thread, not an unbounded one.
const MAX_COMMENT_PAGES = 10;

export class GitHubApi {
  constructor(
    private readonly apiUrl: string,
    private readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  createCheckRun(input: { name: string; headSha: string; detailsUrl?: string; title: string; summary: string }): Promise<ApiResult<{ id: number }>> {
    return this.call<{ id: number }>("POST", `/repos/${this.repository}/check-runs`, {
      name: input.name,
      head_sha: input.headSha,
      status: "in_progress",
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      output: output(input.title, input.summary),
    });
  }

  updateCheckRun(id: number, input: { title: string; summary: string; detailsUrl?: string; conclusion?: CheckConclusion }): Promise<ApiResult<{ id: number }>> {
    return this.call<{ id: number }>("PATCH", `/repos/${this.repository}/check-runs/${id}`, {
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      ...(input.conclusion ? { status: "completed", conclusion: input.conclusion } : { status: "in_progress" }),
      output: output(input.title, input.summary),
    });
  }

  // Edits the comment that carries `marker`, or adds one when there is none: one comment per trigger on a pull request, however many
  // pushes it sees.
  async upsertComment(issueNumber: number, marker: string, body: string): Promise<ApiResult<{ id: number; created: boolean }>> {
    const full = `${marker}\n${body}`;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const listed = await this.call<Array<{ id: number; body?: string }>>("GET", `/repos/${this.repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      if (!listed.ok) return listed;
      const mine = listed.value.find((c) => typeof c.body === "string" && c.body.startsWith(marker));
      if (mine) {
        const edited = await this.call<{ id: number }>("PATCH", `/repos/${this.repository}/issues/comments/${mine.id}`, { body: full });
        return edited.ok ? { ok: true, value: { id: edited.value.id, created: false } } : edited;
      }
      if (listed.value.length < 100) break;
    }
    const created = await this.call<{ id: number }>("POST", `/repos/${this.repository}/issues/${issueNumber}/comments`, { body: full });
    return created.ok ? { ok: true, value: { id: created.value.id, created: true } } : created;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
    }
    const text = await response.text();
    if (!response.ok) {
      let message = `GitHub answered ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // Not JSON: the status line above is the message.
      }
      return { ok: false, status: response.status, message };
    }
    return { ok: true, value: (text ? JSON.parse(text) : null) as T };
  }
}

function output(title: string, summary: string) {
  const cut = summary.length > MAX_OUTPUT_CHARS ? `${summary.slice(0, MAX_OUTPUT_CHARS)}\n\n…cut here; the full result is on the run's page in Qarmiq.` : summary;
  return { title, summary: cut };
}
