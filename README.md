# helix_price

Auto-updated pricing table for the [Helix](https://github.com/Swanand66/helix) browser extension.

The extension fetches `prices.json` from this repo once per day to keep token costs current. That way, when a provider changes their rates, users get the update within 24 hours without any extension re-publish.

## What's in here

| File | Purpose |
|---|---|
| [`prices.json`](prices.json) | The pricing table the extension consumes. USD per 1M tokens. |
| [`scripts/scrape-prices.mjs`](scripts/scrape-prices.mjs) | Node script that regenerates `prices.json` from LiteLLM's community-maintained pricing data. |
| [`.github/workflows/update-prices.yml`](.github/workflows/update-prices.yml) | Daily GitHub Action (06:00 UTC) that runs the scraper and commits any diff. |

## The refresh loop

```
provider changes price
        ↓
LiteLLM's community JSON updates (usually within hours)
        ↓
GitHub Action here runs at 06:00 UTC
        ↓
scrape-prices.mjs fetches upstream, transforms, writes prices.json
        ↓
git diff → commit + push (only if something changed)
        ↓
every user's extension picks it up on its next 24h refresh
```

Zero manual work. Zero re-publishing the extension.

## Schema

```jsonc
{
  "$comment":  "human-readable description",
  "$version":  "2026-07-18",           // date of last refresh
  "$source":   "LiteLLM community pricing (auto-refreshed daily)",
  "$upstream": "https://raw.githubusercontent.com/BerriAI/litellm/...",

  "gpt-4o": {
    "provider":    "openai",           // openai | anthropic | google | ...
    "input":       2.5,                // USD per 1M input tokens
    "output":      10.0,               // USD per 1M output tokens
    "cachedInput": 1.25                // optional — prompt-caching rate
  }
}
```

## Adding a new model to daily tracking

Edit [`scripts/scrape-prices.mjs`](scripts/scrape-prices.mjs), find `MODEL_MAP`, and add a row:

```js
"the-provider-id-litellm-uses": "your-canonical-helix-id",
```

Next daily run picks it up automatically. If LiteLLM doesn't know about the model, add it directly to `prices.json` — the scraper preserves manually-managed entries it doesn't recognize.

## Running the scraper locally

```bash
node scripts/scrape-prices.mjs
```

Outputs a fresh `prices.json`. Diff, review, commit.

## Manual runs

Go to **Actions → Refresh prices → Run workflow** on GitHub. Runs the same pipeline on demand.

## Fail-soft behavior

If upstream is unreachable or its JSON is broken, the scraper exits with status 0 without touching `prices.json`. The GitHub Action then sees "no diff" and doesn't commit. **The old prices stay in place until the next successful refresh.**

If a specific model isn't found upstream (mapping is stale), the scraper keeps its existing entry rather than deleting it.
