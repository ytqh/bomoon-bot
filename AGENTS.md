# bomoon-bot

## Goal

The public interface of the bomoon-bot GitHub App for pull request review. This repo owns the App definition, the `REVIEW.md` rules format, and the [Review Action](docs/review-action.md). The hosted backend is private and stays outside this repo's dependencies.

## Rules

- This repo is public. Never commit secrets, backend URLs other than the App's webhook, private repo names, or internal design notes.
- The [REVIEW.md format](docs/review-md.md) is a public contract. Breaking changes need a version bump and repository-owner review.
- `app/manifest.json` must match the live App's permissions and events. Widen permissions only with repository-owner review.
