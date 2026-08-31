# polis-serverless

**A complete [Polis](https://compdemocracy.org/polis/)-style wikisurvey round — statements, agree/disagree voting, opinion clustering, consensus report — running on a single Cloudflare Worker. GitHub + Cloudflare is all you need; there is no server to maintain.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/polis-serverless)

Live site: **<https://polis.mashbean.net/en>** · Demo: [a simulated defense-procurement referendum](https://polis.mashbean.net/r/3ovoxq5c6o) with 113 fictional legislators ([how it was made](docs/demo-legislature-sim.md))

正體中文說明：[README.md](README.md)

## What it does

- **Start a conversation**: set a topic and seed statements, get three links (participate / live report / admin)
- **Participate**: anonymous voting (agree / disagree / pass), submit new statements, low-vote statements get shown first
- **Moderate**: approve or reject statements, open/close the conversation
- **Math, live**: mean imputation → PCA (power iteration, sparsity-aware projection) → k-means (silhouette picks 2–5 groups) → representative statements per group (repness + proportion tests) → group-aware consensus — computed inside the Worker
- **Report**: live opinion map (SVG), "you are here", per-group representative statements, consensus list, anonymized CSV export

## Architecture

```text
Browser (vanilla ES modules — no framework, no build step)
   │
Cloudflare Worker (routing, validation, security headers, static assets)
   │
Durable Object "Conversation" (one per conversation)
   ├─ built-in SQLite: statements / votes / participants
   └─ math pipeline (src/math/*): recomputed on change, cached
```

No KV, D1, R2, queues, or external services. Durable Object SQLite is the only database. Zero runtime dependencies. Works on the Cloudflare free plan (100k requests/day, 5 GB storage). An honest discussion of what "serverless" means here — and the alternatives considered — is in [docs/is-this-serverless.md](docs/is-this-serverless.md) (zh).

## Quick start

```bash
npm install
npm run dev        # local dev (wrangler dev)
npm run check      # tsc + vitest + wrangler deploy --dry-run
npm run deploy     # deploy to your Cloudflare account
```

Or click **Deploy to Cloudflare** above. For a custom domain, edit `env.production.routes` in `wrangler.jsonc` and run `npm run deploy:production`.

### Let an AI agent deploy it for you

Paste this to Claude Code / Cursor / any coding agent (you only complete the `wrangler login` browser step yourself):

> Follow https://github.com/mashbean/polis-serverless/blob/main/AGENT.md to deploy polis-serverless to my Cloudflare account (I will complete the wrangler login step myself), then create my first conversation via the API.

The full agent manual is [AGENT.md](AGENT.md). Claude Code users can install the skill:

```bash
npx --yes github:mashbean/polis-serverless install-skill
```

## Algorithm fidelity

The algorithms are a clean-room reimplementation from the published Polis literature ([compdemocracy.org/algorithms](https://compdemocracy.org/algorithms/), Small et al. 2021); no AGPL code is used. Validated against the official Polis open datasets (CC BY 4.0) — see [docs/validation-opendata.md](docs/validation-opendata.md): on vTaiwan UberX, Brexit, and Bowling Green the group count matches the official runs exactly, with Adjusted Rand Index 0.78–0.86 and purity 0.94–0.96; the largest dataset (225k votes, 607 statements, 2,010 participants) computes in 236 ms. Known deviations are documented in [docs/algorithm.md](docs/algorithm.md).

## Honest limitations

- **Weak sybil resistance**: participant identity is a random UUID in localStorage. Fine for communities, classrooms, and workshops with basic trust; not for adversarial public consultations — use official pol.is there.
- **Scale**: math recomputes synchronously inside a single Durable Object; designed for hundreds to low thousands of participants and hundreds of statements.
- **Not official pol.is**: no affiliation with The Computational Democracy Project; "Polis" describes the methodology.

## License

MIT ([LICENSE](LICENSE)). Official polis is AGPL-3.0; none of its code is used here.
