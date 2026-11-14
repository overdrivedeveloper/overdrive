import { expect, test } from "bun:test";
import { AREAS } from "./index";

test("first_money_rows_present_in_list: every 22c row id is registered in an area", async () => {
  const ids = new Set<string>();
  for (const load of Object.values(AREAS)) for (const f of (await load()).flows) ids.add(f.id);
  for (const id of ["B01", "B02", "B03", "B04", "B05", "B05b", "B06", "B07", "B08", "B09", "B10", "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09"]) expect(ids.has(id)).toBe(true);
});
