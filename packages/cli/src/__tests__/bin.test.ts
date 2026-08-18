import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execFileAsync = promisify(execFile);

// The built CLI entry (produced by `yarn build` before `yarn test` runs in CI).
const cliDist = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const binBuilt = existsSync(cliDist);

/**
 * Wiring / integration check: the `gitlab-analyzer` bin (dist/cli.js) must
 * boot into the real commander program and exercise the core library. It is
 * skipped when dist/ is absent (i.e. `test` was run before `build`), since it
 * validates the built artifact rather than unit-level logic.
 */
describe.skipIf(!binBuilt)('gitlab-analyzer bin wiring', () => {
  it('--help exits 0 and advertises the find-matches command', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliDist,
      '--help',
    ]);
    const out = `${stdout}\n${stderr}`;
    expect(out).toContain('gitlab-analyzer');
    expect(out).toContain('find-matches');
  });
});
