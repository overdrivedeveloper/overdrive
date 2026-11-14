// Web flow W01 (todo 22d, not part of the 22d row set A01-A08, M01-M04, P01-P02): the fork-profile browser check at 1440 and 390 px
// is run by hand from docs/runbooks/browser-testing.md. Here the row records whether the fork web server is up and, if it is not,
// blocks with the reason instead of passing.
import { PORTS } from "../lib";
import type { Flow } from "./harness";

export const flows: Flow[] = [{
  id: "W01", area: "web", kind: "success", name: "fork-profile browser check at 1440 and 390 px (manual, see docs/runbooks/browser-testing.md)",
  async run(row) {
    const up = await fetch(`http://127.0.0.1:${PORTS.web}/`).then((r) => r.ok).catch(() => false);
    if (!up) row.blocked(`the fork web server is not running on ${PORTS.web} (web dependencies are not installed in this worktree; bun install in web/ then up.sh)`);
    row.blocked("server is up but the screenshots are taken by hand; follow docs/runbooks/browser-testing.md");
  },
}];
