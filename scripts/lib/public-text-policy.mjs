// Text that must never appear in published source or npm packages. Shared by
// `check:source` and package release checks so the two cannot drift apart.
export const internalSourceReference =
  /(?:[\w.-]+\.xaminim\.com|weaver\/idl|@mavis\/thrift-gen|\/Users\/minimax(?:\/|\b)|\/archon\/internal\/api\/)/u;
export const embeddedCredential =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{100,}|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9_-]{32,}/u;
