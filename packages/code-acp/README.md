# @minimax-ai/code-acp

Zero-dependency Agent Client Protocol (ACP) launcher for [MiniMax Code](https://agent.minimax.io), designed for the [ACP registry](https://github.com/agentclientprotocol/registry) and external clients via `npx`:

```sh
npx -y @minimax-ai/code-acp@<version> acp
```

`@minimax-ai/code` ships two binaries (`mcode` and `mcode-tools`), so `npx @minimax-ai/code acp` cannot automatically choose an entrypoint, and the full CLI package includes native runtime dependencies. `@minimax-ai/code-acp` stays **zero-dependency** with a single `code-acp` binary and resolves `mcode` in order:

1. **Isolated release cache**: reuses `~/.minimax-code/acp-releases/@minimax-ai__code@<version>-abi<abi>` immediately when ready.
2. **Adjacent or local installation**: reuses a version-compatible `@minimax-ai/code` from adjacent `node_modules`, the official installer (`~/.minimax-code/current`), or `PATH` while preserving the Node runtime ABI bound to that installation.
3. **Cold-start instant handshake + isolated bootstrap**: when no compatible `mcode` is installed yet, `code-acp acp` answers ACP `initialize` immediately on stdio so clients do not hit startup timeouts while bootstrapping `@minimax-ai/code@<version>` from `https://registry.npmjs.org/` (overridable via `MCODE_ACP_NPM_REGISTRY`) into `~/.minimax-code/acp-releases/` (overridable via `MCODE_ACP_CACHE_DIR`) using an isolated npm configuration that forwards only proxy settings. Once installed, it replays the handshake to `mcode acp` and bridges subsequent session traffic transparently.

**Release rule:** publish `@minimax-ai/code-acp` at the matching `@minimax-ai/code` version with zero runtime dependencies.
