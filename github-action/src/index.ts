import { run } from "./main.js";

// The runner sends SIGINT, then SIGTERM, to a step it is cancelling: stop waiting and cancel the run on Qarmiq, then exit by what it answers.
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

run(process.env, { signal: controller.signal })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Anything run() did not expect: said as an error annotation, so the job's log shows it, and the step fails.
    process.stdout.write(`::error::${String(error instanceof Error ? (error.stack ?? error.message) : error).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`);
    process.exitCode = 1;
  });
