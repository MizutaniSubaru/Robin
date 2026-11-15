// Tools the model can call: send_message and end_turn

import { z } from "zod";

import { parseMarkdown } from "../core/markdown/index.ts";
import type { ChatState } from "../core/reducer/index.ts";
import { messageAlias, parseMessageAlias } from "../core/render/index.ts";
import type { ToolSpec } from "../llm/index.ts";
import type { SelfSender } from "./self-sender.ts";

export interface ToolContext {
  chat: string;
  runId: string;
  // The chat as the model last saw it: the run's start plus every <update> since
  state: ChatState;
  sender: SelfSender;
  maxTextLength: number;
  maxSends: number;
  // Messages sent so far in this run
  sends: number;
  signal: AbortSignal;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
  // The run ends after this step
  endTurn?: boolean;
  sent?: boolean;
}

interface Tool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

function tool<S extends z.ZodType>(definition: Tool<S>): Tool<S> {
  return definition;
}

const sendMessage = tool({
  name: "send_message",
  description:
    "Send one message to the chat. This is the only way anything you write reaches anyone. " +
    "Write Markdown: **bold**, _italic_, `code`, ```code blocks```, [links](https://…), > quotes. No LaTeX.",
  schema: z.strictObject({
    text: z.string().min(1).describe("The message, in Markdown"),
    reply_to: z
      .string()
      .nullable()
      .describe("Id of the message to reply to, such as m41, or null for no reply"),
  }),
  async run(args, ctx) {
    if (ctx.sends >= ctx.maxSends) {
      return error(`You already sent ${ctx.maxSends} messages this turn, the most allowed. Call end_turn.`);
    }
    const text = parseMarkdown(args.text);
    if (text.text.trim() === "") return error("The message is empty");
    if (text.text.length > ctx.maxTextLength) {
      return error(
        `The message is ${text.text.length} characters; the limit is ${ctx.maxTextLength}. Split it into several messages.`,
      );
    }
    let replyTo: string | null = null;
    if (args.reply_to !== null) {
      replyTo = parseMessageAlias(args.reply_to) ?? null;
      if (replyTo === null || !canReplyTo(ctx.state, replyTo)) {
        return error(`There is no message ${args.reply_to} to reply to`);
      }
    }
    const outcome = await ctx.sender.send(ctx.chat, ctx.runId, text, replyTo, ctx.signal);
    if (!outcome.ok) return { ...error(`Telegram did not take the message: ${outcome.error}`), sent: false };
    return { content: { sent: true, id: messageAlias(outcome.messageId) }, isError: false, sent: true };
  },
});

const endTurn = tool({
  name: "end_turn",
  description:
    "End your turn. Call it once you have said what you wanted to, or right away when nothing needs " +
    "saying: staying silent is often right.",
  schema: z.strictObject({}),
  run() {
    return Promise.resolve({ content: { ok: true }, isError: false, endTurn: true });
  },
});

const TOOLS = [sendMessage, endTurn] as const;

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.schema);
    return { name: t.name, description: t.description, parameters };
  });
}

// Never throws for bad input from the model: that goes back to it as an error result
export async function runTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<ToolResult & { status: "ok" | "error" | "invalid_args"; args: unknown }> {
  const definition = TOOLS.find((t) => t.name === name);
  if (!definition)
    return { ...error(`There is no tool ${name}`), status: "invalid_args", args: rawArguments };
  let args: unknown;
  try {
    args = JSON.parse(rawArguments || "{}");
  } catch {
    return { ...error("The arguments are not valid JSON"), status: "invalid_args", args: rawArguments };
  }
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ...error(`Invalid arguments: ${z.prettifyError(parsed.error)}`), status: "invalid_args", args };
  }
  // Each tool's schema and run() match by construction; the union of tools loses that link
  const result = await (definition.run as (a: unknown, c: ToolContext) => Promise<ToolResult>)(
    parsed.data,
    ctx,
  );
  return { ...result, status: result.isError ? "error" : "ok", args };
}

function canReplyTo(state: ChatState, messageId: string): boolean {
  return state.timeline.some(
    (item) =>
      (item.type === "message" || item.type === "self_message") &&
      item.messageId === messageId &&
      !item.deleted,
  );
}

function error(message: string): ToolResult {
  return { content: { error: message }, isError: true };
}
