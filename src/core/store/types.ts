// What sources hand to the store (inbound events, user profiles, chat metadata), and the self.*
// bodies Robin writes itself

import type { BodyOf, EventBody } from "../events/index.ts";

// Event kinds a source produces; the rest are derived by the store or written by Robin itself
export type SourceBody = BodyOf<"message.created"> | BodyOf<"message.edited"> | BodyOf<"message.deleted">;

export interface InboundEvent {
  type: "event";
  chat: string;
  account: string;
  // µs, when the source received it; the ts is assigned from it at commit
  receivedAt: number;
  serverDate: number | null;
  body: SourceBody;
  // Current names of every user the body references (sender, mentions): the store assigns aliases
  // and notices renames from them
  users: Readonly<Record<string, string>>;
}

// A user's name as the source now knows it; every chat that knows the user gets a rename if it differs
export interface InboundProfile {
  type: "profile";
  user: string;
  name: string;
  receivedAt: number;
}

export type ChatType = "private" | "basic_group" | "supergroup";

// Chat metadata, kept in the chats table rather than as events
export interface InboundChat {
  type: "chat";
  chat: string;
  chatType: ChatType;
  title: string;
  inboundAccount: string;
}

export type InboundItem = InboundEvent | InboundProfile | InboundChat;

// Self events (Pipeline B) carry no derived users
export type SelfBody = BodyOf<"self.message"> | BodyOf<"self.send_result">;

export type { EventBody };
