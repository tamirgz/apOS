/**
 * The single source of truth for external integrations — every connectable
 * source, its fields, and its metadata, in one typed list.
 *
 * Client-safe (pure data, no server imports): the Connections UI renders from
 * it, and `saveIntegration`'s allowlist is GENERATED from it — so a field can
 * never again exist in the UI but be unsaveable (the mlx_base_url/mlx_models
 * bug class). Adding an integration = one entry here.
 */
export type IntegrationCategory = "ai" | "knowledge" | "calendar" | "chat";

export const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  ai: "AI providers",
  knowledge: "Knowledge & search",
  calendar: "Calendar & mail",
  chat: "Chat",
};

export const CATEGORY_ORDER: IntegrationCategory[] = [
  "ai",
  "knowledge",
  "calendar",
  "chat",
];

export type FieldKind = "text" | "secret" | "toggle";

export interface IntegrationField {
  key: string;
  label: string;
  hint: string;
  placeholder?: string;
  kind: FieldKind;
}

export interface Integration {
  id: string;
  label: string;
  category: IntegrationCategory;
  /** Short one-liner for the card header. */
  blurb: string;
  /** Renders a guided setup wizard under the header instead of plain fields
   *  ("google" = OAuth flow; "slack" = app-manifest + channel picker). */
  connect?: "google" | "slack";
  /** Local one-click detection (fills the fields from a running service or the
   *  OS): "obsidian" reads the vault registry, "mlx" probes LM Studio. */
  detect?: "obsidian" | "mlx";
  fields: IntegrationField[];
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "mlx",
    label: "Apple MLX (LM Studio)",
    category: "ai",
    blurb: "Local MLX models via LM Studio — faster inference on Apple silicon.",
    detect: "mlx",
    fields: [
      {
        key: "mlx_base_url",
        label: "Apple MLX endpoint (LM Studio)",
        kind: "text",
        placeholder: "http://localhost:1234/v1",
        hint: "Base URL of LM Studio's OpenAI-compatible server. Runs MLX-format models on Apple silicon — measured ~1.25–1.5× Ollama's throughput (and much faster time-to-first-token) — and manages the model lifecycle natively (JIT load, idle-TTL unload). Blank uses MLX_BASE_URL or the default http://localhost:1234/v1.",
      },
      {
        key: "mlx_models",
        label: "Available MLX models",
        kind: "text",
        placeholder: "qwen/qwen3.6-35b-a3b",
        hint: "Comma- or newline-separated LM Studio model ids you've downloaded — these appear as selectable models for the 'mlx' provider in AI Routing. LM Studio JIT-loads any of them on demand.",
      },
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    category: "ai",
    blurb: "Google AI Studio key — a routable metered model (optional).",
    fields: [
      {
        key: "gemini_api_key",
        label: "Gemini API key (metered)",
        kind: "secret",
        placeholder: "AIza…",
        hint: "A Google AI Studio key (aistudio.google.com/apikey) — NOT your Gemini app subscription, which has no API. Enables Gemini as a routable brain in AI Routing. Billed per-token by Google (free tier available).",
      },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    category: "ai",
    blurb:
      "OpenRouter API key — routable cloud models with a large free tier (the low-spec 'cloud-brain' default).",
    fields: [
      {
        key: "openrouter_api_key",
        label: "OpenRouter API key",
        kind: "secret",
        placeholder: "sk-or-v1-…",
        hint: "From openrouter.ai/keys. Enables OpenRouter models in AI Routing — including many free ones (ids ending ':free', $0). Used as the reasoning brain on machines that can't run a local chat model, while embeddings stay on Ollama. Metered per-token for non-free models.",
      },
    ],
  },
  {
    id: "tokenharbor",
    label: "Token Harbor",
    category: "ai",
    blurb:
      "Token Harbor API key — a unified OpenAI-compatible gateway (GPT / Claude / Gemini / DeepSeek / Kimi) with a free tier.",
    fields: [
      {
        key: "tokenharbor_api_key",
        label: "Token Harbor API key",
        kind: "secret",
        placeholder: "th-…",
        hint: "From tokenharbor.ai. Enables Token Harbor models in AI Routing — including free ones (ids ending ':free', $0, e.g. deepseek-v4-flash:free, mimo-v2.5:free) so you can compare them against your other models. Metered per-token for non-free models.",
      },
    ],
  },
  {
    id: "obsidian",
    label: "Obsidian vault",
    category: "knowledge",
    blurb: "Read-only index of your vault's notes into semantic search.",
    detect: "obsidian",
    fields: [
      {
        key: "obsidian_vault_path",
        label: "Obsidian vault (read-only index)",
        kind: "text",
        placeholder: "/Users/you/Documents/SecondBrain",
        hint: "Absolute path to your vault folder. apOS indexes the .md files into semantic search so chat and agents answer from your notes — nothing is ever written back.",
      },
    ],
  },
  {
    id: "websearch",
    label: "Ask web-search",
    category: "knowledge",
    blurb:
      "Enrich Ask with current authoritative pages via SearXNG (bundled in the container edition).",
    fields: [
      {
        key: "ask_web_search",
        label: "Ask · web-search enrichment",
        kind: "toggle",
        hint: "When on, Ask supplements your own data with a few current, authoritative pages fetched via SearXNG (standards bodies, official docs — never paywalls or Wikipedia). Your saved data stays the source of truth. Off ⇒ Ask answers from your corpus alone.",
      },
      {
        key: "searxng_url",
        label: "SearXNG endpoint",
        kind: "text",
        placeholder: "https://your-host/searxng",
        hint: "Base URL of a SearXNG instance with the JSON format enabled — keyless and free (no paid search API). The container edition bundles one; leave blank to use it (or the SEARXNG_URL env var), or point here at your own.",
      },
    ],
  },
  {
    id: "reader",
    label: "Reader proxy",
    category: "knowledge",
    blurb: "Reads bot-walled article URLs into clean text for research.",
    fields: [
      {
        key: "reader_proxy_url",
        label: "Reader proxy (for Workbench research)",
        kind: "text",
        placeholder: "https://r.jina.ai/",
        hint: "Reads article URLs that block a direct fetch (403 bot-walls), returning clean text. Only the public URL is sent — keyless, no cost. Blank uses the default r.jina.ai; set 'off' to stay local-only; or point at a self-hosted reader.",
      },
    ],
  },
  {
    id: "google",
    label: "Google Calendar + Gmail",
    category: "calendar",
    blurb: "OAuth read-only sync of your calendar events and recent mail.",
    connect: "google",
    fields: [
      {
        key: "google_client_id",
        label: "Google OAuth client ID",
        kind: "text",
        placeholder: "…apps.googleusercontent.com",
        hint: "From console.cloud.google.com → Credentials → OAuth client (Web application, redirect URI http://localhost:3777/api/google/callback).",
      },
      {
        key: "google_client_secret",
        label: "Google OAuth client secret",
        kind: "secret",
        placeholder: "GOCSPX-…",
        hint: "From the same OAuth client. Stored locally in your Postgres only.",
      },
    ],
  },
  {
    id: "calendar_ics",
    label: "Google Calendar (ICS)",
    category: "calendar",
    blurb: "No-account alternative: paste your calendar's secret iCal URL.",
    fields: [
      {
        key: "calendar_ics_url",
        label: "Google Calendar (read-only ICS)",
        kind: "secret",
        placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
        hint: "Google Calendar → Settings → your calendar → 'Secret address in iCal format'. Paste that URL; the worker syncs events every 5 minutes. (Skipped automatically when the Google API above is connected.)",
      },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    category: "chat",
    blurb: "Deliver notifications out, and read channels into reports / Inbox.",
    connect: "slack",
    fields: [
      {
        key: "slack_webhook_url",
        label: "Slack notifications (incoming webhook)",
        kind: "secret",
        placeholder: "https://hooks.slack.com/services/…",
        hint: "An incoming-webhook URL (api.slack.com/apps → Incoming Webhooks). Every apOS notification — agent reports, briefs — is also delivered there.",
      },
      {
        key: "slack_bot_token",
        label: "Slack bot token (read channels)",
        kind: "secret",
        placeholder: "xoxb-…",
        hint: "A bot token (xoxb-…) with channels:history. Lets apOS read the channels your routines post to (Agents page) and capture channels to the Inbox. Add chat:write + reactions:write for in-thread replies.",
      },
      {
        key: "slack_report_channels",
        label: "Slack channels to ingest → reports",
        kind: "text",
        placeholder: "C0A1B2C3D4E, C0F5G6H7I8J",
        hint: "Comma-separated channel IDs the bot has been invited to. Each new message becomes an external report on the Agents page.",
      },
      {
        key: "slack_inbox_channels",
        label: "Slack capture channels → Inbox",
        kind: "text",
        placeholder: "C0ABCDEFG",
        hint: "Comma-separated channel IDs the bot has been invited to. Every new message is captured to the Inbox and auto-triaged into a task, note, idea, etc. Keep separate from report channels.",
      },
    ],
  },
];

/** Every saveable key, generated from the registry — the source for the
 *  `saveIntegration` allowlist so UI fields are always saveable. */
export const INTEGRATION_SETTING_KEYS: string[] = INTEGRATIONS.flatMap((i) =>
  i.fields.map((f) => f.key),
);
