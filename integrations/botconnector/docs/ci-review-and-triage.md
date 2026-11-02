# CI review and triage lanes

Two bots run against pull requests: a reviewer and a triage agent. This note records how each one is triggered, what it needs to post, and how to tell a run that did nothing from a run that worked.

## Entry points

The review workflow listens on four events. They are not equivalent:

| Entry point | Trigger | Usable here |
| --- | --- | --- |
| Automatic | pull request opened, reopened, marked ready, or updated | yes |
| Review request | a review is requested from the bot account | no, that account is not a collaborator in this repository |
| Comment command | someone comments a slash command on the pull request | yes |
| Manual dispatch | someone runs the workflow by hand | yes |

The comment and dispatch paths both pass through a permission gate first. The gate resolves the principal — the commenter, or the dispatcher — and requires write, maintain, or admin on the repository. Any API error, or any weaker permission, is a denial: the run continues without a review rather than guessing.

## Why a green run can mean nothing ran

Two shapes of silence are easy to confuse with success:

- The gate denies, the review job is skipped, and no job fails. The run is reported as a failure with no failing job, or as a success with every job skipped, depending on how much of the graph was scheduled.
- A job that depends on a skipped job is skipped with it. The review job has conditional dependencies, so an entry point that skips one of them loses the review even when its own conditions are satisfied. Its own log says nothing, because the job never started.

When a run looks empty, read the run's job list before reading logs. A missing job is a different defect from a failing one, and the two need different fixes.

## Reading a failure

Step summaries and `::error::` annotations do not appear in the run log. They land as check-run annotations, which is where the gate records the reason it denied:

```bash
gh api repos/<owner>/<repo>/check-runs/<job-id>/annotations
```

## Triggering by hand

A comment on the pull request, with the command as the first thing in the body:

```
@qwen-code /review
```

Or a dispatch, for a review that should not wait for a comment:

```bash
gh workflow run qwen-code-pr-review.yml \
  -f pr_number=<number> -f command=review -f review_mode=comment
```

Triage runs on its own for pull request events. It posts a lifecycle comment when it starts and the result when it finishes, so silence from triage means it never started, not that it found nothing.

## What the lanes need

Both bots post as a credential that can read the repository and write issues and pull requests. That credential is a repository secret, and its absence is not an error the workflow can report clearly: the write simply fails, or the gate denies before any work starts. When a lane goes quiet after a credential rotation, check the secret's presence before reading the workflow.

Both lanes spend model tokens on every run that reaches the agent. A denied gate spends nothing, which is the reason the gate runs before the model call rather than after.
