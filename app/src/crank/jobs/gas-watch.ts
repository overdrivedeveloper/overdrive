// R19: alerts when a bot wallet (crank, hedger, liquidator, vol signer, vol sender) is under its minimum ETH, and again every
// GAS_WATCH_REALERT_HOURS while it stays low, plus one "topped up" note on recovery. Read-only.
import { formatEther, parseEther, type Address } from "viem";
import { KEY_ROLES, resolveAddress, type KeyRoleName } from "../../keys";
import { raiseAlert } from "../alerts";
import type { CrankContext } from "../context";

export interface WatchedWallet { bot: string; address: Address; minWei: bigint }

const MIN_KEYS: Record<string, keyof CrankContext["config"]> = {
  crank: "GAS_WATCH_MIN_ETH_CRANK", hedger: "GAS_WATCH_MIN_ETH_HEDGER", liquidator: "GAS_WATCH_MIN_ETH_LIQUIDATOR",
  volSigner: "GAS_WATCH_MIN_ETH_VOL_SIGNER", volSender: "GAS_WATCH_MIN_ETH_VOL_SENDER",
};

/** The wallets to watch: every role whose key is configured in `env` (public addresses only; no key leaves keys.ts). */
export function watchedWallets(context: Pick<CrankContext, "config">, env: Record<string, string | undefined> = process.env): WatchedWallet[] {
  const out: WatchedWallet[] = [];
  for (const [bot, key] of Object.entries(MIN_KEYS)) {
    const address = resolveAddress(KEY_ROLES[bot as KeyRoleName], env);
    if (address) out.push({ bot, address, minWei: parseEther(String(context.config[key])) });
  }
  return out;
}

export function createGasWatchJob(context: CrankContext, deps: { wallets?: WatchedWallet[]; nowMs?: () => number; notify?: (text: string) => Promise<void> } = {}) {
  const nowMs = deps.nowMs ?? Date.now;
  const below = new Map<string, boolean>();
  return async (): Promise<Record<string, unknown>> => {
    const wallets = deps.wallets ?? watchedWallets(context);
    const realertMs = context.config.GAS_WATCH_REALERT_HOURS * 3_600_000;
    const summary: Record<string, string> = {};
    for (const w of wallets) {
      const balance = await context.clients.stateClient.getBalance({ address: w.address });
      summary[w.bot] = formatEther(balance);
      if (balance < w.minWei) {
        below.set(w.bot, true);
        await raiseAlert(context, {
          key: `gas:${w.bot}`, level: "warn",
          text: `Gas is low on the ${w.bot} wallet ${w.address}: ${formatEther(balance)} ETH (alert level ${formatEther(w.minWei)} ETH). Send ETH on chain ${context.config.CHAIN_ID}.`,
        }, { quietMs: realertMs, now: nowMs() });
      } else if (below.get(w.bot)) {
        below.set(w.bot, false);
        const note = `Topped up: the ${w.bot} wallet ${w.address} now has ${formatEther(balance)} ETH.`;
        if (deps.notify) await deps.notify(note);
        else await raiseAlert(context, { key: `gas-ok:${w.bot}:${nowMs()}`, level: "warn", text: note }, { quietMs: 0, now: nowMs() });
      }
    }
    return { wallets: wallets.length, balances: summary, below: [...below].filter(([, v]) => v).map(([k]) => k) };
  };
}
