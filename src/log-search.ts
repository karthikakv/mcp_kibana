// src/log-search.ts
//
// A single "smart" tool: find_logs.
// - The caller does NOT pick an index and does NOT need to know field names.
// - The server probes java_application_logs, wmapi and openshift_apps_java to
//   detect where a name (app / api / namespace) lives, then searches it.
// - When nothing is found, it re-probes and reports WHERE the name really
//   exists, so the assistant can say "irap2 is a Java app, not an OpenShift
//   namespace - did you mean that?" instead of pretending it has no access.
// - status_code (wmapi) supports exact (500), class (5xx), comparison (>=500)
//   and range (500-599), and wmapi results include a status_breakdown.
//
// Add a new log index = one entry in INDEX_PROFILES below. No app names hardcoded.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, assertAllowedIndex, ALLOWED_PATTERNS } from "./es-client.js";

interface IndexProfile {
  index: string;
  entityFields: string[];   // fields holding the "who" (app / api / namespace)
  messageFields: string[];  // fields holding the log line
  extraFields?: Record<string, string>; // friendly name -> real field
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

// Fail fast if the profiles and the security allowlist ever drift apart.
for (const p of INDEX_PROFILES) {
  if (!ALLOWED_PATTERNS.includes(p.index)) {
    throw new Error(
      `INDEX_PROFILES contains "${p.index}" which is not in ALLOWED_PATTERNS (${ALLOWED_PATTERNS.join(", ")}).`
    );
  }
}

/** Accepts "7d", "24h", "30m", "past 1 week", "last 24 hours", or ES math ("now-7d"). */
function parseTimeWindow(input?: string): { gte: string; lte: string } {
  const lte = "now";
  if (!input || !input.trim()) return { gte: "now-24h", lte };
  const s = input.trim().toLowerCase();

  if (/^now[-+]/.test(s)) return { gte: s, lte };

  const short = s.match(/^(\d+)\s*(m|h|d|w)$/);
  if (short) {
    const n = Number(short[1]);
    if (short[2] === "w") return { gte: `now-${n * 7}d`, lte };
    return { gte: `now-${n}${short[2]}`, lte };
  }

  const nat = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month)/);
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

/**
 * Turn a status_code request into an ES clause.
 * Supports: 500 | "500" | "5xx" | ">=500" | ">400" | "<=299" | "500-599".
 */
function statusCodeClause(field: string, value: string | number): any {
  const raw = String(value).trim().toLowerCase();

  const cls = raw.match(/^([1-5])xx$/); // 5xx
  if (cls) {
    const base = Number(cls[1]) * 100;
    return { range: { [field]: { gte: base, lt: base + 100 } } };
  }

  const cmp = raw.match(/^(>=|<=|>|<)\s*(\d{3})$/); // >=500
  if (cmp) {
    const op = ({ ">=": "gte", ">": "gt", "<=": "lte", "<": "lt" } as Record<string, string>)[cmp[1]];
    return { range: { [field]: { [op]: Number(cmp[2]) } } };
  }

  const rng = raw.match(/^(\d{3})\s*-\s*(\d{3})$/); // 500-599
  if (rng) {
    return { range: { [field]: { gte: Number(rng[1]), lte: Number(rng[2]) } } };
  }

  const n = Number(raw); // exact - tolerate numeric or string storage
  if (!Number.isNaN(n)) {
    return {
      bool: {
        should: [
          { term: { [field]: n } },
          { term: { [field]: raw } },
          { term: { [`${field}.keyword`]: raw } },
        ],
        minimum_should_match: 1,
      },
    };
  }
  return { term: { [field]: value } };
}

