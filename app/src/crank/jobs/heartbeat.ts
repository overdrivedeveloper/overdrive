// R2, R3: every 30 s writes the heartbeat file and the `crank` service row, and checks the single-instance lock. The file stops
// updating while a nonce is held past 10 minutes, so the orchestrator flags (and may restart) a stuck crank.
import { writeFile } from "node:fs/promises";
import type { ServiceLock } from "../../lib/jobs";
import type { CrankContext } from "../context";
import { HELD_NONCE_STUCK_MS } from "../tx";

export interface HeartbeatOptions {
  file: string;
  lock?: Pick<ServiceLock, "check"> | undefined;
  /** Called once when the lock is lost: the process must stop with exit code 1 (R2). */
  onLockLost: () => void;
  now?: () => number;
}

export function createHeartbeatJob(context: CrankContext, options: HeartbeatOptions) {
  const now = options.now ?? Date.now;
  return async (): Promise<Record<string, unknown>> => {
    if (options.lock && (await options.lock.check()) === "lost") {
      context.logger.fatal("The crank lost its single-instance lock to another instance; stopping");
      options.onLockLost();
      return { ready: false, lockLost: true };
    }
    const status = context.tx.status();
    const held = status.heldNonce !== null;
    const heldMs = status.heldSince ? now() - Date.parse(status.heldSince) : 0;
    const beating = heldMs < HELD_NONCE_STUCK_MS;
    if (beating) await writeFile(options.file, new Date(now()).toISOString());
    const meta = { ready: !held, dryRun: context.config.CRANK_DRY_RUN, signer: context.clients.walletClient?.account?.address, tx: status, heartbeatFile: beating };
    if (held) {
      const message = `Crank nonce ${status.heldNonce} is held awaiting resolution`;
      await context.sql`insert into service_status (job, last_run, last_error, meta) values ('crank', now(), ${message}, ${JSON.stringify(meta)}::jsonb)
        on conflict (job) do update set last_run = now(), last_error = excluded.last_error, meta = service_status.meta || excluded.meta`;
    } else {
      await context.sql`insert into service_status (job, last_run, last_ok, meta) values ('crank', now(), now(), ${JSON.stringify(meta)}::jsonb)
        on conflict (job) do update set last_run = now(), last_ok = now(), last_error = null, meta = service_status.meta || excluded.meta`;
    }
    return meta;
  };
}
