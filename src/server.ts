import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  getClient,
  assertAllowedIndex,
  assertEsqlAllowed,
  resolveAllowedIndex,
  ALLOWED_PATTERNS,
} from "./es-client.js";

const PORT = Number(process.env.PORT) || 8080;

/** Build a fresh MCP server with all read-only Elasticsearch tools registered. */
function buildServer(): McpServer {
  const server = new McpServer({
    name: "elasticsearch-logs-mcp",
    version: "1.0.0",
  });

  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });
  const fail = (e: unknown) => ({
    isError: true,
    content: [
      { type: "text" as const, text: `Error: ${(e as Error).message}` },
    ],
  });

  // 1) List indices (restricted to the allowed patterns) -------------------
  server.registerTool(
    "list_indices",
    {
      title: "List log indices",
      description:
        "List Elasticsearch indices you are allowed to read. " +
        `Allowed patterns: ${ALLOWED_PATTERNS.join(", ")}`,
      inputSchema: {
        pattern: z
          .string()
          .optional()
          .describe(
            "Optional index pattern to filter by (must match an allowed pattern)."
          ),
      },
    },
    async ({ pattern }) => {
      try {
        const es = getClient();
        const target = pattern
          ? assertAllowedIndex(pattern)
          : ALLOWED_PATTERNS.join(",");
        const res = await es.cat.indices({
          index: target,
          format: "json",
          h: "index,health,status,docs.count,store.size",
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // 2) Get mappings --------------------------------------------------------
  server.registerTool(
    "get_mappings",
    {
      title: "Get field mappings",
      description:
        "Return field mappings for an allowed index. Field hints: " +
        "java_application_logs -> application (app/service), message (log text); " +
        "wmapi -> apiName (app/service), responseCode (HTTP code); " +
        "openshift_apps_java -> kubernetes_namespace_name (namespace/app), message (log text).",
      inputSchema: {
        index: z
          .string()
          .optional()
          .describe("Index name or pattern (must be allowed). You can use java_application_logs, wmapi, openshift_apps_java, or alias names wm_api and openshift. If omitted, DEFAULT_INDEX_ALIAS is used."),
      },
    },
    async ({ index }) => {
      try {
        const es = getClient();
        const idx = resolveAllowedIndex(index);
        const res = await es.indices.getMapping({ index: idx });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // 3) Search (Query DSL) --------------------------------------------------
  server.registerTool(
    "search",
    {
      title: "Search logs (Query DSL)",
      description:
        "Run a read-only Elasticsearch Query DSL search. Field hints: " +
        "java_application_logs -> application, message; " +
        "wmapi -> apiName, responseCode; " +
        "openshift_apps_java -> kubernetes_namespace_name, message.",
      inputSchema: {
        index: z
          .string()
          .optional()
          .describe("Index name or pattern (must be allowed). You can use java_application_logs, wmapi, openshift_apps_java, or alias names wm_api and openshift. If omitted, DEFAULT_INDEX_ALIAS is used."),
        query: z
          .record(z.any())
          .optional()
          .describe("Elasticsearch Query DSL object. Defaults to match_all."),
        size: z.number().int().min(1).max(200).optional().describe("Max hits (default 20, cap 200)."),
        from: z.number().int().min(0).optional().describe("Offset for pagination."),
        sort: z
          .array(z.record(z.any()))
          .optional()
          .describe('e.g. [{ "@timestamp": { "order": "desc" } }]'),
        source_fields: z
          .array(z.string())
          .optional()
          .describe("Restrict returned _source to these fields."),
        aggs: z.record(z.any()).optional().describe("Optional aggregations."),
      },
    },
    async ({ index, query, size, from, sort, source_fields, aggs }) => {
      try {
        const es = getClient();
        const idx = resolveAllowedIndex(index);
        const res = await es.search({
          index: idx,
          query: (query as any) ?? { match_all: {} },
          size: size ?? 20,
          from: from ?? 0,
          sort: sort as any,
          _source: source_fields as any,
          aggregations: aggs as any,
        });
        const total =
          typeof res.hits.total === "number"
            ? res.hits.total
            : res.hits.total?.value;
        return ok({
          total_hits: total,
          took_ms: res.took,
          hits: res.hits.hits,
          aggregations: (res as any).aggregations,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // 4) Count ---------------------------------------------------------------
  server.registerTool(
    "count",
    {
      title: "Count documents",
      description: "Count documents in an allowed index matching an optional query.",
      inputSchema: {
        index: z
          .string()
          .optional()
          .describe("Index name or pattern (must be allowed). You can use java_application_logs, wmapi, openshift_apps_java, or alias names wm_api and openshift. If omitted, DEFAULT_INDEX_ALIAS is used."),
        query: z.record(z.any()).optional().describe("Optional Query DSL filter."),
      },
    },
    async ({ index, query }) => {
      try {
        const es = getClient();
        const idx = resolveAllowedIndex(index);
        const res = await es.count({
          index: idx,
          query: (query as any) ?? undefined,
        });
        return ok({ count: res.count });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // 5) ES|QL (read-only) ---------------------------------------------------
  server.registerTool(
    "esql_query",
    {
      title: "Run an ES|QL query",
      description:
        "Run a read-only ES|QL query. Must start with FROM <allowed-index>. " +
        "Field hints: java_application_logs uses application/message; " +
        "wmapi uses apiName/responseCode; openshift_apps_java uses kubernetes_namespace_name/message.",
      inputSchema: {
        query: z
          .string()
          .describe('e.g. FROM java_application_logs | WHERE application == "orders-service" | LIMIT 20'),
      },
    },
    async ({ query }) => {
      try {
        assertEsqlAllowed(query);
        const es = getClient();
        const res = await es.esql.query({ query });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // 6) Text search over a time window --------------------------------------
  server.registerTool(
    "search_text_range",
    {
      title: "Search text in time range",
      description:
        "Search logs for a text term over a timestamp range. Use this for queries like 'ecustomermw from 2026-07-02 00:00 to 23:59'. " +
        "If index is omitted, DEFAULT_INDEX_ALIAS is used.",
      inputSchema: {
        text: z.string().min(1).describe("Text to search for (e.g. ecustomermw)."),
        start_time: z
          .string()
          .describe("Start datetime in ISO-8601 format (e.g. 2026-07-02T00:00:00)."),
        end_time: z
          .string()
          .describe("End datetime in ISO-8601 format (e.g. 2026-07-02T23:59:59)."),
        time_zone: z
          .string()
          .optional()
          .describe("Timezone for date parsing (default UTC). Example: Europe/Brussels or +02:00."),
        index: z
          .string()
          .optional()
          .describe("Optional index or alias (java_application_logs, wmapi, openshift_apps_java, wm_api, openshift). If omitted, DEFAULT_INDEX_ALIAS is used."),
        size: z.number().int().min(1).max(200).optional().describe("Max hits (default 100, cap 200)."),
      },
    },
    async ({ text, start_time, end_time, time_zone, index, size }) => {
      try {
        const es = getClient();
        const idx = resolveAllowedIndex(index);

        const res = await es.search({
          index: idx,
          size: size ?? 100,
          sort: [{ "@timestamp": { order: "asc" } }] as any,
          query: {
            bool: {
              filter: [
                {
                  range: {
                    "@timestamp": {
                      gte: start_time,
                      lte: end_time,
                      time_zone: time_zone ?? "UTC",
                    },
                  },
                },
              ],
              should: [
                {
                  simple_query_string: {
                    query: text,
                    fields: [
                      "service.name",
                      "logger_name",
                      "logger",
                      "message",
                      "log",
                      "kubernetes.container.name",
                      "*",
                    ],
                    default_operator: "and",
                  },
                },
                {
                  match_phrase: {
                    message: text,
                  },
                },
              ],
              minimum_should_match: 1,
            },
          } as any,
        });

        const total =
          typeof res.hits.total === "number"
            ? res.hits.total
            : res.hits.total?.value;

        return ok({
          total_hits: total,
          took_ms: res.took,
          index_used: idx,
          hits: res.hits.hits,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

// ------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Optional bearer-token gate on the exposed endpoint.
// If MCP_AUTH_TOKEN is set, callers must send: Authorization: Bearer <token>
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return next();
  if (req.headers.authorization === `Bearer ${token}`) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Stateless Streamable HTTP: new server+transport per request.
app.post("/mcp", requireAuth, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal server error" });
    }
  }
});

// GET/DELETE not used in stateless mode.
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ error: "method not allowed" });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => {
  console.log(`Elasticsearch MCP server listening on :${PORT}/mcp`);
});
