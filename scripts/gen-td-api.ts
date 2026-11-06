// bun run tdlib:types [--force]
// Downloads td_api.tl for the TDLib commit prebuilt-tdlib was built from and generates
// src/tdlib-api/td-api.ts. Both are gitignored: the commit pins the schema, so they can always be
// rebuilt, and `typecheck` / `test` run this first. Nothing imports td-api.ts at runtime (type-only),
// so the Docker image does not need it. td_api.tl is kept only as the field docs the types leave out.
// The output lives outside sources/tdlib so db/ and core/ can use it without depending on a data source.
//
// Skips the download when td-api.ts was made from the same commit by the same version of this script
//
// Mapping, following TDLib's JSON interface:
// - int32, int53, double -> number; int64 and bytes (base64) -> string, since they don't fit a JS number
// - an object field documented as nullable ("may be null", "pass null") -> optional, because TDLib leaves
//   null objects out of its JSON and accepts them missing on input; in a vector it means null elements
// - every other field is required. TDLib would default a missing scalar on input, but a request that
//   relies on that is almost always a bug

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCHEMA_DIR = join(ROOT, "src/tdlib-api");
const TL_PATH = join(SCHEMA_DIR, "td_api.tl");
const OUT_PATH = join(SCHEMA_DIR, "td-api.ts");

const PRIMITIVES: Record<string, string> = {
  int32: "number",
  int53: "number",
  double: "number",
  int64: "string",
  bytes: "string",
  string: "string",
  Bool: "boolean",
};
// Declared at the top of td_api.tl for the TL compiler, not part of the API
const BUILTINS = new Set([
  "double",
  "string",
  "int32",
  "int53",
  "int64",
  "bytes",
  "boolFalse",
  "boolTrue",
  "vector",
]);
// Names the generated module declares itself, or that TypeScript reserves for its own types
const RESERVED = new Set([
  "Request",
  "Results",
  "ResultOf",
  "TDLIB_COMMIT",
  "TDLIB_VERSION",
  "any",
  "unknown",
  "number",
  "bigint",
  "boolean",
  "string",
  "symbol",
  "void",
  "undefined",
  "null",
  "never",
  "object",
]);

interface Field {
  name: string;
  type: string;
  nullable: boolean;
}

interface Definition {
  name: string;
  fields: Field[];
  result: string;
  isFunction: boolean;
}

const pkg = await Bun.file(Bun.resolveSync("prebuilt-tdlib/package.json", ROOT)).json();
const { commit, version } = pkg.tdlib as { commit: string; version: string };
const generator = Bun.hash(await Bun.file(import.meta.path).text()).toString(16);
const stamp = `// Stamp: TDLib ${commit}, generator ${generator}`;

const output = Bun.file(OUT_PATH);
if (!Bun.argv.includes("--force") && (await output.exists()) && (await output.text()).includes(stamp)) {
  process.exit(0);
}

const url = `https://raw.githubusercontent.com/tdlib/td/${commit}/td/generate/scheme/td_api.tl`;
const response = await fetch(url);
if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
const tl = await response.text();
await Bun.write(TL_PATH, tl);

const definitions = parse(tl);
await Bun.write(OUT_PATH, render(definitions, commit, version, stamp));
console.error(`Generated ${OUT_PATH} from TDLib ${version} (${commit}): ${definitions.length} definitions`);

function parse(source: string): Definition[] {
  const result: Definition[] = [];
  let comment: string[] = [];
  let isFunction = false;

  for (const [index, raw] of source.split("\n").entries()) {
    const line = raw.trim();
    if (line === "---functions---") {
      isFunction = true;
      comment = [];
    } else if (line === "") {
      // A blank line ends a doc block; standalone //@class blocks are never attached to a definition
      comment = [];
    } else if (line.startsWith("//")) {
      comment.push(line.slice(2).replace(/^-/, ""));
    } else {
      // Builtins use TL syntax of their own (`double ? = Double;`), so skip them before parsing
      if (!BUILTINS.has(line.split(/\s/)[0] ?? line)) {
        result.push(parseDefinition(line, comment.join(" "), isFunction, index + 1));
      }
      comment = [];
    }
  }
  return result;
}

function parseDefinition(line: string, doc: string, isFunction: boolean, lineNumber: number): Definition {
  const match = /^(\w+)((?:\s+\w+:[\w<>]+)*)\s*=\s*(\w+);$/.exec(line);
  if (!match) throw new Error(`td_api.tl:${lineNumber}: cannot parse "${line}"`);
  const name = group(match, 1);
  const fields = group(match, 2)
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
    .map((part) => {
      const colon = part.indexOf(":");
      return { name: part.slice(0, colon), type: part.slice(colon + 1) };
    });
  const docs = fieldDocs(
    doc,
    fields.map((f) => f.name),
  );
  return {
    name,
    result: group(match, 3),
    isFunction,
    fields: fields.map((f) => {
      const fieldDoc = docs.get(f.name);
      if (fieldDoc === undefined) throw new Error(`td_api.tl:${lineNumber}: ${name}.${f.name} has no doc`);
      return { ...f, nullable: isNullable(f.type, fieldDoc) };
    }),
  };
}

