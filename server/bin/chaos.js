#!/usr/bin/env node
import { main } from '../src/cli.js';
import { cliContext } from '../src/server.js';

process.exitCode = await main(process.argv.slice(2), { ctx: cliContext() });