/** Probe every index to find where `target` appears (ignores the time window). */
export async function resolveIndicesForTarget(target: string): Promise<string[]> {
  const es = getClient();
  const found: string[] = [];
  await Promise.all(
    INDEX_PROFILES.map(async (p) => {
      try {
        const res = await es.count({ index: p.index, query: matchClause(p.entityFields, target) as any });
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

function friendlyType(index: string): string {
  if (index === "wmapi") return "API";
  if (index === "openshift_apps_java") return "OpenShift namespace";
  if (index === "java_application_logs") return "Java application";
  return index;
}

/**
 * Map a friendly "type" word (java / api / openshift / namespace) to an index,
 * so the assistant can disambiguate without ever naming an index. Returns null
 * for anything unrecognised (the caller then falls back to auto-detection).
 */
function indexForType(type?: string): string | null {
  if (!type || !type.trim()) return null;
  const t = type.trim().toLowerCase();
  if (/(java|application|app)/.test(t)) return "java_application_logs";
  if (/(api|wmapi|wm[_ ]?api)/.test(t)) return "wmapi";
  if (/(openshift|namespace|ocp|kube)/.test(t)) return "openshift_apps_java";
  return null;
}

/**
 * Build the one clarifying question the assistant should relay to the user when
 * a name lives in more than one place. Single-pass agents (Azure AI Search
 * knowledge sources) can't reason their way to this - so we hand them the exact
 * question and the exact `type` values that resolve it.
 */
function disambiguationQuestion(target: string, indices: string[]): string {
  const options = indices.map((i) => `${friendlyType(i)}`);
  const last = options.pop();
  const list = options.length ? `${options.join(", ")} or ${last}` : last;
  return (
    `"${target}" exists as more than one thing (${list}). Which did you mean? ` +
    `Re-run find_logs with type set to one of: ` +
    `${indices.map((i) => `"${friendlyType(i).toLowerCase()}"`).join(", ")}.`
  );
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
        "One-shot log search. You do NOT choose an index. Give a name (target) that can be a " +
        "Java application, an API, or an OpenShift namespace; optional free text; a time window " +
        "('15m', '2d', 'past 1 week', or blank = last 24h); and an optional status_code for API " +
        "calls. status_code accepts an exact code (500), a class (5xx), a comparison (>=500), or " +
        "a range (500-599). For wmapi results the response also includes status_breakdown (counts " +
        "per response code). " +
        "INTERACTIVITY - the response drives the conversation, so ALWAYS act on these fields: " +
        "(1) if 'status' is 'needs_clarification' or 'ask_user' is present, relay 'ask_user' to " +
        "the user VERBATIM as your reply and wait for their answer - do NOT invent an answer; " +
        "(2) when the user answers a disambiguation question, call find_logs again with the same " +
        "target plus type='java'|'api'|'openshift'; " +
        "(3) after showing results, offer the items in 'suggested_next' as follow-up options. " +
        "IMPORTANT: if it returns no logs, that is a data/identifier result, NOT an access " +
        "problem - never tell the user you lack access. 'target_found_in' shows which index the " +
        "name actually exists in.",
      inputSchema: {
        target: z.string().optional().describe("App / API / namespace name, e.g. 'irap2'. Server detects the index."),
        text: z.string().optional().describe("Free text to match inside the log message."),
        time: z.string().optional().describe("Window: '15m', '2d', 'past 1 week', or 'now-7d'. Default last 24h."),
        status_code: z
          .union([z.number(), z.string()])
          .optional()
          .describe("API response code filter: 500, '5xx', '>=500', or '500-599'. Applies to wmapi."),
        size: z.number().int().min(1).max(200).optional().describe("Max hits (default 50, cap 200)."),
        type: z
          .string()
          .optional()
          .describe(
            "Optional disambiguator when a name could be several things: 'java' (application), " +
            "'api', or 'openshift' (namespace). Use this to answer the follow-up question the tool " +
            "asks when a name exists in more than one place. Never ask the user for an index name."
          ),
        index: z.string().optional().describe("Optional: force a specific allowed index instead of auto-detecting."),
      },
    },
    async ({ target, text, time, status_code, size, type, index }) => {
      try {
        const es = getClient();
        const { gte, lte } = parseTimeWindow(time);
        // A `type` hint acts as a soft index selection (java / api / openshift).
        const typeIndex = indexForType(type);
        // A bad `index`/`type` must NOT hard-error - fall back to auto-detect so
        // the user still gets a helpful answer instead of "please choose a valid index".
        let forced = "";
        if (index && index.trim()) {
          try {
            forced = assertAllowedIndex(index);
          } catch {
            forced = typeIndex || ""; // ignore the bad index, keep any type hint
          }
        } else {
          forced = typeIndex || "";
        }
        const cleanTarget = target?.trim() || "";
        const hasStatus = status_code != null && String(status_code).trim() !== "";

        // 1) Decide which indices to search.
        let profiles: IndexProfile[];
        if (forced) {
          profiles = INDEX_PROFILES.filter((p) => forced.includes(p.index));
        } else if (cleanTarget) {
          const hits = await resolveIndicesForTarget(cleanTarget);
          profiles = INDEX_PROFILES.filter((p) => hits.includes(p.index));
          if (profiles.length === 0) {
            return ok({
              status: "target_not_found",
              data_access: "ok",
              note: "Wrong-identifier result, NOT a permissions or access error.",
              target: cleanTarget,
              searched_indices: INDEX_PROFILES.map((p) => p.index),
              target_found_in: [],
              ask_user:
                `I couldn't find "${cleanTarget}" as a Java application, API, or OpenShift ` +
                `namespace in any log source. Can you confirm the exact name or check the spelling?`,
              message:
                `"${cleanTarget}" was not found as a Java application, API, or OpenShift namespace ` +
                `in any index. Ask the user to confirm the exact name / check spelling.`,
            });
          }
          // Ambiguous: the name lives in >1 source and the caller gave no `type`.
          // Ask the ONE question that resolves it instead of silently merging.
          if (profiles.length > 1 && !hasStatus && !(text && text.trim())) {
            const found = profiles.map((p) => p.index);
            return ok({
              status: "needs_clarification",
              data_access: "ok",
              note: "The name matched multiple log sources. Relay ask_user, then re-run with `type`.",
              target: cleanTarget,
              target_found_in: found,
              ask_user: disambiguationQuestion(cleanTarget, found),
            });
          }
        } else if (hasStatus) {
          // Status asked with no app -> only indices that HAVE status codes (wmapi).
          profiles = INDEX_PROFILES.filter((p) => p.extraFields?.status_code);
          if (profiles.length === 0) profiles = INDEX_PROFILES;
        } else {
          profiles = INDEX_PROFILES;
        }

        const cap = size ?? 50;

        // 2) Search each matching index with ITS OWN fields, then merge.
        const perIndex = await Promise.all(
          profiles.map(async (p) => {
            const filter: any[] = [{ range: { "@timestamp": { gte, lte } } }];
            if (hasStatus && p.extraFields?.status_code) {
              filter.push(statusCodeClause(p.extraFields.status_code, status_code as any));
            }
            const must: any[] = [];
            if (cleanTarget && !forced) must.push(matchClause(p.entityFields, cleanTarget));
            if (text && text.trim()) {
              must.push({
                simple_query_string: {
                  query: text.trim(),
                  fields: [...p.messageFields, "*"],
                  default_operator: "and",
                },
              });
            }

            const query = { bool: { filter, must } } as any;

            // Add a status breakdown aggregation for indices that carry codes.
            const aggs =
              p.extraFields?.status_code
                ? { by_status: { terms: { field: p.extraFields.status_code, size: 20 } } }
                : undefined;

            let res: any;
            try {
              res = await es.search({
                index: p.index,
                size: cap,
                sort: [{ "@timestamp": { order: "desc" } }] as any,
                query,
                aggregations: aggs as any,
              });
            } catch {
              // Field may not be aggregatable; retry without the aggregation.
              res = await es.search({
                index: p.index,
                size: cap,
                sort: [{ "@timestamp": { order: "desc" } }] as any,
                query,
              });
            }

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
              .filter((e) => e.log_message || e.response_code != null);

            let statusBreakdown: Record<string, number> | undefined;
            const buckets = res.aggregations?.by_status?.buckets as any[] | undefined;
            if (buckets?.length) {
              statusBreakdown = {};
              for (const b of buckets) statusBreakdown[String(b.key)] = b.doc_count;
            }

            return { index: p.index, count: logs.length, logs, statusBreakdown };
          })
        );

        const merged = perIndex
          .flatMap((r) => r.logs)
          .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
          .slice(0, cap);

        const statusByIndex = Object.fromEntries(
          perIndex.filter((r) => r.statusBreakdown).map((r) => [r.index, r.statusBreakdown])
        );

        // 3) Nothing matched -> explain and say WHERE the name really lives.
        if (merged.length === 0) {
          const searched = profiles.map((p) => p.index);
          const foundIn = cleanTarget ? await resolveIndicesForTarget(cleanTarget) : [];
          const elsewhere = foundIn.filter((i) => !searched.includes(i));

          let message: string;
          let askUser: string;
          if (cleanTarget && elsewhere.length > 0) {
            const hint = elsewhere.map((i) => `${i} (${friendlyType(i)})`).join(", ");
            message =
              `No logs for "${cleanTarget}"${hasStatus ? ` with status ${status_code}` : ""} in ` +
              `${searched.join(", ")} within ${gte}..${lte}. But "${cleanTarget}" DOES exist in: ${hint}. ` +
              `It looks like a ${friendlyType(elsewhere[0])} - ask the user whether to search ${elsewhere.join(" or ")} instead.`;
            askUser =
              `I found no ${searched.map(friendlyType).join("/")} logs for "${cleanTarget}", ` +
              `but it exists as a ${friendlyType(elsewhere[0])}. ` +
              `Want me to pull the ${friendlyType(elsewhere[0])} logs instead? ` +
              `(re-run with type "${friendlyType(elsewhere[0]).toLowerCase()}")`;
          } else if (cleanTarget && foundIn.length > 0) {
            message =
              `"${cleanTarget}" exists in ${searched.join(", ")} but produced no lines` +
              `${hasStatus ? ` with status ${status_code}` : ""} in ${gte}..${lte}. Suggest widening the window or relaxing the status filter.`;
            askUser =
              `"${cleanTarget}" exists but logged nothing${hasStatus ? ` with status ${status_code}` : ""} ` +
              `in the last window (${gte}..${lte}). Should I widen the time range` +
              `${hasStatus ? " or drop the status filter" : ""}?`;
          } else {
            message = `No matching logs in ${searched.join(", ")} for ${gte}..${lte}.`;
            askUser =
              `Nothing matched in ${gte}..${lte}. Do you want a wider time window, ` +
              `or is there a specific app/API name I should search for?`;
          }

          return ok({
            status: "no_logs_found",
            data_access: "ok",
            note: "The query ran successfully. No-data / wrong-identifier result, NOT an access error.",
            time_window: { gte, lte },
            indices_searched: searched,
            hits_by_index: Object.fromEntries(perIndex.map((r) => [r.index, 0])),
            status_breakdown: statusByIndex,
            target: cleanTarget || null,
            target_found_in: foundIn,
            ask_user: askUser,
            message,
          });
        }

        // Offer the user natural next steps so the conversation can continue in
        // a single-pass agent (it relays these instead of dead-ending on results).
        const suggestions: string[] = [];
        const spanned = perIndex.filter((r) => r.count > 0).map((r) => r.index);
        if (spanned.length > 1) {
          suggestions.push(
            `These results span ${spanned.map(friendlyType).join(" and ")}. ` +
            `Want me to focus on just one? (re-run with type)`
          );
        }
        if (!hasStatus && statusByIndex && Object.keys(statusByIndex).length) {
          suggestions.push(`Want only the errors? I can filter to status_code "5xx".`);
        }
        if (!time || !time.trim()) {
          suggestions.push(`This is the last 24h. Want a different window (e.g. "2d", "past 1 week")?`);
        }

        return ok({
          status: "ok",
          time_window: { gte, lte },
          indices_searched: profiles.map((p) => p.index),
          hits_by_index: Object.fromEntries(perIndex.map((r) => [r.index, r.count])),
          status_breakdown: statusByIndex, // e.g. { wmapi: { "200": 40, "500": 3 } }
          logs: merged,
          suggested_next: suggestions.length ? suggestions : undefined,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}