// Splits "@description ... @chat_id ... @param_description ..." into per-field text. Only known names
// count as tags, since descriptions can contain "@username" and similar
function fieldDocs(doc: string, fieldNames: string[]): Map<string, string> {
  const tagToField = new Map<string, string>([
    ["description", ""],
    ["class", ""],
  ]);
  for (const name of fieldNames) tagToField.set(name === "description" ? "param_description" : name, name);

  const tags = [...doc.matchAll(/(?:^|\s)@(\w+)\s/g)].filter((m) => tagToField.has(group(m, 1)));
  const docs = new Map<string, string>();
  tags.forEach((tag, i) => {
    const field = tagToField.get(group(tag, 1));
    if (!field) return;
    const next = tags[i + 1];
    docs.set(field, doc.slice(tag.index + tag[0].length, next === undefined ? doc.length : next.index));
  });
  return docs;
}

function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`Regex group ${index} missing in "${match[0]}"`);
  return value;
}

function isNullable(type: string, doc: string): boolean {
  if (PRIMITIVES[baseType(type)] !== undefined) return false;
  return /\bnull\b/i.test(doc.replace(/\bnon-null\b|\bnot null\b/gi, ""));
}

function baseType(type: string): string {
  const inner = /^vector<(.+)>$/.exec(type)?.[1];
  return inner === undefined ? type : baseType(inner);
}

function render(defs: Definition[], commit: string, version: string, stamp: string): string {
  const constructors = defs.filter((d) => !d.isFunction);
  const functions = defs.filter((d) => d.isFunction);

  const classes = new Map<string, string[]>();
  for (const c of constructors) classes.set(c.result, [...(classes.get(c.result) ?? []), c.name]);

  const known = new Set([...constructors.map((c) => c.name), ...classes.keys()]);
  const declared = new Set<string>();
  for (const name of [...known, ...functions.map((f) => f.name)]) {
    if (RESERVED.has(name)) throw new Error(`td_api.tl name ${name} clashes with a reserved name`);
    if (declared.has(name)) throw new Error(`td_api.tl declares ${name} twice`);
    declared.add(name);
  }

  const typeOf = (field: Field): string => {
    const render = (type: string): string => {
      const inner = /^vector<(.+)>$/.exec(type)?.[1];
      if (inner !== undefined) {
        const element = render(inner);
        return element.includes("|") ? `(${element})[]` : `${element}[]`;
      }
      const primitive = PRIMITIVES[type];
      if (primitive !== undefined) return primitive;
      if (!known.has(type)) throw new Error(`Unknown type ${type} in field ${field.name}`);
      // Only reached inside a vector: a nullable top-level field is optional instead
      return field.nullable && type !== field.type ? `${type} | null` : type;
    };
    return render(field.type);
  };

  const iface = (d: Definition): string => {
    const lines = [`export interface ${d.name} {`, `  "@type": "${d.name}";`];
    for (const f of d.fields)
      lines.push(`  ${f.name}${f.nullable && !f.type.startsWith("vector<") ? "?" : ""}: ${typeOf(f)};`);
    lines.push("}");
    return lines.join("\n");
  };

  const out: string[] = [
    `// Generated by scripts/gen-td-api.ts from td_api.tl (TDLib ${version}). Do not edit`,
    stamp,
    "",
    `export const TDLIB_VERSION = "${version}";`,
    `export const TDLIB_COMMIT = "${commit}";`,
    "",
    "// Objects",
    "",
  ];
  for (const c of constructors) out.push(iface(c), "");

  out.push("// Classes", "");
  for (const [name, members] of classes)
    out.push(`export type ${name} =\n  | ${members.join("\n  | ")};`, "");

  out.push("// Functions", "");
  for (const f of functions) {
    if (!classes.has(f.result)) throw new Error(`Function ${f.name} returns unknown class ${f.result}`);
    out.push(iface(f), "");
  }

  out.push(
    "export interface Results {",
    ...functions.map((f) => `  ${f.name}: ${f.result};`),
    "}",
    "",
    `export type Request =\n  | ${functions.map((f) => f.name).join("\n  | ")};`,
    "",
    `export type ResultOf<R extends Request> = Results[R["@type"]];`,
    "",
  );
  return out.join("\n");
}
