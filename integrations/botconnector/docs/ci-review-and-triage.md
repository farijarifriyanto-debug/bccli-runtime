# CI review and triage lanes

Two bots run against pull requests: a reviewer and a triage agent. This note records how each one is triggered, what it needs in order to post, and how to tell a run that did nothing from a run that worked.

## Entry points

The review workflow listens on more than one event, and they are not equivalent:

| Entry point | Trigger | Usable here |
| --- | --- | --- |
| Automatic | pull request opened, reopened, marked ready, or updated | yes |
| Review request | a review is requested from the bot account | no, that account is not a collaborator in this repository |
| Comment command | a slash command is commented on the pull request | yes |
| Manual dispatch | the workflow is run by hand | yes |

A command can also arrive as the body of a submitted review, which the workflow treats like a comment.

The comment and dispatch paths pass through a permission gate first. The gate resolves the principal, the commenter or the dispatcher, and requires write, maintain, or admin on the repository. Any API error, or any weaker permission, is a denial.

Automatic reviews additionally pass through a job that delays them, so a pull request that is still being pushed to does not spend a review on every commit.

## Why a green run can mean nothing ran

A job whose condition is false is skipped, and a skipped job fails nothing. Depending on how much of the graph was skipped, the run can be reported as a success, or as a failure with no failing job at all. Neither reading tells you whether anything ran: check the run's job list.

Three different defects produce the same empty run, and they need different fixes:

- The gate denied, so the review was skipped by its own condition.
- A job that supplies something the review needs never produced it. The review is deliberately scheduled regardless of its dependencies' results, so a skipped dependency alone does not take it down; what it cannot survive is a value that never arrives.
- A job whose configuration cannot be evaluated is not scheduled at all. An unset variable inside a job-level expression does this: there is no job entry, no log, and no annotation, only a run that reports success.

## Reading why something was denied or skipped

Two different artefacts, and neither is the run log:

- `::error::` and `::notice::` become check-run annotations.
- Writes to the step summary appear on the job summary page.

Annotations are read with the check-run id, which is the trailing segment of a job's `check_run_url`:

```bash
gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs --jq '.jobs[] | {name, check_run_url}'
gh api repos/<owner>/<repo>/check-runs/<check-run-id>/annotations
```

A job id taken from the workflow-run URL addresses a different resource and returns `Not Found`, so it returns nothing where the denial reason was expected.

## Triggering by hand

A comment on the pull request, with the command as the first thing in the body:

```
@qwen-code /review
```

A review can be given an explicit budget. Past the budget the run stops and says so, instead of running until the job timeout:

```
@qwen-code /review --timeout=120
```

Or a dispatch, for a review that should not wait for a comment:

```bash
gh workflow run qwen-code-pr-review.yml \
  -f pr_number=<number> -f command=review -f review_mode=comment
```

Triage runs on pull request events, and can also be dispatched with the pull request number as its input.

## What the lanes need

Both bots post as a credential that can read the repository and write issues and pull requests. That credential is a repository secret.

The two lanes report a missing credential differently, and the difference matters when one goes quiet:

- Triage checks its credentials before doing any work, and skips with a notice that names what is missing. It also posts a lifecycle comment when it reaches the agent and another when it finishes, so an empty triage thread means the credential guard or an earlier condition stopped the run, and the notice says which.
- The review lane has no such check. A credential that cannot write makes the gate deny, or the posting step fail, and the review simply does not appear.

Both lanes spend model tokens only once the agent runs. The gate runs before the model call, so a denied request costs nothing.
