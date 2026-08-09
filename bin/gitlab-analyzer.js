#!/usr/bin/env node
import('../dist/cli.js').then(
  (m) => {
    if (typeof m.runCli !== 'function') {
      process.stderr.write(
        'Fatal: dist/cli.js does not export runCli(). Rebuild with `yarn run build`.\n',
      );
      process.exit(1);
    }
    return m.runCli();
  },
  (err) => {
    process.stderr.write(`Fatal: failed to load CLI: ${err}\n`);
    process.exit(1);
  },
);
