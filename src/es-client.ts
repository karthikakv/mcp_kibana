import { Client } from "@elastic/elasticsearch";

/**
 * The ONLY index patterns this server is allowed to touch.
 * This is defence-in-depth: the API key itself is read-only and scoped,
 * but we also refuse any request that targets an index outside this list.
 */
export const ALLOWED_PATTERNS = [
  "java_application_logs",
  "wmapi",
  "openshift_apps_java",
];

export const INDEX_OPTIONS = [
  "java_application_logs",
  "wmapi",
  "openshift_apps_java",
];

const INDEX_ALIASES: Record<string, string> = {
  java_application_logs: "java_application_logs",
  "java_application_logs*": "java_application_logs",
  wmapi: "wmapi",
  "wmapi*": "wmapi",
  wm_api: "wmapi",
  openshift: "openshift_apps_java",
  openshift_apps_log: "openshift_apps_java",
  openshift_apps_logs: "openshift_apps_java",
  openshift_apps_java: "openshift_apps_java",
  "openshift_apps_java*": "openshift_apps_java",
};

function normalizeIndexToken(token: string): string {
  const cleaned = token.trim();
  const withoutPrefix = cleaned.replace(/^[-+]/, "");
  const unquoted = withoutPrefix.replace(/["'`]/g, "");
  const alias = INDEX_ALIASES[unquoted];
  if (alias) {
    return cleaned.replace(withoutPrefix, alias);
  }

  if (unquoted.endsWith("*")) {
    const base = unquoted.slice(0, -1);
    if (INDEX_OPTIONS.includes(base)) {
      return cleaned.replace(withoutPrefix, base);
    }
  }

  return cleaned;
}

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
  const targets = index
    .split(",")
    .map((s) => normalizeIndexToken(s))
    .filter(Boolean);

  if (targets.length === 0) {
    throw new Error("No index specified.");
  }

  for (const t of targets) {
    const bare = t.replace(/^[-+]/, "").replace(/["'`]/g, "");
    if (!allowedRegexes.some((r) => r.test(bare))) {
      throw new Error(
        `Please choose a valid index and retry. Available options: ${INDEX_OPTIONS.join(
          ", "
        )}. For OpenShift logs, use openshift_apps_java.`
      );
    }
  }
  return targets.join(",");
}

export function resolveAllowedIndex(index?: string): string {
  if (!index || !index.trim()) {
    const requireSelection =
      process.env.REQUIRE_INDEX_SELECTION !== "false";

    if (requireSelection) {
      throw new Error(
        "Index is required. Please choose one index: " +
          "java_application_logs (application/message), " +
          "wmapi (apiName/responseCode), " +
          "openshift_apps_java (kubernetes_namespace_name/message)."
      );
    }

    // Optional fallback mode when REQUIRE_INDEX_SELECTION=false.
    const defaultAlias =
      process.env.DEFAULT_INDEX_ALIAS?.trim() || "java_application_logs";
    try {
      return assertAllowedIndex(defaultAlias);
    } catch {
      throw new Error(
        `DEFAULT_INDEX_ALIAS "${defaultAlias}" is invalid. Use one of: java_application_logs, wm_api, openshift, or an allowed index pattern.`
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
