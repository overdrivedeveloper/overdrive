import type { ChainEvent, IndexerContext } from "../types";
import { bytes32Text } from "../units";
import { addr, big, id32, iso } from "./common";
import { change } from "./gear";

export async function handleBackerEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const vault = big(event, "vaultId");
  switch (event.eventName) {
    case "VaultOpened":
      return change(context, event, "vault", vault, "opened", { owner: addr(event, "owner"), gear: id32(event, "gearId") });
    case "CollateralMoved":
      return change(context, event, "vault", vault, "collateral", { after: big(event, "collateralAfter") });
    case "Minted":
      await change(context, event, "vault", vault, "minted", { tokens: big(event, "tokens") });
      context.snapshotNeeded = true;
      return;
    case "Repaid":
      await change(context, event, "vault", vault, "repaid", { tokens: big(event, "tokens") });
      context.snapshotNeeded = true;
      return;
    case "BatchSealed": {
      const ids = ((event.args.vaultIds as readonly bigint[] | undefined) ?? []).map((v) => v.toString());
      const batch = big(event, "batchId");
      await change(context, event, "batch", batch, "sealed", { gear: id32(event, "gearId"), sealedValueWad: big(event, "sealedValueWad"), vaultIds: ids });
      for (const id of ids) await change(context, event, "vault", id, "liquidating", {});
      context.kinds.add("liquidation");
      return;
    }
    case "Liquidated": {
      const data = { debtTokens: big(event, "debtTokens"), collateralSeized: big(event, "collateralSeized") };
      await context.tx`
        INSERT INTO liquidations (tx_hash, log_index, block, ts, batch_id, vault_id, debt_tokens, collateral_seized, bonus_usdg, bad_debt_usdg)
        VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${big(event, "batchId")}, ${vault}, ${data.debtTokens},
                ${data.collateralSeized}, ${big(event, "bonusUsdg")}, ${big(event, "badDebtUsdg")})
        ON CONFLICT (tx_hash, log_index) DO NOTHING`;
      await change(context, event, "vault", vault, "liquidated", data);
      await change(context, event, "batch", big(event, "batchId"), "executed", {});
      context.kinds.add("liquidation");
      context.snapshotNeeded = true;
      return;
    }
    case "BatchVoided": {
      const batch = big(event, "batchId");
      const rows = await context.tx<{ vault_ids: string[] }[]>`SELECT vault_ids FROM liquidation_batches WHERE batch_id = ${batch}`;
      await change(context, event, "batch", batch, "voided", { reason: bytes32Text(event.args.reason) });
      for (const id of rows[0]?.vault_ids ?? []) await change(context, event, "vault", String(id), "released", {});
      context.kinds.add("liquidation");
      return;
    }
  }
}
