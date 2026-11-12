import { describe, expect, it } from "vitest";
import { QarmiqCiClient } from "../src/client.js";
import { describeStatus, exitCodeFor, runTrigger } from "../src/run.js";
import { QarmiqRefusal } from "../src/types.js";
import { RUN, fakeQarmiq, noSleep, started, status } from "./fake-qarmiq.js";

const client = (fetchImpl: typeof fetch) => new QarmiqCiClient({ baseUrl: "https://app.qarmiq.ai/", token: "qt_abc", fetch: fetchImpl });

describe("QarmiqCiClient", () => {
  it("sends the token as a bearer header and the start as JSON, to the trigger's own path", async () => {
    const q = fakeQarmiq({ start: { status: 201, body: started() } });
    await client(q.fetch).start("trig/1", { sha: "abc1234", ref: "main" });
    const [req] = q.requests;
    expect(req!.method).toBe("POST");
    expect(req!.url.toString()).toBe("https://app.qarmiq.ai/api/ci/triggers/trig%2F1/runs");
    expect(req!.headers.get("authorization")).toBe("Bearer qt_abc");
    expect(req!.headers.get("content-type")).toBe("application/json");
    expect(req!.body).toEqual({ sha: "abc1234", ref: "main" });
  });

  it("asks the server to hold a status read open only when a wait is given", async () => {
    const q = fakeQarmiq({ statuses: [{ status: 200, body: status() }] });
    await client(q.fetch).status(RUN.id, 25);
    await client(q.fetch).status(RUN.id);
    expect(q.requests.map((r) => r.url.search)).toEqual(["?wait=25", ""]);
  });

  it("turns an explained refusal into its code, message and retry time; a plain one into its message", async () => {
    const limited = fakeQarmiq({ start: { status: 429, body: { error: "monthly_cap", message: "This project has started 500 CI runs this month.", retry_after: 3600 } } });
    const refusal = await client(limited.fetch).start("t").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(QarmiqRefusal);
    expect(refusal).toMatchObject({ status: 429, code: "monthly_cap", message: "This project has started 500 CI runs this month.", retryAfterSeconds: 3600 });

    const plain = fakeQarmiq({ start: { status: 401, body: { error: "Unauthorized" } } });
    expect(await client(plain.fetch).start("t").catch((e: unknown) => e)).toMatchObject({ status: 401, code: "unauthorized", message: "Unauthorized" });

    const header = fakeQarmiq({ start: { status: 429, body: { error: "Too many requests" }, headers: { "retry-after": "60" } } });
    expect(await client(header.fetch).start("t").catch((e: unknown) => e)).toMatchObject({ retryAfterSeconds: 60 });

    const notJson = fakeQarmiq({ start: { status: 502 } });
    expect(await client(notJson.fetch).start("t").catch((e: unknown) => e)).toMatchObject({ status: 502, code: "http_502", message: "Qarmiq answered 502" });
  });
});

describe("runTrigger", () => {
  it("starts, reads until the run is over, and hands back the final status", async () => {
    const seen: string[] = [];
    const q = fakeQarmiq({
      start: { status: 201, body: started() },
      statuses: [{ status: 200, body: status() }, { status: 200, body: status({ state: "finished", verdict: "go", reason: "all 2 scenarios passed" }) }],
    });
    const { status: final } = await runTrigger(client(q.fetch), { triggerId: "t", sleep: noSleep, onStatus: (s) => { seen.push(s.state); } });
    expect(final.verdict).toBe("go");
    expect(seen).toEqual(["running", "finished"]);
    expect(q.requests.map((r) => r.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("keeps waiting through a few failed reads, and gives up after five in a row", async () => {
    const flaky = fakeQarmiq({
      start: { status: 201, body: started() },
      statuses: [new Error("socket hang up"), { status: 503 }, { status: 200, body: status({ state: "finished", verdict: "stop" }) }],
    });
    expect((await runTrigger(client(flaky.fetch), { triggerId: "t", sleep: noSleep })).status.verdict).toBe("stop");

    const down = fakeQarmiq({ start: { status: 201, body: started() }, statuses: [new Error("socket hang up")] });
    await expect(runTrigger(client(down.fetch), { triggerId: "t", sleep: noSleep })).rejects.toThrow("socket hang up");
    expect(down.requests.filter((r) => r.method === "GET")).toHaveLength(5);
  });

  it("does not ask again when the server refused for a reason that will not change", async () => {
    const revoked = fakeQarmiq({ start: { status: 201, body: started() }, statuses: [{ status: 401, body: { error: "Unauthorized" } }] });
    await expect(runTrigger(client(revoked.fetch), { triggerId: "t", sleep: noSleep })).rejects.toMatchObject({ code: "unauthorized" });
    expect(revoked.requests.filter((r) => r.method === "GET")).toHaveLength(1);
  });

  it("cancels the run on the server when the pipeline stops waiting", async () => {
    const controller = new AbortController();
    const q = fakeQarmiq({
      start: { status: 201, body: started() },
      statuses: [{ status: 200, body: status() }],
      cancel: { status: 200, body: status({ state: "cancelled", reason: "Cancelled by the CI pipeline." }) },
    });
    const outcome = await runTrigger(client(q.fetch), { triggerId: "t", sleep: noSleep, onStatus: (s) => { if (s.state === "running") controller.abort(); }, signal: controller.signal });
    expect(outcome.status.state).toBe("cancelled");
    expect(q.requests.at(-1)!.method).toBe("DELETE");
  });
});

describe("exitCodeFor", () => {
  it("go passes, stop fails, review passes unless asked to fail, and a run with no verdict never passes", () => {
    expect(exitCodeFor(status({ state: "finished", verdict: "go" }))).toBe(0);
    expect(exitCodeFor(status({ state: "finished", verdict: "stop" }))).toBe(1);
    expect(exitCodeFor(status({ state: "finished", verdict: "review" }))).toBe(0);
    expect(exitCodeFor(status({ state: "finished", verdict: "review" }), "fail")).toBe(1);
    expect(exitCodeFor(status({ state: "cancelled", verdict: null }))).toBe(1);
    expect(exitCodeFor(status({ state: "superseded", verdict: null }))).toBe(1);
  });
});

describe("describeStatus", () => {
  it("says the verdict, each scenario and the run's page", () => {
    const text = describeStatus(
      status({
        state: "finished",
        verdict: "stop",
        reason: "1 of 2 scenarios failed",
        scenarios: [
          { id: "s1", ref: "SHOP-S1", statement: "A customer can always check out", verdict: "passed" },
          { id: "s2", ref: "SHOP-S2", statement: "Free shipping applies over the threshold", verdict: "failed" },
        ],
      }),
    );
    expect(text.split("\n")).toEqual([
      "stop: 1 of 2 scenarios failed",
      "  passed       SHOP-S1  A customer can always check out",
      "  failed       SHOP-S2  Free shipping applies over the threshold",
      `Run: ${RUN.url}`,
    ]);
  });
});
