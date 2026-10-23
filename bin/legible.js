#!/usr/bin/env node
import { main } from '../src/cli.js';

process.exitCode = main(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
});
