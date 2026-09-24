#!/usr/bin/env node

// Scan shipped code, not fixtures or Git history. Diagnostics intentionally omit values.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = 'dynamicwatch-custom-tiles.user.js';
const codeFile = /\.(?:js|mjs|cjs|json|txt)$/i;
const quoted = /(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
const secretName = /(?:PASS(?:WORD)?|SECRET|PRIVATE[_-]?KEY|(?:API|ACCESS|AUTH|REFRESH|BEARER)[_-]?TOKEN|(?:API|ACCESS|AUTH)[_-]?KEY|TOKEN)$/i;
const fallbackAccount = /(?:BAKED|FALLBACK|DEFAULT)[\w$-]*(?:USER|EMAIL|LOGIN)/i;
const placeholder = /^(?:\s*|<[^>]+>|\$\{[^}]+\}|\{[^}]+\}|(?:your|example|dummy|placeholder|replace[-_ ]?me|changeme|test)[\w .-]*)$/i;

function isCredential(name, value) {
  if (placeholder.test(value)) return false;
  if (fallbackAccount.test(name) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  if (!secretName.test(name)) return false;
  // Storage labels (e.g. VEXCEL_TOKEN_KEY = 'dw_vexcel_token') aren't credentials.
  if (/(?:^|[_-])KEY$/i.test(name) && /^(?:dw_|storage[_-])[\w-]+$/i.test(value)) return false;
  // Public application identifiers and endpoint names are not secrets.
  if (/^(?:https?:\/\/|\/api\/)/i.test(value)) return false;
  return value.length >= 4;
}

export function inspect(text, path) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  let pendingKey = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:\/\/|\*|#)/.test(line)) continue;
    const kinds = new Set();
    let previousEnd = 0;
    let previousLiteral = '';
    const firstLiteral = line.match(/^\s*(['"`])/);
    const continuedKey = firstLiteral ? pendingKey : '';
    pendingKey = '';
    for (const m of line.matchAll(quoted)) {
      const value = m[2];
      const before = line.slice(previousEnd, m.index);
      const bareKey = before.match(/\b([\w$-]+)\s*(?::|=(?!=|>))\s*$/);
      const key = bareKey?.[1] || (/^\s*:\s*$/.test(before) ? previousLiteral : '') ||
        (firstLiteral && m.index === firstLiteral[0].length - 1 ? continuedKey : '');
      if (isCredential(key, value)) kinds.add('hard-coded credential assignment');
      if (/\b(?:Bearer\s+[A-Za-z0-9._~-]{16,}|Basic\s+[A-Za-z0-9+/=]{16,})\b/i.test(value) ||
          /\b(?:token|access_token|api_key|password|client_secret)=[A-Za-z0-9._~-]{12,}/i.test(value) ||
          /https?:\/\/[^\s/@:]+:[^\s/@]{4,}@/i.test(value) ||
          /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) {
        kinds.add('embedded token or URL credential');
      }
      previousEnd = m.index + m[0].length;
      previousLiteral = value;
    }
    pendingKey = line.match(/\b([\w$-]+)\s*(?::|=(?!=|>))\s*$/)?.[1] || '';
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) kinds.add('private key');
    for (const kind of kinds) findings.push({ path, line: i + 1, kind });
  }
  return findings;
}

async function filesIn(dir) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await filesIn(path));
    else if (entry.isFile() && codeFile.test(entry.name)) paths.push(path);
  }
  return paths;
}

export async function scan(root = repository) {
  const paths = [...await filesIn(join(root, 'src')), ...await filesIn(join(root, 'scripts')), join(root, bundle)];
  const findings = [];
  for (const path of paths) {
    findings.push(...inspect(await readFile(path, 'utf8'), relative(root, path)));
  }
  return { files: paths.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { files, findings } = await scan(process.argv[2] ? resolve(process.argv[2]) : repository);
    for (const { path, line, kind } of findings) console.error(`${path}:${line}: ${kind}`);
    console.log(`Checked ${files} source/script/bundle files: ${findings.length} finding(s).`);
    if (findings.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Secret scan could not complete (${error.code || 'read error'}).`);
    process.exitCode = 2;
  }
}
