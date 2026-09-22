import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const LOCAL_NTFS_REQUIREMENT =
  "Windows source checkouts must be on a local NTFS volume. pnpm workspace links require NTFS junctions; FAT32/exFAT volumes and network shares are not supported. Keep cloud-synced folders outside the checkout.";

function fail(reason) {
  return { ok: false, reason: `${LOCAL_NTFS_REQUIREMENT} ${reason}` };
}

/**
 * Validate the Windows volume before pnpm attempts to create workspace links.
 *
 * The function is exported so the platform-specific policy can be tested without
 * requiring a Windows host. Non-Windows platforms are intentionally a no-op.
 */
export function checkWindowsSourceLocation({
  platform = process.platform,
  cwd = process.cwd(),
  execFile = execFileSync,
  allowNonFixed = process.env.GITHUB_ACTIONS === "true",
} = {}) {
  if (platform !== "win32") return { ok: true, skipped: true };

  const pathApi = platform === "win32" ? path.win32 : path;
  const root = pathApi.parse(pathApi.resolve(cwd)).root;
  if (!/^[a-z]:\\$/iu.test(root) || root.startsWith("\\\\")) {
    return fail("The checkout root is not a local drive-letter path.");
  }
  // `fsutil` accepts a drive letter more reliably than a root path with a
  // trailing backslash across Windows runner images.
  const volume = root.slice(0, 2);

  let driveType;
  let volumeInfo;
  try {
    driveType = execFile("fsutil", ["fsinfo", "drivetype", volume], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    volumeInfo = execFile("fsutil", ["fsinfo", "volumeinfo", volume], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    return fail(`Windows could not verify the checkout volume${detail}.`);
  }

  if (!allowNonFixed && !/:\s*DRIVE_FIXED(?:\r?\n|$)/iu.test(driveType)) {
    return fail("The checkout volume is not a local fixed drive.");
  }
  if (!/:\s*NTFS(?:\r?\n|$)/iu.test(volumeInfo)) {
    return fail("The checkout volume is not formatted as NTFS.");
  }

  return { ok: true, skipped: false };
}

export function runWindowsSourceLocationCheck({
  platform = process.platform,
  cwd = process.cwd(),
  execFile = execFileSync,
  allowNonFixed = process.env.GITHUB_ACTIONS === "true",
  report = (message) => console.error(`[source-check] ${message}`),
} = {}) {
  const result = checkWindowsSourceLocation({ platform, cwd, execFile, allowNonFixed });
  if (!result.ok) report(result.reason);
  return result;
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (scriptPath === fileURLToPath(import.meta.url)) {
  const result = runWindowsSourceLocationCheck();
  if (!result.ok) process.exitCode = 1;
}
