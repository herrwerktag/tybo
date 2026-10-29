import { httpData } from "@tybo/web/http-data";
import { serve } from "./protocol.js";
import { tyboTools } from "@tybo/app/mcp";

// The MCP server for tybo, over stdio: a client (Claude Desktop, Claude Code …) starts it and talks to it on
// stdin/stdout, so nothing else may write to stdout. It reaches the data through the running API, like the app.
const apiUrl = process.env.TYBO_API_URL ?? "http://localhost:3001";

serve(process.stdin, process.stdout, tyboTools(httpData(apiUrl, "mcp")), { name: "tybo", version: "1.0.0" });
