// Owner-only provisioning; never imported by public web handling.
import { psql } from "./migrate.mjs";
import { assertProvisionTarget } from "./target-registry.mjs";
import { publicPrivilegeCheck } from "./public-read.mjs";

export function provisionPublicScript(role) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
    throw new Error("Invalid role name");
  return `BEGIN;
GRANT USAGE ON SCHEMA darkpool_public TO "${role}";
GRANT SELECT ON darkpool_public.markets TO "${role}";
SET LOCAL ROLE "${role}";
${publicPrivilegeCheck.replace("current_user = session_user", "true")} AS permitted \\gset
\\if :permitted
COMMIT;
\\else
ROLLBACK;
SELECT 1/0;
\\endif
`;
}
if (process.argv[1]?.endsWith("public-provision.mjs")) {
  try {
    assertProvisionTarget(process.argv[2], "read");
    await psql(provisionPublicScript(process.argv[2] ?? ""));
    process.stdout.write("PASS: restricted public view reader granted\n");
  } catch {
    process.stderr.write(
      "Public reader provisioning rejected or unavailable\n",
    );
    process.exitCode = 1;
  }
}
