import { ACTIVE_STATES, type RunStatus, type ScenarioVerdict } from "../../src/types.js";

// One rendering of a run for GitHub: the job summary, the check run's output and the pull request comment all show the same text, so a
// person reads the same answer wherever they look. Pure: what it is given in, Markdown out.

const VERDICT_TITLE = { go: "Go: every scenario passed", stop: "Stop: a scenario failed", review: "Review: a person should look" } as const;
// A scenario with no verdict is pending while the run goes on, and "no result" once it is over (its test ended without deciding it).
const SCENARIO_MARK: Record<Exclude<ScenarioVerdict, null> | "pending" | "none", string> = { passed: "✅ passed", failed: "❌ failed", inconclusive: "⚠️ undecided", pending: "⏳ pending", none: "➖ no result" };

// The comment's marker, per trigger, so the action finds its own comment on the pull request and edits it instead of adding another.
export const commentMarker = (triggerId: string) => `<!-- qarmiq-ci trigger:${triggerId} -->`;

// Text from Qarmiq (a scenario's statement) goes into a table cell: a pipe would end the cell, a newline the row, and GitHub renders some
// HTML, so each is neutralised.
export function cell(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function title(status: RunStatus): string {
  if (status.verdict) return VERDICT_TITLE[status.verdict];
  if (status.state === "queued" || status.state === "running") return "Testing…";
  if (status.state === "superseded") return "Replaced by a newer run";
  if (status.state === "cancelled") return "Cancelled";
  return `Ended without a verdict (${status.state})`;
}

export function renderReport(status: RunStatus, options: { triggerName?: string } = {}): string {
  const { summary } = status;
  const running = ACTIVE_STATES.has(status.state);
  const counts = [
    summary.passed ? `${summary.passed} passed` : null,
    summary.failed ? `${summary.failed} failed` : null,
    summary.inconclusive ? `${summary.inconclusive} undecided` : null,
    summary.pending ? `${summary.pending} ${running ? "pending" : "with no result"}` : null,
  ].filter(Boolean);
  const lines = [
    `### Qarmiq: ${title(status)}`,
    "",
    [status.reason ? cell(status.reason) : null, counts.length ? `${counts.join(", ")} of ${summary.scenarios}` : null].filter(Boolean).join(" · "),
    "",
    "| Result | Scenario | Promise |",
    "|---|---|---|",
    ...status.scenarios.map((s) => `| ${SCENARIO_MARK[s.verdict ?? (running ? "pending" : "none")]} | \`${cell(s.ref)}\` | ${cell(s.statement)} |`),
    "",
    `[Open ${cell(status.run.key)} in Qarmiq](${status.run.url})${options.triggerName ? ` · trigger ${cell(options.triggerName)}` : ""}`,
  ];
  return lines.join("\n");
}

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled";

// What the check run concludes. "review" is neutral unless the workflow asked for it to fail; a run that ended with no verdict is never
// a success.
export function conclusionFor(status: RunStatus, onReview: "neutral" | "fail"): CheckConclusion {
  if (status.verdict === "go") return "success";
  if (status.verdict === "stop") return "failure";
  if (status.verdict === "review") return onReview === "fail" ? "failure" : "neutral";
  if (status.state === "cancelled" || status.state === "superseded") return "cancelled";
  return "failure";
}
