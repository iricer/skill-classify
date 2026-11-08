#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {readManifest, discover, pathStatus} = require('./inventory.cjs');

const FILE_NAME = 'skill-classify.html';
const DEFAULT_CATALOG = path.resolve(__dirname, '..', 'assets', FILE_NAME);
const SOURCES = new Set(['自制', '本地安装', 'MathWorks', 'Codex 内置', '插件', '项目']);
const FIELDS = ['name', 'category', 'subcategory', 'summary', 'detail', 'source', 'path', 'personal', 'personalSubcategory'];
const NAME = /^[^/\\\x00-\x1f\x7f]+$/u;
const HOST_NAME = /^[^:\s]+:[^:\s]+$/u;
const DATA_BLOCK = /(<script id="catalog-data" type="application\/json">)([\s\S]*?)(<\/script>)/g;
const SNAPSHOT = /清单快照 · \d{4}-\d{2}-\d{2}/g;

const USAGE = [
  'open [--check] [--catalog <absolute skill-classify.html>]',
  'inspect <absolute SKILL.md>',
  'scan [--root <absolute directory>]... [--host <JSON file or ->] [--catalog <absolute skill-classify.html>]',
  'add --input <JSON file or -> [--catalog <absolute skill-classify.html>]',
  'refresh --input <JSON file or -> [--catalog <absolute skill-classify.html>]',
  'verify [--catalog <absolute skill-classify.html>]'
];

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nameKey(name) { return name.toLowerCase(); }

function nonempty(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(label + ' must be a nonempty string (max ' + max + ' characters).');
  }
  return value.trim();
}

function validateName(value) {
  const name = nonempty(value, 'name', 160);
  if (!NAME.test(name)) fail('Invalid Skill name: ' + JSON.stringify(name));
  return name;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(label + ' must be an absolute path.');
  return path.normalize(value);
}

function manifestPath(value) {
  const normalized = absolute(value, 'SKILL.md');
  if (path.basename(normalized).toLowerCase() !== 'skill.md') fail('Expected a SKILL.md file: ' + normalized);
  return normalized.split(path.sep).join('/');
}

function pathKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function catalogPath(value) {
  const file = value === undefined ? DEFAULT_CATALOG : absolute(value, '--catalog');
  if (path.basename(file).toLowerCase() !== FILE_NAME) fail('--catalog must name ' + FILE_NAME + '.');
  return file;
}

function sourceName(value, name) {
  if (!SOURCES.has(value)) fail('Unsupported source for ' + name + ': ' + JSON.stringify(value));
  if (value === '插件' && !HOST_NAME.test(name)) fail('Plugin names must include their namespace: ' + name);
  return value;
}

function parseArguments(args) {
  const [command, ...rest] = args;
  if (command === '--help' || command === 'help') return {command: 'help'};
  const allowed = {
    open: new Set(['--catalog', '--check']),
    inspect: new Set(),
    scan: new Set(['--catalog', '--root', '--host']),
    add: new Set(['--catalog', '--input']),
    refresh: new Set(['--catalog', '--input']),
    verify: new Set(['--catalog'])
  };
  if (!Object.hasOwn(allowed, command)) fail('Unknown or missing command. Run --help.');
  const options = {command, roots: [], positionals: []};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) { options.positionals.push(flag); continue; }
    if (!allowed[command].has(flag)) fail('Unexpected flag for ' + command + ': ' + flag);
    const key = flag.slice(2);
    if (key === 'check') {
      if (options.check) fail('Repeated --check.');
      options.check = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) fail(flag + ' requires a value.');
    if (key === 'root') options.roots.push(absolute(value, flag));
    else {
      if (Object.hasOwn(options, key)) fail('Repeated ' + flag + '.');
      options[key] = value;
    }
  }
  if (options.positionals.length !== (command === 'inspect' ? 1 : 0)) fail('Incorrect positional arguments for ' + command + '.');
  if ((command === 'add' || command === 'refresh') && !options.input) fail('--input is required.');
  return options;
}

function parseJSON(raw, label) {
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (err) { fail(label + ' is not valid JSON: ' + err.message); }
}

