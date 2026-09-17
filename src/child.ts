// Per-session MCP server injected into subagent sessions via
// session/new|session/load mcpServers. It gives the Devin subagent one
// tool — `report(message)` — which appends the message to the bridge's
// mailbox file. The bridge process drains the mailbox into its inbox,
// which piggybacks on the parent's next tool result.
//
// This file is a standalone entry point: the bridge spawns it as
//   node <dist>/child.js --name <subagent> --mailbox <path>
// It must stay self-contained and fast to start — it runs once per
// subagent session, inside `devin acp`'s MCP client lifecycle.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function arg(flag: string): string {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    process.stderr.write(`devin-subagents child: ${flag} is required\n`);
    process.exit(2);
  }
  return v;
}

const name = arg("--name");
const mailbox = arg("--mailbox");

const server = new McpServer({
  name: "devin-subagents-parent",
  version: "0.5.0",
});

server.registerTool(
  "report",
  {
    title: "Report to the parent agent",
    description:
      "Send a progress update, checkpoint, question or final summary to " +
      "the agent that spawned this session. Use it at milestones and " +
      "decision points — the parent cannot see your output until it polls.",
    inputSchema: {
      message: z
        .string()
        .min(1)
        .max(4000)
        .describe("Short message for the parent agent"),
    },
  },
  ({ message }) => {
    try {
      mkdirSync(path.dirname(mailbox), { recursive: true });
      appendFileSync(
        mailbox,
        JSON.stringify({ name, at: Date.now(), text: message }) + "\n",
      );
      return {
        content: [{ type: "text" as const, text: "reported to parent" }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: e instanceof Error ? e.message : String(e),
          },
        ],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
