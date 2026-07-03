# elasticsearch-mcp

A **read-only** MCP server that exposes selected Elasticsearch / Kibana log
indices as MCP tools, so an AI client (Azure AI, Claude, etc.) can search your
logs over an HTTP endpoint.

```
AI client ──▶ mcp-remote ──HTTP──▶ elasticsearch-mcp ──REST──▶ Elasticsearch
```

## Tools exposed

| Tool           | What it does                                             |
| -------------- | ------------------------------------------------------- |
| `list_indices` | List allowed indices                                    |
| `get_mappings` | Return the field schema for an index                    |
| `search`       | Run a Query DSL search (default 20 hits, cap 200)       |
| `count`        | Count matching documents                                |
| `esql_query`   | Run a read-only ES|QL query (`FROM <allowed-index>...`) |

## Allowed indices (hardcoded allowlist)

```
java_application_logs*
wmapi*
wm_messages*
openshift_pod_logs*
```

Any request targeting an index outside this list is rejected before it ever
reaches Elasticsearch. This is on top of the API key already being read-only
and index-scoped.

## Security — read this first

- **Never commit the API key.** It goes in an environment variable only.
  `.env` is git-ignored; `.env.example` holds placeholders.
- If a key was ever pasted somewhere public, **invalidate it in Kibana**
  (Stack Management → Security → API Keys) and issue a new one.
- Set `MCP_AUTH_TOKEN` so only callers with the bearer token can hit `/mcp`.
- `test-elasticsearch:9200` is an internal hostname — the host running this
  server must be able to reach it (e.g. Azure VNet integration if ES is private).

## Local run

```bash
cd elasticsearch-mcp
cp .env.example .env      # fill in ES_API_KEY, MCP_AUTH_TOKEN
npm install
npm run dev               # or: npm run build && npm start
```

Test:

```bash
curl -s localhost:8080/health

curl -s -X POST localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <MCP_AUTH_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deploy to Azure App Service (same pattern as the ServiceNow gateway)

1. **Create a Web App** (Node 18/20 LTS). If ES is on a private network, enable
   **VNet integration** so the app can resolve/reach `test-elasticsearch:9200`.
2. **Configuration → Application settings**, add:
   - `ES_URL = https://test-elasticsearch:9200`
   - `ES_API_KEY = <new read-only key>`
   - `ES_TLS_REJECT_UNAUTHORIZED = false`  *(only if self-signed test cert)*
   - `MCP_AUTH_TOKEN = <a long random string>`
   - `SCM_DO_BUILD_DURING_DEPLOYMENT = true`
3. **Startup command:** `npm start` (App Service runs `npm install` + `npm run build` when the build flag above is set).
4. **Deploy** this folder (Deployment Center → GitHub, or `az webapp up`, or your
   existing publish-profile flow).
5. Your endpoint is: `https://<app-name>.azurewebsites.net/mcp`

## Point an MCP client at it

Using `mcp-remote` (same bridge your ServiceNow setup uses):

```json
{
  "mcpServers": {
    "elasticsearch-logs": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<app-name>.azurewebsites.net/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```
