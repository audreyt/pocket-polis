---
name: pocket-polis
description: Run a complete Polis-style wikisurvey round (statements, agree/disagree voting, PCA+k-means opinion clustering, consensus report) on the user's own Cloudflare account with zero servers. Use when the user wants to host a Polis conversation, deploy Pocket Polis, create or moderate a conversation, seed simulated participants, or export/analyze the anonymized vote data.
---

# Pocket Polis

Use this skill when a user wants their own Polis-style opinion survey without hosting servers.

## Required reading

Read `AGENT.md` in the repository root (https://github.com/mashbean/pocket-polis/blob/main/AGENT.md) before acting. It contains the deploy workflow, the full API table, and the safety rules.

## Workflow

1. Confirm what the user wants: (a) deploy their own instance, (b) run a conversation on an existing instance, or (c) analyze exported data.
2. For deployment: clone the repo, `npm install`, then have the **user themselves** complete `npx wrangler login` in the browser. Never ask for tokens or passwords. Run `npm run check` before `npm run deploy`, and verify `/api/health` afterwards.
3. For a new conversation: draft 5–15 seed statements with the user (single-idea, votable sentences, ≤280 chars), pick moderation mode (`autoApprove`) and data openness (`openData`), then `POST /api/conversations`. Hand the admin link (`/a/:id#token=…`) to the user privately — the token is shown once and cannot be recovered.
4. Share the participate link (`/c/:id`) and report link (`/r/:id`). Clustering appears at 4+ participants who each voted min(7, statements) times.
5. For simulations: follow `scripts/seed-demo-legislature.mjs` as the template — fictional pseudonyms only, and the conversation title/description must state it is simulated.
6. For analysis: export `votes.csv` (anonymized long format) and cross-validate with red-dwarf or the repo's `scripts/validate-opendata.ts` methodology.

## Safety limits

- Never flood someone else's deployment; only seed data on instances the user controls.
- Keep admin tokens out of logs, commits, and shared chat.
- Do not present simulated conversations as real public opinion.
