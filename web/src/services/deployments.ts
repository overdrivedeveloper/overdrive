// The committed deployment files (app/deployments/<chain>.json) are the allowlist the wallet flow checks intents against.
// In `--mode fork` the git-ignored fork-stack record is added so the local stack can be exercised; a production build
// only ever matches committed files with deployed contracts.
import type {DeploymentFile} from './allowlist';

const committed = import.meta.glob('../../../app/deployments/*.json', {eager: true, import: 'default'}) as Record<string, unknown>;
const local = import.meta.glob('../../../app/deployments/local/*.json', {eager: true, import: 'default'}) as Record<string, unknown>;

const usable = (d: unknown): d is DeploymentFile => {
  const x = d as Partial<DeploymentFile> | null;
  return !!x && typeof x.chainId === 'number' && !!x.contracts && /^0x[0-9a-fA-F]{40}$/.test(String(x.contracts.ODMinter ?? '')) && Array.isArray(x.gears);
};

export function deploymentFor(chainId: number): DeploymentFile | null {
  const pool = [...Object.values(committed), ...(import.meta.env.MODE === 'fork' ? Object.values(local) : [])];
  return pool.filter(usable).find((d) => d.chainId === chainId) ?? null;
}
