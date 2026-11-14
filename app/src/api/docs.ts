/**
 * Server-rendered API reference. It is built from the same OpenAPI document the API serves at /openapi.json,
 * so it cannot drift from the routes. No scripts and no external assets: one HTML document with inline CSS.
 */
type Json = Record<string, any>;

const METHOD_ORDER = ["get", "post", "put", "delete"];

export const escapeHtml = (value: unknown): string =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slug = (method: string, path: string): string =>
  `${method}-${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function resolve(schema: Json | undefined, doc: Json, seen = new Set<string>()): Json {
  if (!schema) return {};
  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (!ref) return schema;
  if (seen.has(ref)) return {};
  seen.add(ref);
  let node: any = doc;
  for (const part of ref.replace(/^#\//, "").split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return resolve(node, doc, seen);
}

function typeLabel(schema: Json): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((entry: unknown) => JSON.stringify(entry)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (variants) return variants.map((entry) => typeLabel(entry)).filter((entry, index, all) => all.indexOf(entry) === index).join(" | ");
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const base = types.length ? types.join(" | ") : "any";
  const extra: string[] = [];
  if (schema.format) extra.push(String(schema.format));
  if (schema.minimum !== undefined) extra.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) extra.push(`max ${schema.maximum}`);
  if (schema.default !== undefined) extra.push(`default ${JSON.stringify(schema.default)}`);
  return extra.length ? `${base} (${extra.join(", ")})` : base;
}

interface Row { readonly field: string; readonly type: string; readonly required: boolean; readonly note: string }

/** Flatten a schema into field rows: `a.b[].c`. Depth-limited so a recursive schema cannot run away. */
function rows(schema: Json | undefined, doc: Json, prefix = "", depth = 0): Row[] {
  const node = resolve(schema, doc);
  const out: Row[] = [];
  const variants = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  if (variants && !node.properties) {
    const objects = variants.map((entry) => resolve(entry, doc)).filter((entry) => entry.properties || entry.items);
    if (objects.length === 1 && depth < 7) return rows(objects[0], doc, prefix, depth);
    return prefix ? [{ field: prefix, type: typeLabel(node), required: true, note: String(node.description ?? "") }] : [];
  }
  if (node.type === "array" || (Array.isArray(node.type) && node.type.includes("array") && node.items)) {
    const item = resolve(node.items, doc);
    if (item.properties && depth < 7) return rows(item, doc, `${prefix}[]`, depth + 1);
    return [{ field: `${prefix || "(body)"}[]`, type: typeLabel(item), required: true, note: String(node.description ?? "") }];
  }
  if (node.properties && depth < 7) {
    const required = new Set<string>(node.required ?? []);
    for (const [key, value] of Object.entries(node.properties as Json)) {
      const child = resolve(value, doc);
      const field = prefix ? `${prefix}.${key}` : key;
      const nested = child.properties || child.type === "array" || ((child.anyOf ?? child.oneOf) as Json[] | undefined)?.some((entry) => resolve(entry, doc).properties || entry.type === "array");
      if (nested && depth < 6) {
        const inner = rows(child, doc, field, depth + 1);
        if (inner.length) { out.push(...inner); continue; }
      }
      out.push({ field, type: typeLabel(child), required: required.has(key), note: String(child.description ?? "") });
    }
    return out;
  }
  if (prefix) out.push({ field: prefix, type: typeLabel(node), required: true, note: String(node.description ?? "") });
  return out;
}

function table(list: Row[], showRequired: boolean): string {
  if (list.length === 0) return "";
  const head = `<tr><th>Field</th><th>Type</th>${showRequired ? "<th>Required</th>" : ""}<th>Notes</th></tr>`;
  const body = list.map((row) =>
    `<tr><td><code>${escapeHtml(row.field)}</code></td><td>${escapeHtml(row.type)}</td>${showRequired ? `<td>${row.required ? "yes" : "no"}</td>` : ""}<td>${escapeHtml(row.note)}</td></tr>`).join("");
  return `<div class="scroll"><table>${head}${body}</table></div>`;
}

function parameterRows(operation: Json, pathLevel: Json[], doc: Json): { path: Row[]; query: Row[] } {
  const all = [...pathLevel, ...((operation.parameters as Json[] | undefined) ?? [])].map((entry) => resolve(entry, doc));
  const make = (where: string): Row[] => all.filter((entry) => entry.in === where).map((entry) => ({
    field: String(entry.name), type: typeLabel(resolve(entry.schema, doc)), required: entry.required === true,
    note: String(entry.description ?? resolve(entry.schema, doc).description ?? ""),
  }));
  return { path: make("path"), query: make("query") };
}

function sampleCurl(method: string, path: string, hasBody: boolean): string {
  const url = path.replace(/\{(\w+)\}/g, (_m, name: string) => `<${name}>`);
  const flags = method === "get" ? "" : ` -X ${method.toUpperCase()}`;
  const body = hasBody ? ` -H 'content-type: application/json' -d '{...}'` : "";
  return `curl${flags}${body} "$API${url}"`;
}

export function renderDocsHtml(doc: Json): string {
  const info = (doc.info ?? {}) as Json;
  const tags = ((doc.tags as Json[] | undefined) ?? []).map((tag) => ({ name: String(tag.name), description: String(tag.description ?? "") }));
  const operations: Array<{ path: string; method: string; op: Json; pathParams: Json[] }> = [];
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Json)) {
    for (const method of METHOD_ORDER) {
      if (item[method]) operations.push({ path, method, op: item[method], pathParams: (item.parameters as Json[] | undefined) ?? [] });
    }
  }
  const byTag = (tag: string) => operations.filter((entry) => (entry.op.tags?.[0] ?? "other") === tag);
  const groups = [...tags.map((tag) => tag.name), ...new Set(operations.map((entry) => entry.op.tags?.[0] ?? "other").filter((name) => !tags.some((tag) => tag.name === name)))];

  const nav = groups.map((group) => {
    const links = byTag(group).map((entry) => `<li><a href="#${slug(entry.method, entry.path)}"><span class="m ${entry.method}">${entry.method.toUpperCase()}</span> ${escapeHtml(entry.path)}</a></li>`).join("");
    return links ? `<h3>${escapeHtml(group)}</h3><ul>${links}</ul>` : "";
  }).join("");

  const sections = groups.map((group) => {
    const list = byTag(group);
    if (list.length === 0) return "";
    const tag = tags.find((entry) => entry.name === group);
    const cards = list.map(({ path, method, op, pathParams }) => {
      const { path: pathRows, query } = parameterRows(op, pathParams, doc);
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema as Json | undefined;
      const responses = Object.entries((op.responses ?? {}) as Json).map(([status, response]) => {
        const res = resolve(response as Json, doc);
        const content = res.content ? Object.entries(res.content as Json)[0] : undefined;
        const detail = content && content[0] === "application/json" ? table(rows((content[1] as Json).schema, doc), true) : "";
        const media = content && content[0] !== "application/json" ? `<p class="muted">Content type: <code>${escapeHtml(content[0])}</code></p>` : "";
        return `<details${status === "200" ? " open" : ""}><summary><span class="s s${status[0]}">${escapeHtml(status)}</span> ${escapeHtml(res.description ?? "")}</summary>${media}${detail}</details>`;
      }).join("");
      return `<article id="${slug(method, path)}">
