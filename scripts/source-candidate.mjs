import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { extractSourceArchive } from "./lib/source-archive.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    archive: { type: "string" },
    revision: { type: "string" },
    destination: { type: "string" },
    reports: { type: "string" },
  },
});
const [command] = positionals;
if (
  positionals.length !== 1 ||
  !["unpack", "finalize"].includes(command) ||
  !values.archive ||
  !/^[a-f0-9]{40}$/u.test(values.revision ?? "")
)
  throw new Error("Expected unpack/finalize, --archive and a full --revision");
const archive = path.resolve(values.archive);
const receipt = JSON.parse(readFileSync(`${archive}.json`, "utf8"));
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (
  receipt.schemaVersion !== 1 ||
  receipt.revision !== values.revision ||
  receipt.sha256 !== digest ||
  receipt.format !== "source-only-no-git-history" ||
  receipt.publicationPerformed !== false
)
  throw new Error("Candidate archive or revision does not match its receipt");

if (command === "unpack") {
  if (!values.destination) throw new Error("Missing --destination");
  // Refuse an existing directory, including a directory containing stale builds.
  mkdirSync(values.destination);
  await extractSourceArchive(archive, path.resolve(values.destination));
  console.log(
    `Authenticated and extracted source revision ${receipt.revision}`,
  );
} else {
  if (!values.reports) throw new Error("Missing --reports");
  const reports = readdirSync(values.reports, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) =>
      JSON.parse(
        readFileSync(
          path.join(values.reports, e.name, "verification.json"),
          "utf8",
        ),
      ),
    );
  // Windows validation is temporarily paused in the candidate workflow.
  const requiredPlatforms = ["linux", "darwin"];
  if (
    reports.length !== requiredPlatforms.length ||
    new Set(reports.map((r) => r.platform)).size !== requiredPlatforms.length ||
    reports.some(
      (r) =>
        !requiredPlatforms.includes(r.platform) ||
        r.status !== "PASS" ||
        r.profile !== "archive" ||
        r.revision !== receipt.revision ||
        !r.gates?.length ||
        r.gates.some((g) => !["PASS", "SKIP"].includes(g.status)),
    )
  )
    throw new Error(
      "Candidate requires successful same-revision archive reports from Linux and macOS",
    );
  const manifest = {
    schemaVersion: 1,
    revision: receipt.revision,
    sha256: digest,
    publicationPerformed: false,
    validation: reports.map((r) => ({
      platform: r.platform,
      arch: r.arch,
      node: r.node,
      profile: r.profile,
      status: r.status,
    })),
  };
  writeFileSync(
    path.join(path.dirname(archive), "candidate.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  console.log(
    `Source candidate verified on Linux and macOS: ${receipt.revision}`,
  );
}