function readJSON(input, label) {
  const file = input === '-' ? 0 : absolute(input, label);
  return parseJSON(fs.readFileSync(file, 'utf8'), label);
}

function normalizeRecord(value, checkManifest) {
  if (!isObject(value)) fail('Each Skill record must be an object.');
  const name = validateName(value.name);
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key)) fail('Unknown field for ' + name + ': ' + key);
  }
  const source = sourceName(value.source, name);
  const file = manifestPath(value.path);
  if (typeof value.category !== 'string' || !/^(?:[2-9]|1[0-8])$/.test(value.category)) {
    fail('Expected a primary category from 2 to 18 for ' + name + ' (1 is a personal shortcut).');
  }
  if (value.category === '4' && (typeof value.subcategory !== 'string' || !/^4\.[1-8]$/.test(value.subcategory))) {
    fail('A MATLAB subcategory 4.1–4.8 is required for ' + name + '.');
  }
  if (value.category !== '4' && value.subcategory !== undefined) fail('Only primary category 4 has numbered subcategories: ' + name);
  if (value.personal !== undefined && typeof value.personal !== 'boolean') fail('personal must be boolean: ' + name);
  if (value.personalSubcategory !== undefined &&
      (!value.personal || typeof value.personalSubcategory !== 'string' || !/^1\.[1-5]$/.test(value.personalSubcategory))) {
    fail('personalSubcategory requires personal: true and a value in 1.1–1.5: ' + name);
  }
  const summary = nonempty(value.summary, 'summary for ' + name, 500);
  const detail = nonempty(value.detail, 'detail for ' + name, 8000);
  if (checkManifest) {
    const metadata = readManifest(file);
    const manifestName = validateName(metadata.name);
    const shortName = source === '插件' ? name.slice(name.lastIndexOf(':') + 1) : name;
    if (nameKey(manifestName) !== nameKey(name) && nameKey(manifestName) !== nameKey(shortName)) {
      fail('Name does not match the SKILL.md frontmatter: ' + name + ' (' + manifestName + ').');
    }
  }
  const record = {name, category: value.category};
  if (value.subcategory !== undefined) record.subcategory = value.subcategory;
  Object.assign(record, {summary, detail, source, path: file});
  if (value.personal !== undefined) record.personal = value.personal;
  if (value.personalSubcategory !== undefined) record.personalSubcategory = value.personalSubcategory;
  return record;
}

function validateBatch(records, checkManifest = false) {
  if (!Array.isArray(records)) fail('Expected an array of Skill records.');
  const seen = new Set();
  return records.map(value => {
    const record = normalizeRecord(value, checkManifest);
    const key = nameKey(record.name);
    if (seen.has(key)) fail('Duplicate Skill name: ' + record.name);
    seen.add(key);
    return record;
  });
}

function readCatalog(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) fail('Catalog must be a regular file, not a link: ' + file);
  const raw = fs.readFileSync(file, 'utf8');
  const matches = [...raw.matchAll(DATA_BLOCK)];
  if (matches.length !== 1) fail('Expected exactly one embedded catalog-data script.');
  const [block, opening, payload, closing] = matches[0];
  const before = raw.slice(0, matches[0].index);
  const after = raw.slice(matches[0].index + block.length);
  const stamp = [...(before + after).matchAll(SNAPSHOT)];
  if (stamp.length !== 1) fail('Expected exactly one catalog snapshot date.');
  const records = validateBatch(parseJSON(payload, 'Embedded catalog data'));
  return {raw, records, file, before, after, opening, closing, snapshot: stamp[0][0].slice(-10)};
}

function chinaDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return fields.year + '-' + fields.month + '-' + fields.day;
}

function embeddedData(records, newline) {
  const encoded = records.map(record => '  ' + JSON.stringify(record)).join(',' + newline);
  const safe = encoded.replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return '[' + newline + safe + (records.length ? newline : '') + ']';
}

