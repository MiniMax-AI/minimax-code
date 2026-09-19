import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { withoutProxyEnvironment } from "./offline-environment.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
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
      await t.test(`offline BYOK ignores ambient proxies: ${label}`, async () => {
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
      });
    }
    const configPath = path.join(dataDir, "config.yaml");
    const savedConfig = () => parseYaml(readFileSync(configPath, "utf8"));
    assert.equal(savedConfig().defaultModel, "minimax/MiniMax-M3");
    assert.equal(savedConfig().custom_provider.fixture.models["fixture-model"].limit, undefined);
    assert.equal(selected.active, false);
    assert.equal(selected.models[0].contextLimit, undefined);
    assert.equal(selected.models[0].maxOutputTokens, undefined);

    const addArgs = [
      "provider", "add", "--name", "Limited", "--base-url", baseUrl,
      "--api-format", "openai-completions", "--model", "fixture-model",
      "--model", "second-model", "--context-limit", "32768", "--output-limit", "4096", "--use",
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
      ]);
      assert.deepEqual(savedConfig().custom_provider[name].models["fixture-model"].limit, limit);
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
    writeFileSync(configPath, stringifyYaml(effortConfig));
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
