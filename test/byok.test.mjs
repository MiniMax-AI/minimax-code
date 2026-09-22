import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { withoutProxyEnvironment } from "./offline-environment.mjs";

const cli = process.env.MCODE_TEST_CLI ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url));
// This fixture validates BYOK transport and real Runtime persistence, not model quality.
test(
  "BYOK runs without managed login and resumes its saved conversation",
  { timeout: 90000 },
  async (t) => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "minimax-code-byok-"));
    const dataDir = path.join(fixtureDir, "data");
    const workspaceDir = path.join(fixtureDir, "workspace");
    mkdirSync(workspaceDir);
    const dbPath = path.join(dataDir, "v2", "sqlite", "runtime-state.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new Database(dbPath);
    try {
      // An upgrade must ignore a previously enabled cloud-indexing preference.
      legacyDb.exec(`
        CREATE TABLE local_runtime_preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        INSERT INTO local_runtime_preferences VALUES ('workspace-indexing-enabled', 'true');
      `);
    } finally {
      legacyDb.close();
    }
    const requests = [];
    const readMarker = `ACTUAL_FILE_CONTENT_${Date.now()}`;
    writeFileSync(path.join(workspaceDir, "read-fixture.txt"), readMarker);
    let toolRequested = false;
    let rejectConnection = false;
    const networkAudit = path.join(dataDir, "network-audit.log");
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      if (rejectConnection) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({ error: { message: "Synthetic invalid credential" } }),
        );
        return;
      }
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "fixture",
            object: "chat.completion",
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "LOCAL_BYOK_OK" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (
        JSON.stringify(body.messages).includes("TOOL_READ_TEST") &&
        !toolRequested
      ) {
        toolRequested = true;
        assert.ok(body.tools?.some((tool) => tool.function?.name === "read"));
        for (const delta of [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-fixture-call",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({
                          path: path.join(workspaceDir, "read-fixture.txt"),
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...delta })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
        return;
      }
      for (const chunk of [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "LOCAL_BYOK_OK" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...chunk })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      try {
        assert.equal(
          existsSync(networkAudit),
          false,
          existsSync(networkAudit)
            ? readFileSync(networkAudit, "utf8")
            : "Unexpected external request",
        );
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const env = {
      MINIMAX_DATA_DIR: dataDir,
      MAVIS_DATA_DIR: dataDir,
      MCODE_PROVIDER_API_KEY: "fixture-only-key",
      MCODE_TEST_ALLOWED_ORIGIN: new URL(baseUrl).origin,
      MCODE_TEST_NETWORK_AUDIT: networkAudit,
      MCODE_TEST_MANAGED_OFFLINE: "1",
      MCODE_TEST_PROCESS_PROBE: "1",
      NODE_OPTIONS: `--import=${new URL("./network-deny.mjs", import.meta.url).href}`,
    };
    let commandSequence = 0;
    async function run(args, environment = process.env) {
      const startedAt = Date.now();
      const label = args.slice(0, 2).join(" ");
      const requestCountAtStart = requests.length;
      const diagnosticsDir = path.join(dataDir, `cli-diagnostics-${++commandSequence}`);
      const commandArgs = args[0] === "exec"
        ? [...args, "--diagnostics-dir", diagnosticsDir]
        : args;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...commandArgs], {
          cwd: workspaceDir,
          env: { ...withoutProxyEnvironment(environment), ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        let timeoutError;
        const timer = setTimeout(() => {
          const progressPath = path.join(diagnosticsDir, "progress.jsonl");
          let progress = "No execution progress recorded";
          try {
            if (existsSync(progressPath))
              progress = readFileSync(progressPath, "utf8").slice(-12000);
          } catch (error) {
            progress = `Unable to read execution progress: ${error.message}`;
          }
          timeoutError = new Error(
            `Timed out after ${Date.now() - startedAt}ms: ${label}\n` +
            `Fixture requests during command: ${requests.length - requestCountAtStart}\n` +
            `stdout (tail): ${stdout.slice(-12000)}\nstderr (tail): ${stderr.slice(-12000)}\n` +
            `execution progress (tail): ${progress}`,
          );
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, 35000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          t.diagnostic(`${label}: exit ${code} after ${Date.now() - startedAt}ms`);
          if (timeoutError) {
            reject(timeoutError);
            return;
          }
          code === 0
            ? resolve(stdout)
            : reject(new Error(`CLI exited ${code}: ${stderr}\n${stdout}`));
        });
      });
    }
    await run([
      "provider",
      "add",
      "--name",
      "Fixture",
      "--base-url",
      baseUrl,
      "--api-format",
      "openai-completions",
      "--model",
      "fixture-model",
    ]);
    assert.equal(requests.length, 0, "Adding without --use must not test or activate");
    const snapshot = JSON.parse(await run(["provider", "list", "--json"]));
    assert.equal(
      snapshot.providers.some((p) => p.kind === "minimax-oauth"),
      true,
    );
    const selected = snapshot.providers.find(
      (p) => p.kind === "custom" && p.name === "Fixture",
    );
    assert.ok(selected?.hasApiKey);
    const proxyNames = [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    ];
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !proxyNames.includes(name)),
    );
    const proxyValue = (name) => name.toLowerCase() === "no_proxy"
      ? "*"
      : "http://127.0.0.1:9";
    for (const [label, proxies] of [
      ["no proxy", {}],
      ...proxyNames.map((name) => [name, { [name]: proxyValue(name) }]),
      ["uppercase and lowercase together", Object.fromEntries(
        proxyNames.map((name) => [name, proxyValue(name)]),
      )],
    ]) {
      // Node 24.0–24.2 returns undefined from t.test(), so awaiting it does
      // not wait for the proxy checks. Keep this shared-fixture phase directly
      // sequential before changing rejectConnection or checking request counts.
      // https://github.com/nodejs/node/issues/58227
      t.diagnostic(`offline BYOK ignores ambient proxies: ${label}`);
      const environment = Object.freeze({ ...cleanEnvironment, ...proxies });
      // NO_PROXY alone does not enable proxy mode, so check its isolation explicitly.
      const isolated = withoutProxyEnvironment(environment);
      for (const name of proxyNames) assert.equal(isolated[name], "");
      assert.equal(isolated.PATH, environment.PATH);
      const beforeRequests = requests.length;
      const managedAudit = `${networkAudit}.managed`;
      const beforeManaged = readFileSync(managedAudit, "utf8").length;
      await run([
        "provider", "test", selected.providerId, "--model", "fixture-model",
      ], environment);
      assert.ok(requests.length > beforeRequests, "The local provider must receive the request");
      assert.equal(requests[beforeRequests].body.model, "fixture-model");
      assert.match(
        readFileSync(managedAudit, "utf8").slice(beforeManaged),
        /https:\/\/models\.dev\/api\.json|\/mavis\/api\/v1\/models-dev\/catalog/,
      );
      assert.equal(existsSync(networkAudit), false, "No outbound network attempt is allowed");
      for (const [name, value] of Object.entries(proxies)) assert.equal(environment[name], value);
    }
    const configPath = path.join(dataDir, "config.yaml");
    const savedConfig = () => parseYaml(readFileSync(configPath, "utf8"));
    assert.equal(savedConfig().defaultModel, "minimax/MiniMax-M3");
    assert.equal(savedConfig().custom_provider.fixture.models["fixture-model"].limit, undefined);
    assert.equal(selected.active, false);
    assert.equal(selected.models[0].contextLimit, undefined);
    assert.equal(selected.models[0].maxOutputTokens, undefined);

    // The selected plan path must survive YAML persistence and actual inference.
    const codingUrl = `${new URL(baseUrl).origin}/api/coding/paas/v4`;
    const beforeCoding = requests.length;
    await run([
      "provider", "add", "--name", "Coding", "--base-url", codingUrl,
      "--api-format", "openai-completions", "--model", "glm-5.3", "--use",
    ]);
    assert.equal(savedConfig().custom_provider.coding.options.baseURL, codingUrl);
    assert.equal(savedConfig().defaultModel, "custom_provider:coding/glm-5.3");
    assert.match(await run([
      "exec", "CODING_ENDPOINT_TEST", "--timeout", "20s", "--max-steps", "1",
    ]), /LOCAL_BYOK_OK/);
    const codingRequests = requests.slice(beforeCoding);
    assert.ok(codingRequests.some(({ body }) => body.stream === true && body.model === "glm-5.3"));
    // Loopback hosts may also receive a separate Responses token-count probe.
    const chatRequests = codingRequests.filter(({ body }) => Array.isArray(body.messages));
    assert.ok(chatRequests.length >= 2, "Both the connection test and inference must use Chat");
    assert.ok(chatRequests.every(({ url }) => url === "/api/coding/paas/v4/chat/completions"));

    const addArgs = [
      "provider", "add", "--name", "Limited", "--base-url", baseUrl,
      "--api-format", "openai-completions", "--model", "fixture-model",
      "--model", "second-model", "--context-limit", "32768", "--output-limit", "4096", "--use",
      "--support-image",
    ];
    const beforeFailure = readFileSync(configPath, "utf8");
    rejectConnection = true;
    await assert.rejects(run(addArgs), /Provider connection test failed.*Nothing was saved/s);
    assert.equal(readFileSync(configPath, "utf8"), beforeFailure);
    rejectConnection = false;
    const beforeAdd = requests.length;
    assert.match(await run(addArgs), /Provider added and selected: Limited/);
    assert.ok(requests.length > beforeAdd, "Activation must test the candidate before saving");
    assert.equal(requests[beforeAdd].body.model, "fixture-model");
    const config = savedConfig();
    assert.equal(config.defaultModel, "custom_provider:limited/fixture-model");
    for (const model of ["fixture-model", "second-model"]) {
      assert.deepEqual(config.custom_provider.limited.models[model].limit, { context: 32768, output: 4096 });
      assert.deepEqual(config.custom_provider.limited.models[model].capabilities, { support_image: true });
    }
    const configured = JSON.parse(await run(["provider", "list", "--json"])).providers.find(
      (provider) => provider.name === "Limited",
    );
    assert.equal(configured.active, true);
    assert.equal(configured.models[0].selected, true);
    for (const model of configured.models) {
      assert.equal(model.contextLimit, 32768);
      assert.equal(model.maxOutputTokens, 4096);
    }
    const beforeSaveOnly = requests.length;
    for (const [name, flag, limit] of [
      ["context-only", "--context-limit", { context: 32768 }],
      ["output-only", "--output-limit", { output: 32768 }],
    ]) {
      await run([
        "provider", "add", "--name", name, "--base-url", baseUrl,
        "--api-format", "openai-completions", "--model", "fixture-model", flag, "32768",
        "--support-image",
      ]);
      assert.deepEqual(savedConfig().custom_provider[name].models["fixture-model"].limit, limit);
      assert.deepEqual(savedConfig().custom_provider[name].models["fixture-model"].capabilities, { support_image: true });
      assert.equal(savedConfig().defaultModel, config.defaultModel);
    }
    assert.equal(requests.length, beforeSaveOnly, "Limits alone must not test or select a model");
    // Exercise the metadata persisted by provider preset import through real
    // config reload, headless validation and the OpenAI-compatible request body.
    const effortConfig = savedConfig();
    effortConfig.custom_provider.fixture.models["kimi-k3"] = {
      reasoning: true,
      thinking: { effortOptions: ["low", "high", "max"] },
    };
    effortConfig.custom_provider.fixture.models["vision-modalities"] = {
      modalities: { input: ["text", "image"], output: ["text"] },
    };
    effortConfig.custom_provider.fixture.models["attachment-only"] = { attachment: true };
    writeFileSync(configPath, stringifyYaml(effortConfig));
    // The packaged command must carry the declaration through saving, a fresh
    // process/config reload, attachment preparation and SDK serialization.
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4n8LwnxLMMGrAqAGjBgwXAwCOqWIfmQV0zAAAAABJRU5ErkJggg==";
    const imagePath = path.join(workspaceDir, "fixture.png");
    writeFileSync(imagePath, Buffer.from(imageBase64, "base64"));
    for (const [model, supportsImage] of [
      ["custom_provider:limited/fixture-model", true],
      ["custom_provider:context-only/fixture-model", true],
      ["custom_provider:fixture/vision-modalities", true],
      ["custom_provider:fixture/fixture-model", false],
      ["custom_provider:fixture/attachment-only", false],
    ]) {
      const beforeImage = requests.length;
      await run(["exec", "IMAGE_INPUT_TEST", "--model", model, "--file", imagePath,
        "--timeout", "20s", "--max-steps", "1"]);
      const turns = requests.slice(beforeImage).filter((r) => r.body.stream === true);
      assert.ok(turns.length > 0, `Expected a runtime request for ${model}`);
      for (const { body } of turns) {
        const images = body.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "image_url")
            : []);
        if (supportsImage) {
          assert.equal(images.length, 1, `Expected an inline image for ${model}`);
          // PNG inputs are transcoded to JPEG by the real attachment pipeline.
          const url = images[0].image_url.url;
          assert.match(url, /^data:image\/jpeg;base64,/);
          const bytes = Buffer.from(url.split(",")[1], "base64");
          assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
          assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9]);
          assert.doesNotMatch(JSON.stringify(body.messages), /current model cannot read this image inline/);
        } else {
          assert.deepEqual(images, [], `${model} must remain text-only`);
          assert.match(JSON.stringify(body.messages), /current model cannot read this image inline/);
        }
      }
    }
    const effortModel = `${selected.providerId}/kimi-k3`;
    for (const effort of ["low", "high", "max"]) {
      const beforeEffort = requests.length;
      await run(["exec", "EFFORT_TEST", "--model", effortModel, "--effort", effort,
        "--timeout", "20s", "--max-steps", "1"]);
      // Background title generation is a separate non-streaming request and
      // does not use the turn's effort selection.
      const modelRequests = requests.slice(beforeEffort).filter(
        (r) => r.body.model === "kimi-k3" && r.body.stream === true,
      );
      assert.ok(modelRequests.length > 0);
      for (const request of modelRequests) assert.equal(request.body.reasoning_effort, effort);
    }
    const beforeInvalidEffort = requests.length;
    await assert.rejects(run(["exec", "EFFORT_TEST", "--model", effortModel,
      "--effort", "medium", "--timeout", "20s", "--max-steps", "1"]),
    /Available levels: low, high, max/);
    assert.equal(requests.length, beforeInvalidEffort, "Invalid effort must fail before transport");
    const modelArgs = ["--model", `${selected.providerId}/fixture-model`];
    // The first run must work through the saved default, without --model or managed login.
    const first = await run([
      "exec",
      "Remember this marker: SOURCE_REPOSITORY_TEST",
      "--timeout",
      "20s",
      "--max-steps",
      "1",
    ]);
    assert.match(first, /LOCAL_BYOK_OK/);
    await assert.rejects(run([
      'exec', 'Managed model still requires its own login',
      '--model', 'minimax/MiniMax-M3', '--timeout', '20s', '--max-steps', '1',
    ]), /Sign in to MiniMax/);
    const beforeResume = requests.length;
    const second = await run([
      "exec",
      "Repeat the marker",
      ...modelArgs,
      "--continue",
      "--timeout",
      "20s",
      "--max-steps",
      "1",
    ]);
    assert.match(second, /LOCAL_BYOK_OK/);
    assert.ok(
      requests
        .slice(beforeResume)
        .some((r) =>
          JSON.stringify(r.body.messages ?? []).includes(
            "SOURCE_REPOSITORY_TEST",
          ),
        ),
      JSON.stringify(
        requests.map((r) => ({ url: r.url, keys: Object.keys(r.body) })),
      ),
    );
    const toolStart = requests.length;
    await run([
      "exec",
      "TOOL_READ_TEST: read read-fixture.txt",
      ...modelArgs,
      "--timeout",
      "20s",
      "--max-steps",
      "3",
    ]);
    assert.equal(toolRequested, true);
    assert.ok(
      requests
        .slice(toolStart)
        .some((r) =>
          r.body.messages?.some(
            (m) =>
              m.role === "tool" &&
              JSON.stringify(m.content).includes(readMarker),
          ),
        ),
      "The real read tool must return file contents to the provider",
    );
    const browserConfig = savedConfig();
    browserConfig.beta = { ...browserConfig.beta, browserUseTooling: true };
    writeFileSync(configPath, stringifyYaml(browserConfig));
    const browserStart = requests.length;
    assert.match(await run([
      "exec", "BROWSER_ENABLED_TEST", ...modelArgs, "--timeout", "20s", "--max-steps", "1",
    ]), /LOCAL_BYOK_OK/);
    assert.ok(requests.length > browserStart,
      "Opting into Browser must still initialize the runtime and complete a model request");
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((r) => r.auth === "Bearer fixture-only-key"));
    assert.equal(
      requests.some((r) => r.body.tools?.some(
        (tool) => tool.function?.name === "workspace_semantic_search",
      )),
      false,
      "The retired workspace search tool must not be exposed to the model",
    );
    assert.equal(
      existsSync(path.join(dataDir, "v2", "workspaces")),
      false,
      "Startup, completed turns and resume must not create indexing artifacts",
    );
    const managedAudit = `${networkAudit}.managed`;
    assert.doesNotMatch(
      existsSync(managedAudit) ? readFileSync(managedAudit, "utf8") : "",
      /workspace-indexing/,
      "No workspace indexing request may be attempted",
    );
    const verificationDb = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(
        verificationDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_runtime_workspace_indexing_%'",
        ).all(),
        [],
        "New runtime databases must not create the retired upload queue",
      );
    } finally {
      verificationDb.close();
    }
  },
);

