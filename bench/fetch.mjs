#!/usr/bin/env node
// The benchmark's repositories, each at the commit corpus.json pins, into the bench's cache folder (not this
// repository): a shallow fetch of that one commit, checked out. One already there at its commit is left alone.
//
//   node bench/fetch.mjs [--cache DIR] [names...]
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cacheDir, options} from './common.mjs';

const {flags, rest} = options(process.argv.slice(2));
const cache = cacheDir(flags.cache);
const {repos} = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']}).trim();

for (const repo of repos.filter(each => !rest.length || rest.includes(each.name))) {
  const dir = join(cache, 'repos', repo.name);
  if (existsSync(join(dir, '.git')) && git(dir, 'rev-parse', 'HEAD') === repo.commit) {
    process.stderr.write(`${repo.name}: at ${repo.commit.slice(0, 12)}\n`);
    continue;
  }
  mkdirSync(dir, {recursive: true});
  if (!existsSync(join(dir, '.git'))) git(dir, 'init', '-q');
  process.stderr.write(`${repo.name}: fetching ${repo.url} ${repo.commit.slice(0, 12)}\n`);
  git(dir, 'fetch', '-q', '--depth', '1', repo.url, repo.commit);
  git(dir, 'checkout', '-q', '--force', '--detach', 'FETCH_HEAD');
  git(dir, 'clean', '-qfdx');
}
process.stderr.write(`repositories in ${join(cache, 'repos')}\n`);
