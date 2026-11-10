#!/usr/bin/env node
// Builds a Claude Desktop bundle (.mcpb): dist + production node_modules + manifest.json.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;

const stage = mkdtempSync(join(tmpdir(), 'gsc-mcp-mcpb-'));
try {
  for (const file of ['dist', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
    cpSync(join(root, file), join(stage, file), { recursive: true });
  }
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  const out = join(root, `gsc-mcp-${pkg.version}.mcpb`);
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, out], { cwd: root, stdio: 'inherit' });
  console.log(`\nWrote ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
