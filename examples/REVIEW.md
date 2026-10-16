---
load:
  - AGENTS.md
  - docs/ARCHITECTURE.md
  - { path: "packages/{module}/AGENTS.md", when: "packages/{module}/**" }
questions:
  - id: public-api
    ask: Does the diff change a public API (exported types, HTTP routes, CLI flags) without updating its docs and callers?
    when: ["packages/**/src/index.ts", "src/routes/**"]
  - id: data-loss
    ask: Can the change lose or corrupt stored data (migrations, deletes, overwrites without a backup path)?
  - id: tests
    ask: Does every new behavior have a test that would fail without the change?
ignore: [style, naming, formatting]
---

# How to review this repo

- A finding must point to a file and line and say what breaks for a user.
- Do not report taste, formatting, or naming.
- Prefer one clear finding over many small ones.
