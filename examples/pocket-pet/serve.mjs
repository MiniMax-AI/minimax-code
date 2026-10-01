import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bind only to loopback. Serve this example, never the repository or a parent.
const here = path.dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] ?? ".";
if (![".", "starter", "finished"].includes(variant)) {
  throw new Error(
    "Choose starter or finished, or omit the argument in a copied project.",
  );
}
const root = await realpath(path.resolve(here, variant));
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
};
const server = createServer(async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const name = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname,
    );
    const target = await realpath(path.resolve(root, `.${name}`));
    if (
      !target.startsWith(`${root}${path.sep}`) ||
      !(await stat(target)).isFile()
    ) {
      res.writeHead(404).end("Not found");
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": `${types[path.extname(target)] ?? "application/octet-stream"}; charset=utf-8`,
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "Port 4173 is in use. Stop the other example server, then retry."
      : error.message,
  );
  process.exitCode = 1;
});
server.listen(4173, "127.0.0.1", () =>
  console.log("Pocket Pet: http://127.0.0.1:4173 (Ctrl+C to stop)"),
);
