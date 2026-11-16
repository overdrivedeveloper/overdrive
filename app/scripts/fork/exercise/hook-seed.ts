// D26 hook seed on a fork: run contracts/script/HookSeed.s.sol (deploy the helper, write the owner Safe's batch) and read
// the Safe Transaction Builder JSON it writes. Used by flow SH10 (shutdown.ts); the parser is unit tested (hook-seed.test.ts).
import { join } from "node:path";
import { type Address, type Hex, getAddress, isAddress, isHex } from "viem";
import { ANVIL_URL, ROOT } from "../lib";

export interface SafeTx { to: Address; value: bigint; data: Hex }

/** The transactions of a Safe Transaction Builder batch, validated (address, zero value, hex calldata with a selector). */
export function parseSafeBatch(text: string): { chainId: string; name: string; txs: SafeTx[] } {
  const j = JSON.parse(text) as { chainId?: unknown; meta?: { name?: unknown }; transactions?: unknown };
  if (typeof j.chainId !== "string" || !/^\d+$/.test(j.chainId)) throw new Error("batch: chainId missing");
  if (!Array.isArray(j.transactions) || j.transactions.length === 0) throw new Error("batch: no transactions");
  const txs = j.transactions.map((t: { to?: unknown; value?: unknown; data?: unknown }, i: number) => {
    if (typeof t.to !== "string" || !isAddress(t.to)) throw new Error(`batch tx ${i}: bad to`);
    if (t.value !== "0") throw new Error(`batch tx ${i}: value must be "0"`);
    if (typeof t.data !== "string" || !isHex(t.data) || t.data.length < 10) throw new Error(`batch tx ${i}: bad data`);
    return { to: getAddress(t.to), value: 0n, data: t.data as Hex };
  });
  return { chainId: j.chainId, name: String(j.meta?.name ?? ""), txs };
}

/** One `forge script` run from contracts/ against the fork node; `sender` broadcasts as an unlocked anvil account. */
export function forgeScript(target: string, env: Record<string, string>, sender?: Address): string {
  const args = ["script", target, "--rpc-url", ANVIL_URL, ...(sender ? ["--broadcast", "--unlocked", "--sender", sender] : [])];
  const p = Bun.spawnSync([`${process.env.HOME}/.foundry/bin/forge`, ...args], {
    cwd: join(ROOT, "contracts"), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const out = p.stdout.toString();
  if (p.exitCode !== 0) throw new Error(`forge script ${target} failed: ${(p.stderr.toString() + out).slice(-600)}`);
  return out;
}

/** The value logged by the script after `label` (an address or a path). */
export function logged(out: string, label: string): string {
  const m = out.match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\S+)`));
  if (!m) throw new Error(`forge output has no "${label}"`);
  return m[1]!;
}
