import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunStatus } from "../../src/types.js";
import { started } from "../fake-qarmiq.js";

// Qarmiq and GitHub's REST API behind one fetch, for the action's tests: Qarmiq answers from a script of statuses; GitHub keeps check runs
// and comments in memory, or refuses as a token without the permission would. Plus the runner's files (outputs, summary, event).

export interface World {
  fetch: typeof fetch;
  checks: Array<{ id: number; name: string; head_sha: string; status: string; conclusion?: string; output: { title: string; summary: string }; details_url?: string }>;
  comments: Array<{ id: number; issue: number; body: string }>;
  qarmiqRequests: Array<{ method: string; url: URL; body: unknown }>;
  env: Record<string, string>;
  log: string[];
  outputs: () => string;
  summary: () => string;
}

export function fakeWorld(options: {
  statuses: RunStatus[];
  startStatus?: number;
  startBody?: unknown;
  checksForbidden?: boolean;
  commentsForbidden?: boolean;
  pullRequest?: { number: number; headSha: string; headRef: string };
  existingComments?: Array<{ id: number; issue: number; body: string }>;
  inputs?: Record<string, string>;
}): World {
  const statuses = [...options.statuses];
  const checks: World["checks"] = [];
  const comments: World["comments"] = [...(options.existingComments ?? [])];
  const qarmiqRequests: World["qarmiqRequests"] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.origin === "https://qarmiq.test") {
      qarmiqRequests.push({ method, url, body });
      if (method === "POST") return json(options.startStatus ?? 201, options.startBody ?? started());
      if (method === "GET") return json(200, statuses.length > 1 ? statuses.shift() : statuses[0]);
      if (method === "DELETE") return json(200, { ...statuses[0], state: "cancelled" });
    }
    if (url.origin === "https://api.github.test") {
      const path = url.pathname;
      if (path === "/repos/acme/shop/check-runs" && method === "POST") {
        if (options.checksForbidden) return json(403, { message: "Resource not accessible by integration" });
        const check = { id: checks.length + 1, ...body };
        checks.push(check);
        return json(201, check);
      }
      const checkMatch = path.match(/^\/repos\/acme\/shop\/check-runs\/(\d+)$/);
      if (checkMatch && method === "PATCH") {
        const check = checks.find((c) => c.id === Number(checkMatch[1]));
        if (!check) return json(404, { message: "Not Found" });
        Object.assign(check, body);
        return json(200, check);
      }
      const listMatch = path.match(/^\/repos\/acme\/shop\/issues\/(\d+)\/comments$/);
      if (listMatch && method === "GET") {
        if (options.commentsForbidden) return json(403, { message: "Resource not accessible by integration" });
        return json(200, comments.filter((c) => c.issue === Number(listMatch[1])).map(({ id, body }) => ({ id, body })));
      }
      if (listMatch && method === "POST") {
        const created = { id: 1000 + comments.length, issue: Number(listMatch[1]), body: body.body as string };
        comments.push(created);
        return json(201, created);
      }
      const editMatch = path.match(/^\/repos\/acme\/shop\/issues\/comments\/(\d+)$/);
      if (editMatch && method === "PATCH") {
        const existing = comments.find((c) => c.id === Number(editMatch[1]));
        if (!existing) return json(404, { message: "Not Found" });
        existing.body = body.body;
        return json(200, existing);
      }
    }
    return json(404, { message: `no route for ${method} ${url}` });
  };

  const dir = mkdtempSync(join(tmpdir(), "qarmiq-action-"));
  const outputFile = join(dir, "output");
  const summaryFile = join(dir, "summary");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const env: Record<string, string> = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "77",
    GITHUB_SHA: "merge000000000000000000000000000000000000",
    GITHUB_REF_NAME: "main",
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_TOKEN: "qt_deadbeef_secret",
    INPUT_TRIGGER: "trig1",
    "INPUT_QARMIQ-URL": "https://qarmiq.test",
    "INPUT_ON-REVIEW": "neutral",
    INPUT_COMMENT: "true",
    "INPUT_CHECK-NAME": "Qarmiq",
    "INPUT_GITHUB-TOKEN": "ghs_job",
    ...Object.fromEntries(Object.entries(options.inputs ?? {}).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
  if (options.pullRequest) {
    const eventFile = join(dir, "event.json");
    writeFileSync(eventFile, JSON.stringify({ pull_request: { number: options.pullRequest.number, head: { sha: options.pullRequest.headSha, ref: options.pullRequest.headRef } } }));
    env.GITHUB_EVENT_PATH = eventFile;
  }
  return {
    fetch: fetchImpl,
    checks,
    comments,
    qarmiqRequests,
    env,
    log: [],
    outputs: () => readFileSync(outputFile, "utf8"),
    summary: () => readFileSync(summaryFile, "utf8"),
  };
}
