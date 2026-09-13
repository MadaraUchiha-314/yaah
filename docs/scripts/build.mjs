// Build the site and FAIL on a rendering error.
//
// `vitepress build` exits 0 even when server-side rendering throws for a page: it logs
// the error, falls back to client-side rendering, and reports "build complete". That
// makes the CI docs job (requirement R6.4 — "a broken site fails the pull request rather
// than the deployment") useless, because the job it gates would pass. This wrapper reads
// the build's own output and turns a logged error back into a non-zero exit.
import { spawn } from "node:child_process";

// Uncaught-exception lines VitePress prints when a page fails to render. Matched at the
// start of a line so a page whose prose mentions "TypeError:" does not fail the build.
const FAILURE = /^(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):/m;

const child = spawn("vitepress", ["build", "."], {
  stdio: ["inherit", "pipe", "pipe"],
  shell: process.platform === "win32",
});

let captured = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    captured += chunk;
    process.stdout.write(chunk);
  });
}

child.on("error", (error) => {
  console.error(`failed to start vitepress: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  const match = captured.match(FAILURE);
  if (match) {
    console.error(
      `\nvitepress reported a rendering error (${match[0]}) but exited 0. ` +
        "Failing the build: a page that only renders on the client is a broken page.",
    );
    process.exit(1);
  }
});
