// TDLib message ids are server_id * 2^20; the low 20 bits flag local, unsent and scheduled messages.
// Only server ids leave the TDLib boundary. Multiply and divide: JS bitwise operators are 32-bit
const SERVER_ID_FACTOR = 2 ** 20;

// undefined for local / not yet sent / scheduled messages, which have no server id yet
export function toServerMessageId(tdMessageId: number): number | undefined {
  if (!Number.isSafeInteger(tdMessageId) || tdMessageId <= 0) {
    throw new RangeError(`Invalid TDLib message id: ${tdMessageId}`);
  }
  if (tdMessageId % SERVER_ID_FACTOR !== 0) return undefined;
  return tdMessageId / SERVER_ID_FACTOR;
}

export function toTdMessageId(serverMessageId: number): number {
  if (!Number.isSafeInteger(serverMessageId) || serverMessageId <= 0) {
    throw new RangeError(`Invalid server message id: ${serverMessageId}`);
  }
  return serverMessageId * SERVER_ID_FACTOR;
}