<h3><span class="m ${method}">${method.toUpperCase()}</span> <code>${escapeHtml(path)}</code></h3>
${op.summary ? `<p><strong>${escapeHtml(op.summary)}</strong></p>` : ""}${op.description ? `<p>${escapeHtml(op.description)}</p>` : ""}
${pathRows.length ? `<h4>Path parameters</h4>${table(pathRows, false)}` : ""}
${query.length ? `<h4>Query parameters</h4>${table(query, true)}` : ""}
${bodySchema ? `<h4>Request body (JSON)</h4>${table(rows(bodySchema, doc), true)}` : ""}
<h4>Responses</h4>${responses}
<pre><code>${escapeHtml(sampleCurl(method, path, Boolean(bodySchema)))}</code></pre>
</article>`;
    }).join("");
    return `<section id="tag-${escapeHtml(group)}"><h2>${escapeHtml(group)}</h2>${tag?.description ? `<p class="muted">${escapeHtml(tag.description)}</p>` : ""}${cards}</section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(info.title ?? "API")} reference</title>
<meta name="description" content="Reference for the ${escapeHtml(info.title ?? "Overdrive API")}, generated from its OpenAPI document.">
<style>
:root{--bg:#f7f3ed;--card:#fff;--ink:#28324c;--muted:#5d6678;--line:#e1dacd;--gold:#b8873d;--code:#f1ece2;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141a28;--card:#1b2336;--ink:#e8ecf5;--muted:#9aa5bd;--line:#2c3650;--gold:#d3a458;--code:#232d45}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 64px;display:grid;gap:24px;grid-template-columns:minmax(0,1fr)}
@media (min-width:900px){.wrap{grid-template-columns:280px minmax(0,1fr)}nav.side{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto}}
header h1{margin:0 0 4px;font-size:30px}header p{margin:6px 0;color:var(--muted)}
nav.side{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}nav.side h3{margin:12px 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
nav.side ul{list-style:none;margin:0;padding:0}nav.side li{margin:2px 0;font-size:13px;overflow-wrap:anywhere}a{color:inherit}
main section>h2{margin:32px 0 4px;text-transform:capitalize}main article{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
article h3{margin:0 0 8px;font-size:17px;overflow-wrap:anywhere}article h4{margin:16px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--code);padding:1px 5px;border-radius:5px}pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
.m{display:inline-block;min-width:44px;text-align:center;padding:1px 6px;border-radius:5px;font:700 11px/1.6 ui-monospace,monospace;color:#fff;background:#4a6fa5}.m.post{background:#3d8361}.m.delete{background:#a64b4b}.m.put{background:#a07a2c}
.s{display:inline-block;padding:0 6px;border-radius:5px;font:700 12px ui-monospace,monospace;background:var(--code)}.s2{color:#3d8361}.s4,.s5{color:#a64b4b}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted)}td:last-child{min-width:140px}
details{margin:6px 0}summary{cursor:pointer}.muted{color:var(--muted)}.note{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:12px 0}
</style></head><body><div class="wrap">
<header style="grid-column:1/-1"><h1>${escapeHtml(info.title ?? "API")}</h1>
<p>${escapeHtml(info.description ?? "")}</p>
<p>Version ${escapeHtml(info.version ?? "")}. Machine-readable spec: <a href="/openapi.json"><code>/openapi.json</code></a> (OpenAPI ${escapeHtml(doc.openapi ?? "3.1")}).</p></header>
<nav class="side" aria-label="Endpoints">${nav}</nav>
<main>
<div class="note"><strong>Using the API.</strong> Every path below is relative to the API host (shown as <code>$API</code> in the examples). The API is read-only: it reads indexed data and returns unsigned transaction data for you to sign yourself. It never holds keys and never sends a transaction for you.
Amounts are decimal strings in USDG (6 decimals) or gear token units (18 decimals). Errors are JSON, <code>{"error": "CODE", "message": "..."}</code>. Requests are limited per client address: every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code>, <code>RateLimit-Reset</code> (seconds) and <code>RateLimit-Policy</code>, and a <code>429</code> answer adds <code>Retry-After</code>.
Public read routes send <code>Cache-Control</code> and an <code>ETag</code>; repeat the request with <code>If-None-Match</code> to get an empty <code>304</code> when nothing changed.</div>
${sections}
</main></div></body></html>`;
}
