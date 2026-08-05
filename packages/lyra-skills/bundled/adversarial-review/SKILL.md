---
name: adversarial-review
description: Split implementation and hostile review across independent agent contexts for high-risk changes.
---

# Adversarial review

Use one implementation agent and two independent reviewer agents.

1. Give the implementer the complete contract, repository conventions, acceptance criteria, and an isolated workspace. The implementer implements; it does not review its own work.
2. Give each reviewer the same contract and the completed workspace, but separate context windows. Reviewers find correctness, security, boundary, integration, and maintainability failures. They do not implement fixes.
3. Require structured findings with file, severity (`blocker` or `warn`), violated contract, evidence, and the smallest correct remedy.
4. Return every blocker to the implementer in one batch. Re-run review only on changed risk surfaces.

Rules:

- If a workaround needs a paragraph-long comment to justify why it is acceptable, the code is wrong. Fix the code.
- Compiling is not completion. Reject stubs, placeholders, fake fallbacks, swallowed errors, no-ops, hard-coded fixtures, and `TODO` implementations.
- Review observable behavior and invariants, not formatting preferences.
- Preserve split contexts: do not leak one reviewer's hypotheses into the other before both report.
- The parent receives the final findings and disposition, not every intermediate transcript.
