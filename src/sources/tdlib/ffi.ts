// FFI: loads libtdjson through bun:ffi and exposes the calls the main thread makes (create a client,
// send, execute), plus the single place TDLib's JSON is parsed

import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";

import { getTdjson } from "prebuilt-tdlib";

import type * as td from "../../tdlib-api/td-api.ts";

// The fields the hub routes by; the rest of the object stays untyped until dispatch narrows it
export interface TdEnvelope {
  "@type": string;
  "@extra"?: string;
  "@client_id"?: number;
}

export interface TdJson {
  createClientId(): number;
  send(clientId: number, request: td.Request & { "@extra": string }): void;
  execute(request: td.Request): TdEnvelope | null;
}

export function resolveTdjsonPath(configured: string | undefined): string {
  return configured ?? getTdjson();
}

export function parseTdJson(raw: string): TdEnvelope {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || typeof (value as TdEnvelope)["@type"] !== "string") {
    throw new TypeError(`TDLib sent something other than an object: ${raw.slice(0, 200)}`);
  }
  return value as TdEnvelope;
}

// NUL-terminated UTF-8. Passed to FFI as the buffer itself, not ptr(buffer): a bare address would let
// the buffer be collected by gc before TDLib reads it. TDLib parses the request before the call returns
function encode(request: object): Buffer {
  return Buffer.from(`${JSON.stringify(request)}\0`, "utf8");
}

// Copies the string out: TDLib reuses the buffer on the next call from the same thread
export function readCString(pointer: Pointer | bigint | null): string | null {
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
      return result === null ? null : parseTdJson(result);
    },
  };
}
