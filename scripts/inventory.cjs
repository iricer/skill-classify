"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const limit = 64 * 1024;
const missing = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const absolute = value => typeof value === "string" && path.isAbsolute(value);

function pathStatus(file) {
  if (!absolute(file)) return "inaccessible";
  try {
    return fs.statSync(file).isFile() ? "present" : "inaccessible";
  } catch (error) {
    return missing(error) ? "missing" : "inaccessible";
  }
}

function readFrontmatter(file) {
  if (!absolute(file) || (process.platform === "win32" ? path.basename(file).toUpperCase() !== "SKILL.MD" : path.basename(file) !== "SKILL.md")) {
    throw new Error("需要 SKILL.md 的绝对路径");
  }
  if (!fs.statSync(file).isFile()) throw new Error("SKILL.md 必须是普通文件");
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.allocUnsafe(limit);
    let used = 0, start = 0, search = 0, first = true, bodyStart = 0;
    while (used < limit) {
      const count = fs.readSync(fd, bytes, used, Math.min(1024, limit - used), used);
      used += count;
      while (start < used) {
        const next = bytes.subarray(search, used).indexOf(10);
        if (next < 0 && count !== 0) { search = used; break; }
        const end = next < 0 ? used : search + next;
        let contentStart = start;
        if (first && end >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) contentStart = 3;
        const line = bytes.toString("latin1", contentStart, end);
        const delimiter = /^---[ \t\r]*$/.test(line);
        if (first) {
          if (!delimiter) throw new Error("SKILL.md 缺少开头的 YAML 分隔行");
          bodyStart = end + 1;
          first = false;
        } else if (delimiter) {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bodyStart, start));
        }
        start = search = end + 1;
      }
      if (!count) throw new Error("SKILL.md 缺少 YAML 结束分隔行");
    }
    throw new Error("SKILL.md 的 YAML 头超过 64 KiB 或未结束");
  } finally {
    fs.closeSync(fd);
  }
}

const clean = value => value.replace(/\s+/gu, " ").trim();
const plainComment = value => value.replace(/(?:^|[ \t]+)#.*$/, "");
const quoteEscapes = { '0': "\0", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", ' ': " ", '"': '"', '/': '/', '\\': '\\', N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029" };

function quotedScalar(input) {
  const quote = input[0];
  let result = "";
  for (let i = 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === quote) {
      if (quote === "'" && input[i + 1] === "'") { result += "'"; i++; continue; }
      if (!/^\s*(?:#.*)?$/s.test(input.slice(i + 1))) throw new Error("引号后有无法识别的内容");
      return clean(result);
    }
    if (ch !== "\\" || quote === "'") { result += ch; continue; }
    const key = input[++i];
    if (key === "\n") {
      while (/[ \t]/.test(input[i + 1] || "")) i++;
      continue;
    }
    if (Object.hasOwn(quoteEscapes, key)) { result += quoteEscapes[key]; continue; }
    const count = key === "x" ? 2 : key === "u" ? 4 : key === "U" ? 8 : 0;
    const code = input.slice(i + 1, i + 1 + count);
    if (!count || code.length !== count || !/^[\da-f]+$/i.test(code)) throw new Error("不支持的 YAML 转义");
    result += String.fromCodePoint(parseInt(code, 16)); i += count;
  }
  throw new Error("YAML 字符串缺少结束引号");
}

function scalar(inline, continuation) {
  const raw = inline.trimStart();
  if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(raw)) return clean(continuation.join("\n"));
  const lines = continuation.filter(line => !/^\s*#/.test(line));
  const value = [plainComment(raw) ? raw : "", ...lines].join("\n").trim();
  if (/^["']/.test(value)) return quotedScalar(value);
  if (/^[\[{*&!]|^-(?:\s|$)/.test(value)) throw new Error("目录只读取文本标量");
  return clean([raw, ...lines].map(plainComment).join(" "));
}

function readManifest(file) {
  const lines = readFrontmatter(file).split(/\r?\n/);
  const manifest = {};
  for (let i = 0; i < lines.length; i++) {
    const key = /^(['"]?)(name|description)\1[ \t]*:[ \t]*(.*)$/.exec(lines[i]);
    if (!key) continue;
    if (Object.hasOwn(manifest, key[2])) throw new Error(`YAML 中存在重复字段 ${key[2]}`);
    const continuation = [];
    while (i + 1 < lines.length && /^(?:[ \t]|$)/.test(lines[i + 1])) continuation.push(lines[++i]);
    try { manifest[key[2]] = scalar(key[3], continuation); }
    catch (error) { throw new Error(`无法读取 ${key[2]}：${error.message}`); }
  }
  if (!manifest.name || !manifest.description) throw new Error("SKILL.md 缺少文本类型的 name 或 description");
  return manifest;
}

function discover({ roots } = {}) {
  const user = os.homedir();
  const configured = process.env.CODEX_HOME?.trim();
  if (roots === undefined) roots = [path.resolve(configured || path.join(user, ".codex"), "skills"), path.join(user, ".agents", "skills")];
  if (!Array.isArray(roots) || roots.some(root => !absolute(root))) throw new Error("roots 必须是由绝对路径组成的数组");
  const keyFor = value => process.platform === "win32" ? value.toLowerCase() : value;
  const visited = new Set(), names = new Map(), entries = [], warnings = [];
  for (const rootValue of roots) {
    const root = path.normalize(rootValue);
    const rootKey = keyFor(root);
    if (visited.has(rootKey)) continue;
    visited.add(rootKey);
    let items;
    try { items = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) {
      warnings.push(`${missing(error) ? "未找到目录" : "无法读取目录"}：${root}${missing(error) ? "" : `（${error.code || error.message}）`}`);
      continue;
    }
    items.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const item of items) {
      if (item.name.startsWith(".") || !(item.isDirectory() || item.isSymbolicLink())) continue;
      const file = path.join(root, item.name, "SKILL.md");
      if (pathStatus(file) === "missing") continue;
      try {
        const manifest = readManifest(file);
        const key = keyFor(manifest.name);
        if (names.has(key)) {
          warnings.push(`重名 Skill ${manifest.name}：保留 ${names.get(key)}；另发现 ${file}`);
          continue;
        }
        names.set(key, file);
        entries.push({ ...manifest, path: file, source: "本地安装" });
      } catch (error) { warnings.push(`无法读取 Skill：${file}（${error.code || error.message}）`); }
    }
  }
  return { entries, warnings };
}

module.exports = { readManifest, discover, pathStatus };
