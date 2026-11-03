#!/usr/bin/env node
// The stdio JSON-RPC server one Neovim spawns (see src/server.mjs).
import {serve} from '../src/server.mjs';

if (!process.getBuiltinModule?.('node:sqlite')) {
  process.stderr.write(`semantic-grep needs Node 22.13 or later (node:sqlite); this is ${process.version}\n`);
  process.exit(1);
}
await serve();
process.exit(0);
