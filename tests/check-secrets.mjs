import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scan } from '../scripts/check-secrets.mjs';

const script = resolve(fileURLToPath(new URL('../scripts/check-secrets.mjs', import.meta.url)));

test('scans current source, scripts and bundle without echoing credentials or reading test fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'check-secrets-'));
  try {
    for (const dir of ['src', 'scripts', 'tests']) await mkdir(join(root, dir));
    const password = 'made-up-private-password';
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE4MDAwMDAwMDB9.signaturebytes';
    await writeFile(join(root, 'src', 'config.js'), [
      'VEXCEL_TOKEN_KEY: "dw_vexcel_token",',
      'VEXCEL_APP_KEY: "anz",',
      'VEXCEL_BAKED_PASS: "' + password + '",',
      'VEXCEL_BAKED_USER: "someone@example.invalid",',
      'const API_KEY = "abcd1234";',
      'const CLIENT_SECRET =',
      '  "' + password + '";',
      'const creds = { "password": "' + password + '" };',
    ].join('\n'));
    await writeFile(join(root, 'scripts', 'cli.mjs'), 'const ACCESS_TOKEN = "' + token + '";\n');
    await writeFile(join(root, 'dynamicwatch-custom-tiles.user.js'),
      'const password = "' + password + '";\nconst url = "https://host.invalid/?token=untrustedtoken123456";\n');
    await writeFile(join(root, 'tests', 'fixture.mjs'), 'const password = "' + password + '";\n');
    const result = await scan(root);
    assert.equal(result.files, 3);
    assert.deepEqual(result.findings.map(({ path, kind }) => [path, kind]), [
      ['src/config.js', 'hard-coded credential assignment'],
      ['src/config.js', 'hard-coded credential assignment'],
      ['src/config.js', 'hard-coded credential assignment'],
      ['src/config.js', 'hard-coded credential assignment'],
      ['src/config.js', 'hard-coded credential assignment'],
      ['scripts/cli.mjs', 'hard-coded credential assignment'],
      ['scripts/cli.mjs', 'embedded token or URL credential'],
      ['dynamicwatch-custom-tiles.user.js', 'hard-coded credential assignment'],
      ['dynamicwatch-custom-tiles.user.js', 'embedded token or URL credential'],
    ]);
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /src\/config\.js:3: hard-coded credential assignment/);
    assert.doesNotMatch(run.stdout + run.stderr, /made-up-private-password|someone@example\.invalid|signaturebytes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('clean code, public identifiers, placeholders and unscanned dummy fixtures pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'check-secrets-clean-'));
  try {
    for (const dir of ['src', 'scripts', 'tests']) await mkdir(join(root, dir));
    await writeFile(join(root, 'src', 'config.js'), [
      'VEXCEL_PASS_KEY: "dw_vexcel_pass",',
      'VEXCEL_APP_KEY: "anz",',
      'const password = process.env.VEXCEL_PASSWORD;',
      'const accessToken = "<insert token here>";',
      'const url = CFG.TILE + (token ? "?token=" + token : "");',
    ].join('\n'));
    await writeFile(join(root, 'scripts', 'cli.mjs'), 'const url = "https://example.invalid/api";\n');
    await writeFile(join(root, 'dynamicwatch-custom-tiles.user.js'), 'const token = getToken();\n');
    await writeFile(join(root, 'tests', 'dummy.mjs'), 'const password = "dummy-fixture";\n');
    assert.deepEqual((await scan(root)).findings, []);
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /0 finding\(s\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
