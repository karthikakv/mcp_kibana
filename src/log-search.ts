// src/log-search.ts
//
// A single "smart" tool: find_logs.
// The caller does NOT pick an index and does NOT need to know field names.
// The server figures out which index a name (app / api / namespace) lives in
// by probing the data, then searches it. Add a new log index = one entry in
// INDEX_PROFILES below. No application names are ever hardcoded.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, assertAllowedIndex } from "./es-client.js";

/**
 * The ONLY per-index knowledge you maintain.
 * entityFields  = fields that hold the "who" (app name / api name / namespace)
 * messageFields = fields that hold the human-readable log line
 * extraFields   = optional structured filters exposed under a friendly name
 *
 * This is config, not logic. To onboard a new index, add one object here.
 */
interface IndexProfile {
  index: string;
  entityFields: string[];
  messageFields: string[];
  extraFields?: Record<string, string>;
}

export const INDEX_PROFILES: IndexProfile[] = [
  {
    index: "java_application_logs",
    entityFields: ["application", "service.name"],
    messageFields: ["message", "log"],
  },
  {
    index: "wmapi",
    entityFields: ["apiName", "service.name"],
    messageFields: ["message"],
    extraFields: { status_code: "responseCode" },
  },
  {
    index: "openshift_apps_java",
    entityFields: ["kubernetes_namespace_name", "kubernetes.namespace_name"],
    messageFields: ["message", "log"],
  },
];

/** Accepts "7d", "24h", "30m", "past 1 week", "last 24 hours", or ES math ("now-7d"). */
function parseTimeWindow(input?: string): { gte: string; lte: string } {
  const lte = "now";
  if (!input || !input.trim()) return { gte: "now-24h", lte };
  const s = input.trim().toLowerCase();

  if (/^now[-+]/.test(s)) return { gte: s, lte }; // already ES date math

  const short = s.match(/^(\d+)\s*(m|h|d|w)$/); // "7d", "24h", "1w"
  if (short) {
    const n = Number(short[1]);
    if (short[2] === "w") return { gte: `now-${n * 7}d`, lte };
    return { gte: `now-${n}${short[2]}`, lte };
  }

  const nat = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month)/); // "past 1 week"
  if (nat) {
    const n = Number(nat[1]);
    const base = nat[2];
    if (base === "week") return { gte: `now-${n * 7}d`, lte };
    if (base === "month") return { gte: `now-${n * 30}d`, lte };
    const unit = base.startsWith("min") ? "m" : base.startsWith("h") ? "h" : "d";
    return { gte: `now-${n}${unit}`, lte };
  }

  return { gte: "now-24h", lte };
}

