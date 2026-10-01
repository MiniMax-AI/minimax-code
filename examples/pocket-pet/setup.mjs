import { cp, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.argv[2])
  throw new Error("Usage: node examples/pocket-pet/setup.mjs <new-directory>");
const target = path.resolve(process.argv[2]);
// Refuse existing destinations so a reproduction cannot overwrite user work.
await mkdir(target, { recursive: false });
await cp(path.join(here, "starter"), target, { recursive: true });
await copyFile(path.join(here, "serve.mjs"), path.join(target, "serve.mjs"));
console.log(
  `Created ${target}. Run node serve.mjs there, then open http://127.0.0.1:4173.`,
);