test(
  "cancelling a contended message write persists an aborted turn rather than a failure",
  // Node terminates children on Windows SIGINT instead of invoking their handler.
  { timeout: 45000, skip: process.platform === "win32" },
  cancellationTest("lock"),
);

test(
  "cancelling a running tool preserves its completed display message",
  { timeout: 45000, skip: process.platform === "win32" },
  cancellationTest("tool"),
);

function cancellationTest(cancellation) {
  return async (t) => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "minimax-code-cancel-write-"));
    const dataDir = path.join(fixtureDir, "data");
    const workspaceDir = path.join(fixtureDir, "workspace");
    const homeDir = path.join(fixtureDir, "home");
    for (const dir of [dataDir, workspaceDir, homeDir]) mkdirSync(dir);
    const dbPath = path.join(dataDir, "v2", "sqlite", "runtime-state.sqlite");
    const networkAudit = path.join(fixtureDir, "network-audit.log");
    let child, holder, holderClosed, cancelTimer, deadline;
    let serverError;
    let cancelledWhileLocked = false;
    let cancelledDuringTool = false;
    const marker = path.join(workspaceDir, "cancel-tool.marker");
    let holderReleased = false;
    const server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (req.url?.endsWith("/responses/input_tokens")) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ input_tokens: 1 }));
          return;
        }
        const content = "SYNTHETIC_CANCELLED_ANSWER";
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              model: "fixture",
              choices: [
                { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
              ],
            }),
          );
          return;
        }
        if (cancellation === "lock") {
          // A separate process releases the lock even when the CLI blocks its event loop.
          holder = spawn(
            process.execPath,
            [
              "-e",
              `
        const Database = require(process.argv[1]);
        const db = new Database(process.argv[2]);
        db.exec('BEGIN IMMEDIATE');
        process.send('locked');
        setTimeout(() => {
          db.exec('COMMIT'); db.close(); process.disconnect();
        }, 1500);
      `,
              createRequire(import.meta.url).resolve("better-sqlite3"),
              dbPath,
            ],
            {
              stdio: ["ignore", "ignore", "inherit", "ipc"],
            },
          );
          holderClosed = once(holder, "close").then(() => {
            holderReleased = true;
          });
          await Promise.race([
            once(holder, "message"),
            holderClosed.then(() => {
              throw new Error("Writer exited before acquiring the lock");
            }),
          ]);
        }
        const delta =
          cancellation === "tool"
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "cancel-tool-call",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "printf started > cancel-tool.marker; sleep 30",
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          {
            choices: [{ index: 0, delta, finish_reason: null }],
          },
          {
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: cancellation === "tool" ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
          res.write(
            `data: ${JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              ...chunk,
            })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
        if (cancellation === "tool") {
          cancelTimer = setInterval(() => {
            if (!existsSync(marker)) return;
            clearInterval(cancelTimer);
            cancelledDuringTool = true;
            child.kill("SIGINT");
          }, 20);
        } else {
          cancelTimer = setTimeout(() => {
            cancelledWhileLocked = !holderReleased;
            child.kill("SIGINT");
          }, 200);
        }
      } catch (error) {
        serverError = error;
        res.writeHead(500).end();
      }
    });
    t.after(async () => {
      clearTimeout(cancelTimer);
      clearTimeout(deadline);
      for (const childProcess of [child, holder]) {
        if (
          childProcess &&
          childProcess.exitCode === null &&
          childProcess.signalCode === null
        ) {
          const closed = once(childProcess, "close");
          childProcess.kill("SIGKILL");
          await closed;
        }
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(fixtureDir, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(
      path.join(dataDir, "config.yaml"),
      stringifyYaml({
        custom_provider: {
          fixture: {
            name: "fixture",
            kind: "custom",
            enabled: true,
            api: "openai-completions",
            options: {
              apiKey: "synthetic-key",
              baseURL: `${origin}/v1`,
              authMode: "api-key",
            },
            models: { fixture: { limit: { context: 32768, output: 4096 } } },
          },
        },
      }),
    );
    child = spawn(
      process.execPath,
      [
        cli,
        "exec",
        "Reply with the synthetic fixture response.",
        "--model",
        "custom_provider:fixture/fixture",
        "--permission",
        "off",
        "--cwd",
        workspaceDir,
        "--timeout",
        "30s",
        "--max-steps",
        "1",
      ],
      {
        cwd: workspaceDir,
        env: {
          ...withoutProxyEnvironment(process.env),
          HOME: homeDir,
          XDG_CONFIG_HOME: path.join(homeDir, "config"),
          XDG_DATA_HOME: path.join(homeDir, "data"),
          MINIMAX_DATA_DIR: dataDir,
          MAVIS_DATA_DIR: dataDir,
          MCODE_TEST_ALLOWED_ORIGIN: origin,
          MCODE_TEST_NETWORK_AUDIT: networkAudit,
          MCODE_TEST_MANAGED_OFFLINE: "1",
          NODE_OPTIONS: `--import=${new URL("./network-deny.mjs", import.meta.url).href}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    deadline = setTimeout(() => child.kill("SIGKILL"), 35000);
    const [code] = await once(child, "close");
    clearTimeout(deadline);
    if (holderClosed) await holderClosed;
    assert.equal(serverError, undefined);
    if (cancellation === "tool") {
      assert.equal(cancelledDuringTool, true, "SIGINT must follow actual Bash execution");
      assert.equal(holder, undefined, "Tool cancellation must not involve a foreign writer");
    } else {
      assert.equal(
        cancelledWhileLocked,
        true,
        "SIGINT must arrive while the foreign writer holds its lock",
      );
    }
    assert.equal(code, 130, `${stdout}\n${stderr}`);
    assert.equal(existsSync(networkAudit), false, "No external requests are allowed");
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT status FROM local_runtime_turn_ingress").all(), [
        { status: "aborted" },
      ]);
      assert.deepEqual(
        db.prepare("SELECT status, error_message FROM local_runtime_sessions").all(),
        [{ status: "aborted", error_message: null }],
      );
      assert.deepEqual(
        db.prepare("SELECT terminal_outcome FROM local_runtime_session_agent_state").all(),
        [{ terminal_outcome: "aborted" }],
      );
      if (cancellation === "tool") {
        const display = db
          .prepare(
            "SELECT data_json FROM local_runtime_message_rows WHERE role = 'assistant'",
          )
          .all()
          .map((row) => JSON.parse(row.data_json));
        assert.equal(
          display.length,
          1,
          "Tool completion must survive reopening display history",
        );
        const calls = display[0].tool_calls ?? [];
        assert.equal(calls.length, 1);
        assert.equal(calls[0].tool_call_id, "cancel-tool-call");
        assert.equal(calls[0].tool_name, "bash");
        assert.ok(
          calls[0].tool_call_result_data,
          "Persist the completed tool result as well as its call",
        );
      }
    } finally {
      db.close();
    }
    const sessionsDir = path.join(dataDir, "v2", "sessions");
    const histories = readdirSync(sessionsDir, { recursive: true }).filter((file) =>
      file.endsWith("messages.jsonl"),
    );
    assert.equal(histories.length, 1);
    const roles = readFileSync(path.join(sessionsDir, histories[0]), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).message?.role);
    assert.deepEqual(
      roles,
      cancellation === "tool" ? ["user", "assistant", "toolResult"] : ["user"],
      "Abort reconciliation must preserve executed tools without retaining cancelled text output",
    );
  };
}
