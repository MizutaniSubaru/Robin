import type { td } from "../../src/sources/tdlib/index.ts";

// Real TDLib objects have dozens of fields; fixtures carry only the ones the code under test reads.
// The @type is still checked against the schema
export function update<T extends td.Update["@type"]>(
  value: { "@type": T } & Record<string, unknown>,
): Extract<td.Update, { "@type": T }> {
  return value as unknown as Extract<td.Update, { "@type": T }>;
}