/** Match a value against several candidate fields (text OR keyword OR exact). */
function matchClause(fields: string[], value: string) {
  const should: any[] = [];
  for (const f of fields) {
    should.push({ match_phrase: { [f]: value } });
    should.push({ term: { [`${f}.keyword`]: value } });
    should.push({ term: { [f]: value } });
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/** Probe every allowed index to find where `target` actually appears. */
export async function resolveIndicesForTarget(target: string): Promise<string[]> {
  const es = getClient();
  const found: string[] = [];
  await Promise.all(
    INDEX_PROFILES.map(async (p) => {
      try {
        const res = await es.count({
          index: p.index,
          query: matchClause(p.entityFields, target) as any,
        });
        if ((res.count ?? 0) > 0) found.push(p.index);
      } catch {
        /* ignore per-index probe errors */
      }
    })
  );
  return found;
}

function firstField(src: Record<string, any>, fields: string[]): string | null {
  for (const f of fields) {
    if (src[f] != null) return typeof src[f] === "string" ? src[f] : JSON.stringify(src[f]);
  }
  return src["service.name"] ?? null;
}

function firstMessage(src: Record<string, any>, fields: string[]): string | null {
  for (const f of fields) {
    const v = src[f];
    if (v == null) continue;
    const t = (typeof v === "string" ? v : JSON.stringify(v)).trim();
    if (t && t.toLowerCase() !== "(empty)") return t;
  }
  return null;
}

export function registerFindLogsTool(server: McpServer) {
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });
  const fail = (e: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
  });

  server.registerTool(
    "find_logs",
    {
      title: "Find logs (auto-detects the index)",
      description:
        "One-shot log search. You do NOT choose an index. Give a natural request: a name " +
        "(target) that can be an application, an API, or an OpenShift namespace; optional free " +
        "text to match in the message; an optional time window ('7d', '24h', 'past 1 week', or " +
        "blank = last 24h); and an optional status_code. The server probes java_application_logs, " +
        "wmapi and openshift_apps_java, detects where the name lives, searches only those, sorts " +
        "newest-first, and tags each line with its index. Use this for almost every log question.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe("App / API / namespace name, e.g. 'orders-service' or 'ecustomermw'. Server detects the index."),
        text: z.string().optional().describe("Free text to match inside the log message."),
        time: z
          .string()
          .optional()
          .describe("Time window: '7d', '24h', '30m', 'past 1 week', 'last 24 hours', or 'now-7d'. Default last 24h."),
        status_code: z
          .union([z.number(), z.string()])
          .optional()
          .describe("Response/HTTP code filter (applies to wmapi's responseCode)."),
        size: z.number().int().min(1).max(200).optional().describe("Max hits (default 50, cap 200)."),
        index: z
          .string()
          .optional()
          .describe("Optional: force a specific allowed index instead of auto-detecting."),
      },
    },
    async ({ target, text, time, status_code, size, index }) => {
      try {
        const es = getClient();
        const { gte, lte } = parseTimeWindow(time);
        const forced = index && index.trim() ? assertAllowedIndex(index) : "";

        // 1) Decide which indices to search.
        let profiles: IndexProfile[];
        if (forced) {
          profiles = INDEX_PROFILES.filter((p) => forced.includes(p.index));
        } else if (target && target.trim()) {
          const hits = await resolveIndicesForTarget(target.trim());
          profiles = INDEX_PROFILES.filter((p) => hits.includes(p.index));
          if (profiles.length === 0) {
            return ok({
              status: "target_not_found",
              message: `'${target}' was not found as an application, API, or namespace in any allowed index.`,
              searched_indices: INDEX_PROFILES.map((p) => p.index),
              tip: "Check spelling, widen the time window, or pass 'text' instead of 'target'.",
            });
          }
        } else {
          profiles = INDEX_PROFILES; // pure text search across everything
        }

        const cap = size ?? 50;

        // 2) Search each matching index with ITS OWN fields, then merge.
        const perIndex = await Promise.all(
          profiles.map(async (p) => {
            const filter: any[] = [{ range: { "@timestamp": { gte, lte } } }];
            if (status_code != null && p.extraFields?.status_code) {
              filter.push({ term: { [p.extraFields.status_code]: status_code } });
            }
            const must: any[] = [];
            if (target && target.trim() && !forced) {
              must.push(matchClause(p.entityFields, target.trim()));
            }
            if (text && text.trim()) {
              must.push({
                simple_query_string: {
                  query: text.trim(),
                  fields: [...p.messageFields, "*"],
                  default_operator: "and",
                },
              });
            }

            const res = await es.search({
              index: p.index,
              size: cap,
              sort: [{ "@timestamp": { order: "desc" } }] as any,
              query: { bool: { filter, must } } as any,
            });

            const logs = ((res.hits.hits as any[]) ?? [])
              .map((hit) => {
                const src = (hit?._source ?? {}) as Record<string, any>;
                return {
                  index: p.index,
                  timestamp: src["@timestamp"] ?? null,
                  app_or_service: firstField(src, p.entityFields),
                  level: src.level ?? src["log.level"] ?? null,
                  response_code: p.extraFields?.status_code ? src[p.extraFields.status_code] ?? null : null,
                  log_message: firstMessage(src, p.messageFields),
                };
              })
              .filter((e) => e.log_message);

            return { index: p.index, count: logs.length, logs };
          })
        );

        // 3) Merge newest-first, apply overall cap.
        const merged = perIndex
          .flatMap((r) => r.logs)
          .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
          .slice(0, cap);

        return ok({
          status: merged.length ? "ok" : "no_logs_found",
          time_window: { gte, lte },
          indices_searched: profiles.map((p) => p.index),
          hits_by_index: Object.fromEntries(perIndex.map((r) => [r.index, r.count])),
          logs: merged,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}

// Startup guard: ensure INDEX_PROFILES matches ALLOWED_PATTERNS
import { ALLOWED_PATTERNS } from "./es-client.js";
for (const p of INDEX_PROFILES) {
  if (!ALLOWED_PATTERNS.includes(p.index)) {
    throw new Error(
      `Bug: INDEX_PROFILES has index "${p.index}" which is not in ALLOWED_PATTERNS. ` +
      `Update es-client.ts or log-search.ts to keep them in sync.`
    );
  }
}
