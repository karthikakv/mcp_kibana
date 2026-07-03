import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  getClient,
  assertAllowedIndex,
  assertEsqlAllowed,
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
        "Return the field mappings (schema) for an allowed index so you know which fields you can query.",
      inputSchema: {
        index: z.string().describe("Index name or pattern (must be allowed)."),
      },
    },
    async ({ index }) => {
      try {
        const es = getClient();
        const idx = assertAllowedIndex(index);
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
        "Run a read-only Elasticsearch search against an allowed index using standard Query DSL.",
      inputSchema: {
        index: z.string().describe("Index name or pattern (must be allowed)."),
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
        const idx = assertAllowedIndex(index);
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
        index: z.string().describe("Index name or pattern (must be allowed)."),
        query: z.record(z.any()).optional().describe("Optional Query DSL filter."),
      },
    },
    async ({ index, query }) => {
      try {
        const es = getClient();
        const idx = assertAllowedIndex(index);
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
        "Run a read-only ES|QL query. Must start with FROM <allowed-index>.",
      inputSchema: {
        query: z
          .string()
          .describe('e.g. FROM java_application_logs* | WHERE level == "ERROR" | LIMIT 20'),
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
