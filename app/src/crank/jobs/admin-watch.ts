// R18: alerts on every timelock CallScheduled, CallExecuted and Cancelled, on a change of code at the owner and guardian
// addresses, and on any pause action by a guardian. Read-only: it never sends a transaction.
import { keccak256, type Address } from "viem";
import { raiseAlert } from "../alerts";
import { readJobMeta, saveJobMeta, type CrankContext } from "../context";

interface AdminRow { block: string; tx_hash: string; log_index: number; source: string; kind: string; op_id: string | null; target: string | null; eta: Date | string | null; ts: Date | string }
interface PauseRow { block: string; tx_hash: string; log_index: number; scope: string; ref: string | null; action: string; actor: string | null; reason: string | null; ts: Date | string }

export function createAdminWatchJob(context: CrankContext) {
  return async (): Promise<Record<string, unknown>> => {
    const meta = await readJobMeta(context, "admin-watch");
    // Cursors are block numbers: the indexer writes a whole block at once, so "block greater than the last seen" is exact.
    const since = typeof meta.sinceBlock === "string" ? meta.sinceBlock : "-1";
    const sincePause = typeof meta.sincePauseBlock === "string" ? meta.sincePauseBlock : "-1";
    const events = await context.sql<AdminRow[]>`
      select block::text, tx_hash, log_index, source, kind, op_id, target, eta, ts from admin_events where block > ${since}::bigint order by block, log_index limit 200`;
    const pauses = await context.sql<PauseRow[]>`
      select block::text, tx_hash, log_index, scope, ref, action, actor, reason, ts from pause_log where block > ${sincePause}::bigint order by block, log_index limit 200`;
    let alerts = 0;
    for (const e of events) {
      const eta = e.eta ? ` (earliest execution ${new Date(e.eta).toISOString()})` : "";
      const label = e.source === "timelock"
        ? { scheduled: "The timelock scheduled a call", executed: "The timelock executed a call", cancelled: "The timelock cancelled a call" }[e.kind] ?? `The timelock reported ${e.kind}`
        : `A guardian action (${e.kind})`;
      await raiseAlert(context, { key: `admin:${e.tx_hash}:${e.log_index}`, level: e.source === "timelock" && e.kind === "executed" ? "critical" : "warn", text: `${label}: op ${e.op_id ?? "?"} target ${e.target ?? "?"}${eta}`, meta: { tx: e.tx_hash } }, { quietMs: Number.MAX_SAFE_INTEGER });
      alerts++;
    }
    for (const p of pauses) {
      await raiseAlert(context, { key: `pause:${p.tx_hash}:${p.log_index}`, level: "critical", text: `Buys ${p.action === "pause" ? "paused" : "unpaused"} (${p.scope}${p.ref ? ` ${p.ref}` : ""}${p.actor ? ` by ${p.actor}` : ""}${p.reason ? `: ${p.reason}` : ""})`, meta: { tx: p.tx_hash } }, { quietMs: Number.MAX_SAFE_INTEGER });
      alerts++;
    }
    // Code at the owner and guardian addresses: record a hash on first sight, alert when it changes.
    const watched: Record<string, string> = { owner: context.deployment.admin.ownerSafe, guardian: context.deployment.admin.guardianSafe };
    const codeHashes: Record<string, string> = (meta.codeHashes as Record<string, string> | undefined) ?? {};
    for (const [name, address] of Object.entries(watched)) {
      const code = await context.clients.stateClient.getCode({ address: address as Address }).catch(() => undefined);
      if (code === undefined) continue;
      const hash = !code || code === "0x" ? "none" : keccak256(code);
      const prior = codeHashes[name];
      if (prior !== undefined && prior !== hash) {
        await raiseAlert(context, { key: `code:${name}:${hash}`, level: "critical", text: `The code at the ${name} address ${address} changed (${prior === "none" ? "code appeared" : "code replaced"})` }, { quietMs: Number.MAX_SAFE_INTEGER });
        alerts++;
      }
      codeHashes[name] = hash;
    }
    await saveJobMeta(context, "admin-watch", { codeHashes, sinceBlock: events.at(-1)?.block ?? since, sincePauseBlock: pauses.at(-1)?.block ?? sincePause });
    return { events: events.length, pauses: pauses.length, alerts };
  };
}
