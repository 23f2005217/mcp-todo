import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { registerTools } from "./tools.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ status: "ok", server: "mcp-todo", endpoint: "/mcp" });
    }

    if (url.pathname === "/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = new McpServer(
        { name: "mcp-todo", version: "2.0.0" },
        {
          capabilities: { tools: {} },
          jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
        }
      );

      registerTools(server, env);
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
