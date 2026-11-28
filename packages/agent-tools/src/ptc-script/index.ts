/**
 * Host-neutral PTC script contracts: the Host port, its roots and the save
 * environment. Type-only, so this entry loads no Node IO. The factory that
 * writes a script owns the filesystem and stays behind a Host port.
 */
export type { PtcScriptHost, PtcScriptRoots } from '../desktop/ptc-script-roots.js';
export type { PtcScriptSaveEnvironment } from '../desktop/ptc-script-save.js';
