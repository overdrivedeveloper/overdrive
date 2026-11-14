// The hosted flavour of this server: read only, no key, no write tools. It is not a separate code path: it is `buildMcp`
// with no agent key, which registers READ_TOOLS only (tools.ts, R1). This module names that contract in one place.
import { READ_TOOLS } from "./tools";

export const PUBLIC_TOOLS = READ_TOOLS;
export const PUBLIC_TOOL_NAMES = READ_TOOLS.map((t) => t.name);
