#!/usr/bin/env node
import { buildProgram } from "./commands.js";

// Exit quietly when output is piped into a command that closes early (e.g. `| head`).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

await buildProgram().parseAsync(process.argv);
