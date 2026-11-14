// Funds addresses on the anvil fork (todo 22 R3): ETH with anvil_setBalance, USDG by impersonating a large REAL holder and
// calling transfer. Never storage writes for token balances, and never the v4 PoolManager as the source: this stack trades
// through v4 pools, so moving the PoolManager's USDG would corrupt them. Its balance is asserted unchanged after funding.
// Fork only: refuses any node but a local anvil on chain 31337.
//
//   bun scripts/fork/fund.ts <address...> [--usdg N] [--eth N]        defaults: 100000 USDG, 10 ETH
// Holder: FUND_USDG_HOLDER, else config/deploy.fork.json usdgHolder.
import { formatUnits, getAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { assertFork, erc20Abi, impersonated, loadDeployment, loadForkConfig } from "./lib";

export interface Funded { address: Address; usdg: bigint; eth: bigint; hash?: Hex }

export function usdgHolder(): Address {
  const h = getAddress(process.env.FUND_USDG_HOLDER ?? loadForkConfig().usdgHolder);
  if (h === "0x0000000000000000000000000000000000000000") throw new Error("no USDG holder set (config/deploy.fork.json usdgHolder)");
  return h;
}

export async function fund(targets: Address[], usdg: number, eth: number, holder = usdgHolder()): Promise<Funded[]> {
  const { pub, test } = await assertFork();
  const dep = loadDeployment();
  const token = getAddress(dep.external.usdg!);
  const poolManager = getAddress(dep.external.poolManager!);
  if (holder === poolManager) throw new Error("fund: the v4 PoolManager is never a funding source");
  const pmBefore = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [poolManager] });
  const out: Funded[] = [];
  const wallet = usdg > 0 ? await impersonated(test, holder) : undefined;
  try {
    for (const address of targets) {
      if (eth > 0) await test.setBalance({ address, value: parseEther(String(eth)) });
      let hash: Hex | undefined;
      if (usdg > 0 && wallet) {
        const amount = parseUnits(String(usdg), 6);
        const held = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
        if (held < amount) throw new Error(`holder ${holder} has only ${formatUnits(held, 6)} USDG`);
        hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [address, amount], chain: null, account: holder });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`USDG transfer to ${address} reverted (${hash})`);
      }
      const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      out.push({ address, usdg: bal, eth: await pub.getBalance({ address }), ...(hash ? { hash } : {}) });
    }
  } finally {
    if (wallet) await test.stopImpersonatingAccount({ address: holder });
  }
  const pmAfter = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [poolManager] });
  if (pmAfter !== pmBefore) throw new Error(`fund: PoolManager USDG changed ${pmBefore} -> ${pmAfter}`);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
  };
  const usdg = opt("usdg", 100_000);
  const eth = opt("eth", 10);
  const targets = args.map((a) => getAddress(a));
  if (!targets.length) throw new Error("usage: bun scripts/fork/fund.ts <address...> [--usdg N] [--eth N]");
  for (const r of await fund(targets, usdg, eth)) {
    console.log(`fund: ${r.address} ${formatUnits(r.usdg, 6)} USDG, ${formatUnits(r.eth, 18)} ETH${r.hash ? ` (${r.hash})` : ""}`);
  }
}
