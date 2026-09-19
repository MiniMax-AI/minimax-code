import fs from "node:fs";

/** Config documents and their copies can contain plaintext credentials. */
export const PRIVATE_CONFIG_FILE_MODE = 0o600;

/** Remove non-owner access without changing an owner's read-only policy. */
export function restrictConfigFileSync(filePath: string): void {
  if (process.platform === "win32") return;
  const mode = fs.statSync(filePath).mode;
  // Already-private files may live on read-only mounts or be immutable.
  if ((mode & 0o077) === 0) return;
  fs.chmodSync(filePath, mode & 0o700);
}

/** Restrict access before truncating or writing any secret-bearing content. */
export function writePrivateConfigFileSync(
  filePath: string,
  content: string | Buffer,
  exclusive = false,
): void {
  const fd = fs.openSync(
    filePath,
    exclusive ? "wx" : "a",
    PRIVATE_CONFIG_FILE_MODE,
  );
  try {
    fs.fchmodSync(fd, PRIVATE_CONFIG_FILE_MODE);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}
