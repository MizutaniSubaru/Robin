import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";

import { getTdjson } from "prebuilt-tdlib";

export type TdObject = { "@type": string } & Record<string, unknown>;

// Main-thread half of libtdjson. td_receive lives only in the receive worker
export interface TdJson {
  createClientId(): number;
  send(clientId: number, request: object): void;
  // Synchronous; only for the few methods TDLib marks as "can be called synchronously"
  execute(request: object): TdObject | null;
}

// Path to libtdjson: the configured one, or the prebuilt-tdlib build matching this platform
export function resolveTdjsonPath(configured: string | undefined): string {
  return configured ?? getTdjson();
}

// NUL-terminated UTF-8. Passed to FFI as the buffer itself, not ptr(buffer): a bare address would let
// the buffer be collected before TDLib reads it. TDLib parses the request before the call returns
function encode(request: object): Buffer {
  return Buffer.from(`${JSON.stringify(request)}\0`, "utf8");
}

// Copies the string out: TDLib reuses the buffer on the next call from the same thread
export function readCString(pointer: Pointer | bigint | null): string | null {
  // bun:ffi hands pointers back as numbers; the bigint in its return type never occurs for FFIType.ptr
  return pointer ? new CString(pointer as Pointer).toString() : null;
}

export function openTdJson(libraryPath: string): TdJson {
  const { symbols } = dlopen(libraryPath, {
    td_create_client_id: { args: [], returns: FFIType.i32 },
    td_send: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.void },
    td_execute: { args: [FFIType.ptr], returns: FFIType.ptr },
  });

  return {
    createClientId: () => symbols.td_create_client_id(),
    send: (clientId, request) => symbols.td_send(clientId, encode(request)),
    execute(request) {
      const result = readCString(symbols.td_execute(encode(request)));
      return result === null ? null : (JSON.parse(result) as TdObject);
    },
  };
}
