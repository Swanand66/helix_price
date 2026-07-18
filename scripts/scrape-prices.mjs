#!/usr/bin/env node
// scrape-prices.mjs — regenerate prices.json from an upstream source.
//
// Strategy: instead of scraping fragile HTML pricing pages ourselves, we
// piggyback on LiteLLM's community-maintained pricing JSON. It covers
// dozens of providers, is updated frequently, and gives us structured
// data (input/output cost per token). We normalize LiteLLM's model ids
// to Helix's canonical ids and preserve any manual entries (like Fable)
// that upstream doesn't know about.
//
// Fails soft: if upstream fetch/parse fails, we keep the current
// prices.json untouched so the GitHub Action commit step becomes a no-op.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");
const OUT = join(REPO_ROOT, "prices.json");
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json";

// LiteLLM model id -> Helix canonical id.
// Add rows here when you want to track a new model that upstream knows about.
const MODEL_MAP = {
  // OpenAI — gpt-5 family
  "gpt-5":               "gpt-5",
  "gpt-5-mini":          "gpt-5-mini",
  "gpt-5-nano":          "gpt-5-nano",
  // OpenAI — gpt-4 family
  "gpt-4o":              "gpt-4o",
  "gpt-4o-mini":         "gpt-4o-mini",
  "gpt-4-turbo":         "gpt-4-turbo",
  // OpenAI — reasoning
  "o4":                  "o4",
  "o4-mini":             "o4-mini",
  "o3":                  "o3",
  "o3-mini":             "o3-mini",

  // Anthropic — try a few known LiteLLM naming variants; whichever exists wins.
  "claude-opus-5":               "claude-5-opus",
  "claude-sonnet-5":             "claude-5-sonnet",
  "claude-haiku-5":              "claude-5-haiku",
  "claude-opus-4-5":             "claude-4.5-opus",
  "claude-sonnet-4-5":           "claude-4.5-sonnet",
  "claude-haiku-4-5":            "claude-4.5-haiku",
  "claude-3-5-sonnet-latest":    "claude-4.5-sonnet",
  "claude-3-5-haiku-latest":     "claude-4.5-haiku",
  "claude-3-opus-latest":        "claude-4.5-opus",

  // Google Gemini
  "gemini-2.5-pro":              "gemini-2.5-pro",
  "gemini-2.5-flash":            "gemini-2.5-flash",
  "gemini/gemini-2.5-pro":       "gemini-2.5-pro",
  "gemini/gemini-2.5-flash":     "gemini-2.5-flash",
};

// LiteLLM's provider tag -> Helix provider tag.
const PROVIDER_MAP = {
  openai:     "openai",
  anthropic:  "anthropic",
  vertex_ai:  "google",
  vertex_ai_language_models: "google",
  gemini:     "google",
  google:     "google",
};

function loadCurrent() {
  if (!existsSync(OUT)) return {};
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch (err) {
    console.error("failed to parse existing prices.json:", err.message);
    return {};
  }
}

async function fetchUpstream() {
  const res = await fetch(LITELLM_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return res.json();
}

/** Convert LiteLLM per-token cost to Helix per-1M-token cost, rounded to
 *  4 decimal places (avoids float noise in diffs). */
function toPerMillion(costPerToken) {
  if (typeof costPerToken !== "number" || !isFinite(costPerToken)) return null;
  return Math.round(costPerToken * 1_000_000 * 10000) / 10000;
}

function priceFromUpstream(entry) {
  if (!entry) return null;
  const input = toPerMillion(entry.input_cost_per_token);
  const output = toPerMillion(entry.output_cost_per_token);
  if (input === null || output === null) return null;

  const provider = PROVIDER_MAP[entry.litellm_provider] ?? entry.litellm_provider ?? "unknown";
  const out = { provider, input, output };

  const cached = toPerMillion(entry.cache_read_input_token_cost);
  if (cached !== null) out.cachedInput = cached;

  return out;
}

async function main() {
  const current = loadCurrent();
  let upstream;
  try {
    upstream = await fetchUpstream();
  } catch (err) {
    console.error(`upstream fetch failed: ${err.message}. Leaving prices.json untouched.`);
    process.exit(0);
  }

  const next = {};

  // 1. Preserve $-prefixed metadata + any manually-managed entries that
  //    upstream doesn't know about (e.g. Fable).
  for (const [key, val] of Object.entries(current)) {
    if (key.startsWith("$")) {
      next[key] = val;
      continue;
    }
    // If the current entry isn't the target of any mapping, keep it as-is.
    const isMapped = Object.values(MODEL_MAP).includes(key);
    if (!isMapped) next[key] = val;
  }

  // 2. Overlay: for each LiteLLM id we care about, write the fresh price.
  let updated = 0;
  let missing = 0;
  for (const [litellmId, ourId] of Object.entries(MODEL_MAP)) {
    const price = priceFromUpstream(upstream[litellmId]);
    if (!price) {
      missing++;
      // If we don't have a fresh price, keep the existing one (if any).
      if (current[ourId]) next[ourId] = current[ourId];
      continue;
    }
    next[ourId] = price;
    updated++;
  }

  // 3. Refresh metadata.
  next.$comment =
    (current.$comment ??
      "Helix — daily-refreshable pricing table (USD per 1M tokens).") +
    "";
  next.$version = new Date().toISOString().slice(0, 10);
  next.$source = "LiteLLM community pricing (auto-refreshed daily)";
  next.$upstream = LITELLM_URL;

  // Preserve stable key order: metadata first, then models sorted alphabetically.
  const meta = {};
  const models = {};
  for (const [k, v] of Object.entries(next)) {
    if (k.startsWith("$")) meta[k] = v;
    else models[k] = v;
  }
  const sorted = {
    ...meta,
    ...Object.fromEntries(Object.keys(models).sort().map((k) => [k, models[k]])),
  };

  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
  console.log(
    `wrote ${OUT}: ${updated} models refreshed, ${missing} not found upstream, ` +
      `${Object.keys(sorted).filter((k) => !k.startsWith("$")).length} total in file.`,
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
