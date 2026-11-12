# @qarmiqai/ci

Ask [Qarmiq](https://qarmiq.ai) to test from your CI pipeline, and act on its answer.

A Qarmiq **CI trigger** runs one collection of scenarios on one of your project's environments and answers:

| Verdict | Meaning | Exit code |
|---|---|---|
| `go` | every scenario passed | `0` |
| `stop` | a scenario failed | `1` |
| `review` | a scenario could not be decided, or the run did not finish in time; allowed, and a person should look | `0` (or `1` with `--on-review fail`) |

What happens next (merge, promote to production, notify) is your pipeline's decision. Qarmiq tests and reports; it never sees your code.

## Set up

1. In Qarmiq, open **Settings → CI** for your project and make a trigger: a collection, an environment, the device and browsers.
2. Copy the token it shows once, and add it to your CI's secrets as `QARMIQ_CI_TOKEN`.
3. Add one step after your deploy:

```sh
npx @qarmiqai/ci run --trigger <trigger id>
```

The step starts the trigger's run, waits for it, prints each scenario's result with a link to the run in Qarmiq, and exits by the verdict.

On **GitHub Actions**, **GitLab CI** and **Bitbucket Pipelines** the commit, branch, pull request and pipeline link are read from the CI's own variables. Anywhere else, pass them with `--sha`, `--ref` and the `--source-*` options.

### GitHub Actions

Use the action. It does what the CLI does, and also reports a **check** on the commit (neutral, not red, for `review`), keeps **one comment** on the pull request up to date, writes the job summary, and sets the outputs `verdict`, `run-url` and `run-key`.

```yaml
jobs:
  qarmiq:
    runs-on: ubuntu-latest
    needs: deploy-staging
    permissions:
      contents: read
      checks: write          # the check on the commit
      pull-requests: write   # the comment on the pull request
    steps:
      - uses: qarmiqai/ci/github-action@v1
        with:
          token: ${{ secrets.QARMIQ_CI_TOKEN }}
          trigger: <trigger id>
```

| Input | Default | |
|---|---|---|
| `token` | | The trigger's token, from a secret. Required. |
| `trigger` | | The trigger's id. Required. |
| `qarmiq-url` | `https://app.qarmiq.ai` | The Qarmiq origin. |
| `environment` | the trigger's | Another of the project's saved environments. |
| `rerun` | `false` | A fresh run even if this commit was already started. |
| `on-review` | `neutral` | `fail` to fail the job on `review`. |
| `comment` | `true` | `false` for no pull request comment. |
| `check-name` | `Qarmiq` | The check's name, e.g. for a required status check. |

On a pull request, the commit tested and reported on is the one the author pushed, not the merge commit GitHub makes. Without `checks: write` or `pull-requests: write` the action says so in a warning and carries on; the verdict still decides the step. To gate a merge on it, mark the check as required in branch protection.

The action is a thin layer over this package, bundled in `github-action/dist`, so there is nothing to install.

### GitLab CI

```yaml
qarmiq:
  stage: test
  image: node:22
  script:
    - npx @qarmiqai/ci run --trigger <trigger id>
```

with `QARMIQ_CI_TOKEN` as a masked CI/CD variable.

## Options

```
qarmiq-ci run --trigger <id> [options]

  --environment <name>     test another of the project's saved environments than the trigger's own
  --sha <commit>           the commit being tested (read from the CI when it can be)
  --ref <branch>           the branch or tag (read from the CI when it can be)
  --rerun                  start a fresh run even if this commit was already started
  --on-review allow|fail   what "review" does to the exit code; allow by default
  --wait <seconds>         how long each status read is held open; 25 by default
  --source-repo <repo>  --source-pr <n>  --source-url <url>  --source-provider <name>  --source-actor <who>

  QARMIQ_CI_TOKEN   the trigger's token (required)
  QARMIQ_URL        the Qarmiq origin (default https://app.qarmiq.ai)
```

Exit code `2` means the step could not run: a missing token, bad options, or a refusal from Qarmiq, printed with its reason (for example a project's monthly limit of CI runs, with when to try again).

## Behaviour worth knowing

- **The same commit is not tested twice.** Starting a trigger again for a commit it already started, on the same environment, answers with that run. Pass `--rerun` for a fresh one.
- **A newer push replaces an older one.** Starting a trigger for a branch that already has a run in flight cancels the older run.
- **Cancelling the job cancels the run.** When the CI job is stopped, the run in Qarmiq is cancelled too.
- **A run never waits for ever.** Each trigger has its own maximum wait; a run still going past it is ended and answers `review`.

## Use it as a library

```ts
import { QarmiqCiClient, runTrigger, exitCodeFor } from "@qarmiqai/ci";

const client = new QarmiqCiClient({ baseUrl: "https://app.qarmiq.ai", token: process.env.QARMIQ_CI_TOKEN! });
const { status } = await runTrigger(client, { triggerId: "<trigger id>", request: { sha, ref } });
process.exit(exitCodeFor(status));
```

## The HTTP contract

Three calls, all with `Authorization: Bearer <token>`:

- `POST /api/ci/triggers/{trigger}/runs` with `{ sha?, ref?, environment?, rerun?, source? }` starts a run and answers its `status_url`.
- `GET /api/ci/runs/{run}?wait=<seconds>` answers its state, verdict and scenarios, held open while it runs.
- `DELETE /api/ci/runs/{run}` cancels it.

## License

MIT
