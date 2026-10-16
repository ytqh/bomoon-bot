# bom

## Goal

The public entrance of the bom GitHub App: the App definition, the `REVIEW.md` rules format, and (later) a GitHub Action. The review backend is a private service; nothing in this repo may depend on its code.

## Rules

- This repo is public. Never commit secrets, backend URLs other than the App's webhook, private repo names, or internal design notes.
- The `REVIEW.md` format in `docs/review-md.md` is a public contract: a change that breaks existing `REVIEW.md` files needs a version bump and Aki's review.
- `app/manifest.json` must match the live App's permissions and events; widen permissions only with Aki's review.
