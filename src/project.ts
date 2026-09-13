import type { BufferedEvent } from "./registry.js";

export interface NormEvent {
  seq: number;
  /** bridge receipt time of the (last merged) source event */
  at: string;
  type: string;
  [k: string]: unknown;
}

const DROP_KINDS = new Set([
  "available_commands_update",
  "session_info_update",
  "config_option_update",
  "user_message_chunk", // turn_start already carries the prompt text
]);

export const textOf = (d: Record<string, unknown>): string => {
  const c = d.content as { text?: string } | undefined;
  return c?.text ?? "";
};

const trunc = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + `…(truncated, ${s.length} chars)` : s;

/**
 * Render ACP content (ContentBlock / ToolCallContent / rawOutput) as
 * readable text instead of an escaped JSON blob.
 */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map(contentText).filter(Boolean).join("\n");
  }
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (o.type === "content" && o.content !== undefined) {
      return contentText(o.content);
    }
    if (o.type === "diff") {
      const head = `diff ${String(o.path ?? "")}`;
      const body = typeof o.newText === "string" ? `\n${o.newText}` : "";
      return head + body;
    }
    if (o.type === "terminal") return `[terminal ${o.terminalId ?? ""}]`;
    if (o.type === "resource_link") {
      return `[link] ${String(o.uri ?? o.name ?? "")}`;
    }
    if (o.type === "resource" && o.resource !== undefined) {
      return contentText(o.resource);
    }
    if (typeof o.text === "string") return o.text;
    if (typeof o.markdown === "string") return o.markdown;
    if (o.resource !== undefined) return contentText(o.resource);
  }
  return "";
}

/** Pick the most readable rendering of a tool_call(_update) payload. */
export function toolOutput(d: Record<string, unknown>): string | undefined {
  if (d.rawOutput !== undefined && d.rawOutput !== null) {
    if (typeof d.rawOutput === "string") return trunc(d.rawOutput, 4096);
    const o = d.rawOutput as Record<string, unknown>;
    // Common shapes: {output}, {stdout,stderr,...}, {content}, {text}.
    const cand = o.output ?? o.text;
    if (typeof cand === "string") return trunc(cand, 4096);
    if (typeof o.stdout === "string" || typeof o.stderr === "string") {
      const both = [o.stdout, o.stderr].filter((x) => typeof x === "string" && x);
      return trunc(both.join("\n"), 4096);
    }
    if (o.content !== undefined) {
      const t = contentText(o.content);
      if (t) return trunc(t, 4096);
    }
    return trunc(JSON.stringify(o, null, 2), 4096);
  }
  if (d.content !== undefined && d.content !== null) {
    const t = contentText(d.content);
    return trunc(t || JSON.stringify(d.content, null, 2), 4096);
  }
  return undefined;
}

export function toolInput(d: Record<string, unknown>): string | undefined {
  const inp = d.rawInput ?? d.input;
  if (inp === undefined || inp === null) return undefined;
  if (typeof inp === "string") return trunc(inp, 2048);
  return trunc(JSON.stringify(inp), 2048);
}

/**
 * Project raw ACP session/update events into a Codex-style item stream:
 * consecutive text chunks merge into one entry, tool_call/tool_call_update
 * become {type:"tool", id, status} lifecycle entries, and agent noise
 * (command lists, title churn, config echoes) is dropped.
 *
 * Every entry carries `seq` and the bridge receipt time `at` of its last
 * merged source event. Tool fields (`title`/`kind`/`status`/`input`) come
 * from the event payload itself — the observer stamps resolved metadata onto
 * each buffered event at ingest time, so replays show what was known then
 * and never pick up a tool's later state or a reused toolCallId.
 */
export function projectEvents(events: BufferedEvent[]): NormEvent[] {
  const out: NormEvent[] = [];
  let lastUsage = "";

  const push = (e: BufferedEvent, type: string, fields: Record<string, unknown>) =>
    out.push({ seq: e.seq, at: e.at, type, ...fields });

  for (const e of events) {
    const d = e.data;
    switch (e.kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const type = e.kind === "agent_message_chunk" ? "message" : "thinking";
        const text = textOf(d);
        const last = out[out.length - 1];
        if (last?.type === type) {
          last.text = String(last.text ?? "") + text;
          last.seq = e.seq;
          last.at = e.at;
        } else {
          push(e, type, { text });
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const fields: Record<string, unknown> = { id: d.toolCallId };
        if (d.title !== undefined) fields.title = d.title;
        if (d.kind !== undefined) fields.kind = d.kind;
        fields.status = d.status ?? "in_progress";
        if (e.kind === "tool_call") fields.locations = d.locations;
        const input = toolInput(d);
        if (input !== undefined) fields.input = input;
        const output = toolOutput(d);
        if (output !== undefined) fields.output = output;
        push(e, "tool", fields);
        break;
      }
      case "plan":
        push(e, "plan", { entries: d.entries });
        break;
      case "usage_update": {
        const meta = (d._meta ?? {}) as Record<string, unknown>;
        const fields: Record<string, unknown> = {
          used: d.used,
          size: d.size,
          cost: d.cost,
          inputTokens: meta["cognition.ai/inputTokens"],
          outputTokens: meta["cognition.ai/outputTokens"],
        };
        const sig = JSON.stringify(fields);
        if (sig !== lastUsage) {
          lastUsage = sig;
          push(e, "usage", fields);
        }
        break;
      }
      case "current_mode_update":
        push(e, "mode", { mode: d.currentModeId });
        break;
      case "turn_start":
        push(e, "turn_start", {
          turn: d.turn,
          text: trunc(String(d.text ?? ""), 400),
        });
        break;
      case "turn_end":
        push(e, "turn_end", {
          turn: d.turn,
          stopReason: d.stopReason,
          error: d.error,
          usage: (d.result as Record<string, unknown> | undefined)?.usage,
        });
        break;
      case "queued":
        push(e, "queued", {
          text: trunc(String(d.text ?? ""), 400),
          position: d.position,
        });
        break;
      case "permission_request":
        push(e, "permission_request", {
          requestId: d.requestId,
          toolCall: d.toolCall,
          options: d.options,
        });
        break;
      case "permission_auto":
        push(e, "permission_auto", {
          toolCall: d.toolCall,
          optionId: d.optionId,
        });
        break;
      default:
        if (!DROP_KINDS.has(e.kind)) push(e, e.kind, d);
    }
  }
  return out;
}

