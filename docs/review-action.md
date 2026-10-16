# Review Action

The `review/` Action requests a bomoon-bot App review and waits for its check. It needs no checkout and never executes pull request code. Install the App on the repository first. App installation authorizes access; your workflow chooses when to request a review.

## Workflow

The Action is not yet released. Replace `<reviewed-commit-sha>` with a reviewed commit containing `review/` (or use `v1` once published). Set the repository variable `BOMOON_REVIEW_SERVICE_URL` to your **trusted HTTPS service origin**. There is no default service URL.

```yaml
name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  id-token: write
  checks: read
  pull-requests: read
jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ytqh/bomoon-bot/review@<reviewed-commit-sha>
        id: review
        with:
          service-url: ${{ vars.BOMOON_REVIEW_SERVICE_URL }}
```

Use a runner that supports Node 24 JavaScript Actions. Only `pull_request` is supported, not `pull_request_target`, manual dispatch, or arbitrary PR/SHA inputs. Fork OIDC support is not claimed: if GitHub does not provide OIDC, the Action fails explicitly. Do not widen permissions or change event types to work around that failure.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `service-url` (required) | Trusted HTTPS origin, with no path, query, fragment, or userinfo. A trailing `/` is allowed. OIDC credentials go here, so do not take this value from PR content. |
| `github-token` | Defaults to `${{ github.token }}`. Sent only to `https://api.github.com` to read checks and PRs. |

Outputs: `conclusion` (the App check's exact conclusion), `check-url` (its GitHub URL), and `head-sha` (the PR head SHA). Drafts skip before authentication with `conclusion: skipped`, an empty `check-url`, and no success claim.

- `success` and `neutral` exit successfully. **GitHub's native Action result is success for neutral**, but the App check remains neutral.
- Every other terminal App conclusion fails the Action, including `skipped`, cancellation, and timeout. A draft skip above is the only exception.
- Before emitting a terminal result, the Action verifies the check's head/App identity and re-reads the PR. A changed head, closed PR, or draft fails as stale.
- Authentication, transport, validation, and deadline errors fail without claiming a review verdict. No review text or upstream error bodies appear in runner output.

The Action waits at most about 25 minutes, with 15-second HTTP timeouts. Network failures, HTTP 429, and HTTP 5xx retry at most four attempts per request. Redirects and other HTTP errors fail without retry or credential forwarding. Existing checks may remain pending if service completion delivery fails; a runner timeout is not a successful review. This Action does not approve, merge, or change branch rules. Choose required checks separately; no ruleset change is implied.

## Service interface

This public Action is standalone; it has no backend code dependency. It obtains GitHub OIDC with audience `bomoon-bot:review`, then sends:

```http
POST /github/review
Authorization: Bearer <GitHub OIDC token>
Content-Type: application/json

{"pr":7,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

The service validates the signed GitHub context and current PR, not just those body fields. It returns HTTP 202, `Cache-Control: no-store`, and exactly:

```json
{
  "check_id": 123,
  "check_url": "https://github.com/example/project/runs/123",
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "app_id": 456
}
```

The Action polls that check through GitHub, even if the service has already completed it. Repeated POST attempts use the same workflow identity and body so the service can reuse the check.

## Local tests

With Node 24, run `node --test review/index.test.mjs`. No install, bundling, or third-party package is needed. Tests cover credentials and wire shape, terminal outcomes, stale context, retries, deadlines, and real fetch redirect/abort behavior. Deployment and live GitHub workflow verification are separate steps.
