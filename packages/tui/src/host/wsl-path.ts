import { execFile } from "node:child_process";
import { platform, release } from "node:os";
import { posix } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Translate Windows absolute paths before the host's POSIX resolver sees them. */
export async function resolveWslPath(
  reference: string,
  signal?: AbortSignal,
): Promise<string> {
  if (
    !/^(?:[a-z]:[\\/]|\\\\)/iu.test(reference) ||
    platform() !== "linux" ||
    !(
      process.env.WSL_DISTRO_NAME ||
      process.env.WSL_INTEROP ||
      process.env.WSLENV ||
      /microsoft/iu.test(release())
    )
  ) {
    return reference;
  }

  // Use the distro's converter so custom automount roots and mounted drives work.
  // execFile keeps spaces, backslashes and shell metacharacters in one literal argument.
  try {
    const { stdout } = await executeFile("wslpath", ["-a", "-u", reference], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    const mapped = stdout.replace(/\r?\n$/u, "");
    if (!posix.isAbsolute(mapped) || /[\r\n\0]/u.test(mapped)) {
      throw new Error("wslpath did not return an absolute Linux path.");
    }
    return mapped;
  } catch (error) {
    throw new Error(
      "Could not convert the Windows path with wslpath. Use an accessible Linux path instead.",
      { cause: error },
    );
  }
}
