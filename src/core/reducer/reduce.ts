// Reducer: folds a chat's events into its ChatState

import type { EventOf, RobinEvent } from "../events/index.ts";
import type { ChatState, SelfMessageItem, SelfStatus, TimelineItem } from "./state.ts";

// Pure: the input state is never modified, so a snapshot can be
// shared. Applying events one batch at a time gives the same result as applying them all at once
// (the window is trimmed after every event, not per batch), which is what makes snapshots safe.
// Every case is idempotent: a repeated event, or one about an item already trimmed away, is a no-op
export function reduce(state: ChatState, events: readonly RobinEvent[]): ChatState {
  if (events.length === 0) return state;
  const next: ChatState = { ...state, timeline: [...state.timeline], users: { ...state.users } };
  for (const event of events) {
    if (event.chat !== state.chat) {
      throw new Error(`Event ${event.eventId} of chat ${event.chat} folded into ${state.chat}`);
    }
    apply(next, event);
    next.lastTs = Math.max(next.lastTs, event.ts);
    trim(next);
  }
  return next;
}

function apply(state: ChatState, event: RobinEvent): void {
  switch (event.kind) {
    case "message.created":
      if (findMessage(state.timeline, event.messageId) !== -1) return;
      state.timeline.push({
        type: "message",
        eventId: event.eventId,
        messageId: event.messageId,
        sender: event.sender,
        senderName: event.senderName,
        replyTo: event.replyTo,
        forwardedFrom: event.forwardedFrom,
        content: event.content,
        edited: false,
        deleted: false,
        ts: event.ts,
        serverDate: event.serverDate,
      });
      return;
    case "message.edited": {
      const i = findMessage(state.timeline, event.messageId);
      const item = state.timeline[i];
      if (item?.type !== "message") return;
      state.timeline[i] = { ...item, content: event.content, edited: true };
      return;
    }
    case "message.deleted": {
      const i = findMessage(state.timeline, event.messageId);
      const item = state.timeline[i];
      if (item?.type === "message" || item?.type === "self_message")
        state.timeline[i] = { ...item, deleted: true };
      return;
    }
    case "alias.assigned":
      if (!(event.user in state.users)) state.users[event.user] = { alias: event.alias, name: event.name };
      return;
    case "user.renamed": {
      if (state.timeline.some((item) => item.type === "renamed" && item.eventId === event.eventId)) return;
      const user = state.users[event.user];
      if (user) state.users[event.user] = { ...user, name: event.to };
      state.timeline.push({
        type: "renamed",
        eventId: event.eventId,
        user: event.user,
        from: event.from,
        to: event.to,
        ts: event.ts,
        serverDate: event.serverDate,
      });
      return;
    }
    case "self.message":
      if (findSelf(state.timeline, event.eventId) !== -1) return;
      state.timeline.push({
        type: "self_message",
        eventId: event.eventId,
        messageId: null,
        replyTo: event.replyTo,
        content: event.content,
        status: "sending",
        error: null,
        deleted: false,
        ts: event.ts,
        serverDate: null,
      });
      return;
    case "self.send_result": {
      const i = findSelf(state.timeline, event.target);
      const item = state.timeline[i];
      if (item?.type !== "self_message") return;
      state.timeline[i] = applySendResult(item, event);
      return;
    }
  }
}

// sending -> sent | failed; sending -> unknown (restart) -> sent | failed. Final states stay final
function applySendResult(item: SelfMessageItem, event: EventOf<"self.send_result">): SelfMessageItem {
  const open: readonly SelfStatus[] = ["sending", "unknown"];
  switch (event.result) {
    case "accepted":
      return item;
    case "unknown":
      return item.status === "sending" ? { ...item, status: "unknown" } : item;
    case "sent":
      if (!open.includes(item.status)) return item;
      if (event.messageId === null)
        throw new Error(`Send result ${event.eventId} is sent without a message id`);
      return { ...item, status: "sent", messageId: event.messageId, serverDate: event.serverDate };
    case "failed":
      if (!open.includes(item.status)) return item;
      return { ...item, status: "failed", error: event.error };
  }
}

function trim(state: ChatState): void {
  const { maxItems, blockSize } = state.window;
  if (state.timeline.length <= maxItems) return;
  state.timeline.splice(0, blockSize);
  state.omitted += blockSize;
}

// Searched from the end: almost every event is about something recent
function findMessage(timeline: readonly TimelineItem[], messageId: string): number {
  return timeline.findLastIndex(
    (item) => (item.type === "message" || item.type === "self_message") && item.messageId === messageId,
  );
}

function findSelf(timeline: readonly TimelineItem[], eventId: string): number {
  return timeline.findLastIndex((item) => item.type === "self_message" && item.eventId === eventId);
}
