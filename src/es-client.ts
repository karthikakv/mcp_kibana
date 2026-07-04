import { Client } from "@elastic/elasticsearch";

/**
 * The ONLY index patterns this server is allowed to touch.
 * This is defence-in-depth: the API key itself is read-only and scoped,
 * but we also refuse any request that targets an index outside this list.
 */
export const ALLOWED_PATTERNS = [
  "java_application_logs*",
  "wmapi*",
  "wm_messages*",
  "openshift_pod_logs*",
];

const INDEX_ALIASES: Record<string, string> = {
  java_application_logs: "java_application_logs*",
  wm_api: "wmapi*",
  wm_messages: "wm_messages*",
  openshift: "openshift_pod_logs*",
};

// Turn each glob pattern into an anchored regex (only `*` is a wildcard).
const allowedRegexes = ALLOWED_PATTERNS.map(
  (p) =>
    new RegExp(
      "^" +
        p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
        "$"
    )
);

/**
 * Validate a comma-separated index expression against the allowlist.
 * Throws if any target is not permitted. Returns the normalised string.
 */
export function assertAllowedIndex(index: string): string {
  const alias = INDEX_ALIASES[index.trim()];
  if (alias) {
    index = alias;
  }

  const targets = index
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    throw new Error("No index specified.");
  }

  for (const t of targets) {
    const bare = t.replace(/^[-+]/, "").replace(/["'`]/g, "");
    if (!allowedRegexes.some((r) => r.test(bare))) {
      throw new Error(
        `Index "${t}" is not permitted. Allowed patterns: ${ALLOWED_PATTERNS.join(
          ", "
        )}`
      );
    }
  }
  return targets.join(",");
}

export function resolveAllowedIndex(index?: string): string {
  if (!index || !index.trim()) {
    // Default to java application logs unless overridden by DEFAULT_INDEX_ALIAS.
    const defaultAlias = process.env.DEFAULT_INDEX_ALIAS?.trim() || "java_application_logs";
    try {
      return assertAllowedIndex(defaultAlias);
    } catch {
      throw new Error(
        `DEFAULT_INDEX_ALIAS "${defaultAlias}" is invalid. Use one of: java_application_logs, wm_api, wm_messages, openshift, or an allowed index pattern.`
      );
    }
  }

  return assertAllowedIndex(index);
}

/** Light guard for ES|QL: the FROM target must be an allowed index. */
export function assertEsqlAllowed(query: string): void {
  const m = query.match(/from\s+([^\s|]+)/i);
  if (!m) {
    throw new Error("ES|QL query must start with: FROM <index>");
  }
  m[1].split(",").forEach((idx) => assertAllowedIndex(idx));
}

let client: Client | null = null;

export function getClient(): Client {
  if (client) return client;

  const node = process.env.ES_URL;
  const apiKey = process.env.ES_API_KEY;

  if (!node) throw new Error("ES_URL environment variable is not set.");
  if (!apiKey) throw new Error("ES_API_KEY environment variable is not set.");

  client = new Client({
    node,
    auth: { apiKey }, // sends `Authorization: ApiKey <base64>`
    tls: {
      // Set ES_TLS_REJECT_UNAUTHORIZED=false ONLY for a self-signed test cluster.
      rejectUnauthorized:
        process.env.ES_TLS_REJECT_UNAUTHORIZED !== "false",
      ca: process.env.ES_CA_CERT || undefined,
    },
    requestTimeout: 30000,
    maxRetries: 2,
  });

  return client;
}