function replaceAtomically(state, records, date) {
  const newline = state.raw.includes('\r\n') ? '\r\n' : '\n';
  const stamp = '清单快照 · ' + date;
  const next = state.before.replace(SNAPSHOT, stamp) + state.opening + embeddedData(records, newline) +
    state.closing + state.after.replace(SNAPSHOT, stamp);
  const dir = path.dirname(state.file);
  const temp = path.join(dir, '.' + FILE_NAME + '.' + process.pid + '.' + randomUUID() + '.tmp');
  const lock = path.join(dir, '.' + FILE_NAME + '.lock');
  let descriptor, lockDescriptor;
  let ownsTemp = false;
  try {
    descriptor = fs.openSync(temp, 'wx');
    ownsTemp = true;
    fs.writeFileSync(descriptor, next, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try { lockDescriptor = fs.openSync(lock, 'wx'); }
    catch (err) {
      if (err.code === 'EEXIST') fail('Another catalog update is in progress; retry after it finishes.');
      throw err;
    }
    if (!fs.lstatSync(state.file).isFile() || fs.readFileSync(state.file, 'utf8') !== state.raw) {
      fail('Catalog changed during this update; scan and retry without discarding the concurrent edit.');
    }
    fs.renameSync(temp, state.file);
    ownsTemp = false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (ownsTemp) fs.rmSync(temp, {force: true});
    if (lockDescriptor !== undefined) {
      fs.closeSync(lockDescriptor);
      fs.rmSync(lock, {force: true});
    }
  }
}

function sameRecord(left, right) {
  return FIELDS.every(key => left[key] === right[key]);
}

function readHost(file) {
  if (!file) return [];
  const data = readJSON(file, '--host');
  if (!Array.isArray(data)) fail('--host must contain a JSON array.');
  return data.map(entry => {
    if (!isObject(entry)) fail('Each host entry must be an object.');
    const name = validateName(entry.name);
    const file = manifestPath(entry.path);
    const source = sourceName(entry.source, name);
    const metadata = readManifest(file);
    const suffix = source === '插件' ? name.slice(name.lastIndexOf(':') + 1) : name;
    if (nameKey(metadata.name) !== nameKey(name) && nameKey(metadata.name) !== nameKey(suffix)) {
      fail('Host entry does not match its manifest name: ' + name);
    }
    return {name, path: file, source, description: metadata.description, host: true};
  });
}

function scanCatalog(state, options) {
  const inventory = discover(options.roots.length ? {roots: options.roots} : {});
  const candidates = [...readHost(options.host), ...inventory.entries];
  const warnings = [...inventory.warnings];
  const previous = new Map(state.records.map(record => [nameKey(record.name), record]));
  const grouped = new Map();
  for (const candidate of candidates) {
    const name = validateName(candidate.name);
    const key = nameKey(name);
    const file = manifestPath(candidate.path);
    const bucket = grouped.get(key) ?? [];
    if (!bucket.some(existing => pathKey(existing.path) === pathKey(file))) bucket.push({...candidate, name, path: file});
    grouped.set(key, bucket);
  }
  const added = [], changed = [], missing = [], inaccessible = [];
  let unchanged = 0;
  for (const [key, bucket] of grouped) {
    const old = previous.get(key);
    const existing = old && pathStatus(old.path) === 'present';
    const samePath = old && bucket.find(item => pathKey(item.path) === pathKey(old.path));
    const explicit = bucket.filter(item => item.host);
    if (bucket.length > 1) warnings.push('同名 Skill ' + bucket[0].name + '：' + bucket.map(item => item.path).join('；'));
    const best = explicit.length === 1 ? explicit[0] : samePath ?? (existing ? null : bucket[0]);
    if (!best || (old && pathKey(best.path) === pathKey(old.path))) { unchanged++; continue; }
    const {host, ...entry} = best;
    if (!old) added.push(entry);
    else changed.push({previous: old, candidate: entry});
  }
  for (const [key, old] of previous) {
    if (grouped.has(key)) continue;
    const status = pathStatus(old.path);
    if (status === 'missing') missing.push(old);
    else if (status === 'inaccessible') inaccessible.push(old);
    else unchanged++;
  }
  return {new: added, changed, missing, inaccessible, unchanged, warnings};
}

function update(state, command, input) {
  let upsert, remove;
  if (command === 'add') { upsert = input; remove = []; }
  else {
    if (!isObject(input) || !Array.isArray(input.upsert) || !Array.isArray(input.remove) ||
        Object.keys(input).some(key => key !== 'upsert' && key !== 'remove')) {
      fail('refresh expects {upsert: [records], remove: [names]}.');
    }
    ({upsert, remove} = input);
  }
  const additions = validateBatch(upsert, true);
  const current = new Map(state.records.map(record => [nameKey(record.name), record]));
  const upsertKeys = new Set(additions.map(item => nameKey(item.name)));
  const removals = new Set();
  for (const item of remove) {
    const name = validateName(item), key = nameKey(name);
    if (removals.has(key) || upsertKeys.has(key)) fail('Conflicting or duplicated removal: ' + name);
    const record = current.get(key);
    if (!record) fail('Cannot remove an unknown record: ' + name);
    if (pathStatus(record.path) !== 'missing') fail('Removal requires a confirmed missing SKILL.md: ' + name);
    removals.add(key);
  }
  const result = {added: [], updated: [], removed: [], unchanged: []};
  for (const item of additions) {
    const key = nameKey(item.name), prior = current.get(key);
    if (prior && sameRecord(prior, item)) { result.unchanged.push(item.name); continue; }
    result[prior ? 'updated' : 'added'].push(item.name);
    current.set(key, item);
  }
  for (const key of removals) { result.removed.push(current.get(key).name); current.delete(key); }
  const date = chinaDate();
  const wrote = Boolean(result.added.length || result.updated.length || result.removed.length || (command === 'refresh' && date !== state.snapshot));
  if (wrote) replaceAtomically(state, [...current.values()], date);
  return {...result, wrote, count: current.size, snapshot: wrote ? date : state.snapshot};
}

function verify(state) {
  const categories = {}, sources = {}, missing = [], inaccessible = [];
  let personal = 0;
  for (const record of state.records) {
    categories[record.category] = (categories[record.category] ?? 0) + 1;
    sources[record.source] = (sources[record.source] ?? 0) + 1;
    if (record.personal) personal++;
    const status = pathStatus(record.path);
    if (status === 'missing') missing.push({name: record.name, path: record.path});
    if (status === 'inaccessible') inaccessible.push({name: record.name, path: record.path});
  }
  return {count: state.records.length, personal, categories, sources, snapshot: state.snapshot, missing, inaccessible};
}

function openInBrowser(file, check) {
  if (check) return {opened: false, check: true};
  let command, args, env = process.env;
  if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Start-Process -FilePath $env:SKILL_CLASSIFY_OPEN_PATH'];
    env = {...process.env, SKILL_CLASSIFY_OPEN_PATH: file};
  } else if (process.platform === 'darwin') {
    command = 'open'; args = [file];
  } else {
    command = 'xdg-open'; args = [file];
  }
  const child = spawnSync(command, args, {env, windowsHide: true, timeout: 12000, encoding: 'utf8'});
  if (child.error || child.status !== 0) {
    return {opened: false, error: child.error?.message || child.stderr?.trim() || '无法启动默认浏览器。'};
  }
  return {opened: true};
}

function main(args) {
  const options = parseArguments(args);
  const {command} = options;
  if (command === 'help') return {ok: true, usage: USAGE};
  if (command === 'inspect') {
    const file = manifestPath(options.positionals[0]);
    return {ok: true, command, path: file, ...readManifest(file)};
  }
  const file = catalogPath(options.catalog);
  const state = readCatalog(file);
  if (command === 'open') {
    const result = openInBrowser(file, options.check);
    if (result.error) process.exitCode = 1;
    return {ok: !result.error, command, catalog: file, ...result};
  }
  if (command === 'scan') return {ok: true, command, catalog: file, ...scanCatalog(state, options)};
  if (command === 'verify') return {ok: true, command, catalog: file, ...verify(state)};
  return {ok: true, command, catalog: file, ...update(state, command, readJSON(options.input, '--input'))};
}

try {
  console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
} catch (err) {
  console.log(JSON.stringify({ok: false, command: process.argv[2] ?? null, error: err.message}, null, 2));
  process.exitCode = 1;
}
