// KEEP-5: every state-changing function of the contracts the crank can reach, and who calls it. A lever with no caller is a lever
// nobody pulls, so levers.test.ts enumerates the real ABIs and fails on any function missing from this table.
export type LeverCaller =
  | { by: "crank"; job: string }
  | { by: "liquidator" }
  | { by: "other"; reason: string };

/** `Contract.function` -> caller. Permissionless and keeper-gated functions the protocol needs on a schedule are the ones that
 * must name a crank job or the liquidator; everything else says why no scheduled caller exists. */
export const LEVERS: Record<string, LeverCaller> = {
  // permissionless or keeper-gated, pulled on a schedule
  "IODMinter.accrue": { by: "crank", job: "toll" },
  "IODMinter.accrueMany": { by: "crank", job: "toll" },
  "IODMinter.fillQueued": { by: "crank", job: "queued-sells" },
  "IODGovernor.pokeRisk": { by: "crank", job: "risk-monitor" },
  "IODGovernor.setBuysPaused": { by: "crank", job: "risk-monitor" },
  "IODGovernor.moveToExitReserve": { by: "other", reason: "keeper-gated and sized by the hedger when it rebalances cash (todo 16); the crank never moves cash" },
  "IODOracleGuard.poke": { by: "crank", job: "poke" },
  "IODOracleGuard.setBuysPaused": { by: "other", reason: "guardian pause of one market; the crank only pauses through the Governor (R17) and alerts on this one" },
  "IODMarketHours.setSessionsWithKinds": { by: "crank", job: "sessions" },
  "IODFees.distribute": { by: "crank", job: "fees" },
  "IODBacker.sealBatch": { by: "liquidator" },
  "IODBacker.executeBatch": { by: "liquidator" },
};

/** Functions that are state-changing but not levers the crank or liquidator pull: user actions, admin actions behind the timelock,
 * and hook or module callbacks. They are listed by prefix so a new function is still caught, never silently skipped. */
export const NOT_LEVERS: { match: RegExp; reason: string }[] = [
  { match: /^IODMinter\.(buy|buyExactTokens|sell|sellForExactUsdg|queueSell|cancelQueued)$/, reason: "user trade entry points" },
  { match: /^IODMinter\.(hookSwap|settleGear)$/, reason: "hook callback / admin settlement of a delisted gear" },
  { match: /^IODMinter\.(setHook|setStake|setTradeParams)$/, reason: "admin (timelock) wiring of the hook and stake, and trade parameters" },
  { match: /^IODGovernor\.(deposit|mint|withdraw|redeem|requestWithdraw|claim|transfer|transferFrom|approve)$/, reason: "backer and holder actions on the vault" },
  { match: /^IODGovernor\.(on[A-Z]\w*|absorbLiquidation|pay|fundCash|fundExitReserve|sendToHedger|postHedge|setDepositor)$/, reason: "module callbacks and role-gated cash moves (minter, backer, hedger, admin)" },
  { match: /^IODGovernor\.(returnFromHedger)$/, reason: "hedger returns USDG it holds; sized by the hedger (todo 16), never scheduled" },
  { match: /^IODGovernor\.(setMinter|setBacker|setHedger|setParams|setMarketGroup|skim)$/, reason: "admin (timelock) wiring, parameters and the skim of untracked USDG to ODInsurance" },
  { match: /^IODOracleGuard\.setMarket$/, reason: "admin (timelock) market configuration" },
  { match: /^IODMarketHours\.(setHolidays|setFallbackEnabled)$/, reason: "admin (timelock) calendar settings" },
  { match: /^IODFees\.notify$/, reason: "called by the minter and hook as fees arise" },
  { match: /^IODBacker\.(openVault|deposit|withdraw|mint|repay|repayWithUsdg)$/, reason: "backer vault owner actions" },
  { match: /^IODBacker\.(openVaultFor|mintFor|setOperator)$/, reason: "owner-approved operator actions (the agent router, todo 10) and the owner's operator switch" },
  { match: /^IODVolOracle\.(post|setBounds|setSigner|revokeSigner)$/, reason: "the vol engine posts sigma (15); admin sets bounds and signer" },
];
