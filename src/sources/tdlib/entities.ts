// Converts text formatting (entities) between TDLib's form and Robin's TextEntity, both ways

import type { TextEntity } from "../../core/events/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import { parseUserKey, userKey } from "./keys.ts";

// TDLib entities as Robin keeps them. Kinds the text already shows (urls, hashtags, commands, ...)
// are dropped; offsets are UTF-16 in both
export function fromTdEntities(entities: readonly td.textEntity[]): TextEntity[] {
  return entities.flatMap((entity) => (entity.length > 0 ? fromTdEntity(entity) : []));
}

function fromTdEntity(entity: td.textEntity): TextEntity[] {
  const span = { offset: entity.offset, length: entity.length };
  const type = entity.type;
  switch (type["@type"]) {
    case "textEntityTypeBold":
      return [{ type: "bold", ...span }];
    case "textEntityTypeItalic":
      return [{ type: "italic", ...span }];
    case "textEntityTypeUnderline":
      return [{ type: "underline", ...span }];
    case "textEntityTypeStrikethrough":
      return [{ type: "strikethrough", ...span }];
    case "textEntityTypeSpoiler":
      return [{ type: "spoiler", ...span }];
    case "textEntityTypeCode":
      return [{ type: "code", ...span }];
    case "textEntityTypePre":
      return [{ type: "pre", language: "", ...span }];
    case "textEntityTypePreCode":
      return [{ type: "pre", language: type.language, ...span }];
    case "textEntityTypeBlockQuote":
    case "textEntityTypeExpandableBlockQuote":
      return [{ type: "blockquote", ...span }];
    case "textEntityTypeTextUrl":
      return [{ type: "text_url", url: type.url, ...span }];
    case "textEntityTypeMention":
      return [{ type: "mention", ...span }];
    case "textEntityTypeMentionName":
      return [{ type: "mention_user", user: userKey(type.user_id), ...span }];
    case "textEntityTypeHashtag":
    case "textEntityTypeCashtag":
    case "textEntityTypeBotCommand":
    case "textEntityTypeUrl":
    case "textEntityTypeEmailAddress":
    case "textEntityTypePhoneNumber":
    case "textEntityTypeBankCardNumber":
    case "textEntityTypeTonAddress":
    case "textEntityTypeCustomEmoji":
    case "textEntityTypeMediaTimestamp":
    case "textEntityTypeDateTime":
      return [];
  }
}

// For sending: the entities Telegram can display. Mentions by username need no entity
export function toTdEntities(entities: readonly TextEntity[]): td.textEntity[] {
  return entities.flatMap((entity): td.textEntity[] => {
    const type = tdType(entity);
    return type ? [{ "@type": "textEntity", offset: entity.offset, length: entity.length, type }] : [];
  });
}

function tdType(entity: TextEntity): td.TextEntityType | undefined {
  switch (entity.type) {
    case "bold":
      return { "@type": "textEntityTypeBold" };
    case "italic":
      return { "@type": "textEntityTypeItalic" };
    case "underline":
      return { "@type": "textEntityTypeUnderline" };
    case "strikethrough":
      return { "@type": "textEntityTypeStrikethrough" };
    case "spoiler":
      return { "@type": "textEntityTypeSpoiler" };
    case "code":
      return { "@type": "textEntityTypeCode" };
    case "blockquote":
      return { "@type": "textEntityTypeBlockQuote" };
    case "pre":
      return entity.language
        ? { "@type": "textEntityTypePreCode", language: entity.language }
        : { "@type": "textEntityTypePre" };
    case "text_url":
      return { "@type": "textEntityTypeTextUrl", url: entity.url };
    case "mention":
      return undefined;
    case "mention_user": {
      const userId = parseUserKey(entity.user);
      return userId === undefined ? undefined : { "@type": "textEntityTypeMentionName", user_id: userId };
    }
  }
}
