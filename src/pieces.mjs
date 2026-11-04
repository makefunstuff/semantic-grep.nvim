// The pieces of a file: its functions, classes and methods, each with its doc comment, found by
// Neovim's tree-sitter in a headless Neovim (pieces.lua) where Neovim has a parser for the file's language; the lines
// between them, and whole files without a parser, in blocks cut where their indentation says something starts (a
// statement, an object's key), each named by what encloses it (see `split`). A piece is at most PIECE.lines lines
// and PIECE.chars characters, about 400 tokens: under the embedder's 512.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readLines} from './jsonl.mjs';

export const PIECE = {lines: 60, chars: 1500};
const HELPER = fileURLToPath(new URL('./pieces.lua', import.meta.url));
const FILE_MS = 5000; // one file's parse; past this the helper is stuck and the rest goes by blank lines

/**
 * Cuts lines `from`..`to` of `lines` (counted from 1) into chunks of at most PIECE.lines lines and PIECE.chars
 * characters: `{from, to}`. A chunk ends at a blank line when one is in its second half, so a function stays whole
 * where it can; a line longer than a chunk is a chunk of its own.
 */
export function cut(lines, from = 1, to = lines.length) {
  const chunks = [];
  let start = from - 1;
  while (start < to) {
    let end = start;
    let chars = 0;
    while (end < to && end - start < PIECE.lines && chars + lines[end].length + 1 <= PIECE.chars) chars += lines[end++].length + 1;
    if (end === start) end = start + 1;
    else if (end < to) {
      for (let i = end - 1; i > start + (end - start) / 2; i--) {
        if (!lines[i].trim()) { end = i + 1; break; }
      }
    }
    chunks.push({from: start + 1, to: end});
    start = end;
  }
  return chunks;
}

const LETTER = /\p{L}/u;
// A line that is only a comment, or opens or closes one.
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?![\w[!{])|--|;|<!--)|^\s*[-*]\/\s*$/;
// A line that brings in another module: `import`, `require`, `use`, `#include`, `from x import y`.
const IMPORT = /^\s*(?:(?:\/\/|#|--)\s*)?(?:import\b|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\b|from\s+[\w.]+\s+import\b|(?:const|let|var|local)\s+[\w${}\s,:]+=\s*require\s*\(|require\s*\(|use\s+[\w:{}, ]+;|#include\b|using\s+[\w.]+;|package\s+[\w.]+;?\s*$|@import\b)/;
// Opens an import of several lines: `import {` or `import (` with nothing after.
const IMPORT_OPEN = /^\s*(?:(?:\/\/|#|--)\s*)?(?:import|export)\b[^'"]*[{(]\s*$/;
const IMPORT_CLOSE = /\bfrom\s*['"]|^\s*(?:(?:\/\/|#|--)\s*)?[)}]\s*;?\s*$/;
// A line that goes on with the one above rather than starting anything: a closer, an operator, a chained call.
const GOES_ON = /^\s*(?:[}\]).,?:|&+=*>]|-(?!\s))/;
const NAME_MAX = 120;
const COMMENT_OPEN = /^\s*(\/\*\*?|--\[=*\[|"""|''')\s*$/;
const KEYWORDS = new Set('if for while switch catch return with elif else do until foreach function await yield typeof new super this'.split(' '));

const indentOf = line => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const sizeOf = (lines, from, to) => { let chars = 0; for (let i = from; i <= to; i++) chars += lines[i].length + 1; return chars; };

/** Which of `lines` (indexes from 0) bring in other modules, a multi-line import's every line too. */
export function importLines(lines, from = 0, to = lines.length - 1) {
  const found = new Set();
  for (let i = from; i <= to; i++) {
    if (!IMPORT.test(lines[i])) continue;
    found.add(i);
    if (!IMPORT_OPEN.test(lines[i])) continue;
    let j = i + 1;
    while (j <= to && j - i < 200 && !IMPORT_CLOSE.test(lines[j])) found.add(j++);
    if (j <= to) found.add(j);
    i = j;
  }
  return found;
}

/** Whether lines `from`..`to` (from 0) say nothing of their own: blank, punctuation, imports (commented out too). */
function thin(lines, from, to, imports = importLines(lines, from, to)) {
  for (let i = from; i <= to; i++) if (lines[i].trim() && LETTER.test(lines[i]) && !imports.has(i)) return false;
  return true;
}

/** `text` without its import lines: what the models read of a piece (all of it, when that is all it has). */
export function withoutImports(text) {
  const lines = text.split('\n');
  const imports = importLines(lines);
  if (!imports.size || imports.size === lines.length) return text;
  return lines.filter((_, i) => !imports.has(i)).join('\n').replace(/^\s*\n/, '');
}

/**
 * The name a line declares, for a piece's title: a function's, class's or constant's (`export const googleIam =`), an
 * object key's (`adilson: {`, `[RoleGroup.Google]: [`), a construct's (`new Team(this, 'sentry-team'`), a test's
 * (`test('adds', …`), a resource's (`resource "google_project" "core"`); or null.
 */
export function nameOf(line) {
  const text = line.trim().replace(/^-\s+/, '');
  let found;
  if ((found = text.match(/^(?:resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?/))) return found.slice(1).filter(Boolean).join('.');
  if ((found = text.match(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub(?:\([\w ]+\))?\s+)?(?:local\s+)?(?:function\*?|class|interface|enum|type|const|let|var|def|fn|func|struct|trait|impl|module|namespace|object|record|variable|output)\s+([\w$.]+(?::[\w$]+)?)/))) return found[1];
  if ((found = text.match(/^([\w$.]+)\s*\(\s*[`'"]([^`'"]+)/))) return `${found[1]} ${found[2]}`;
  // A method: `async createServiceAccounts(project, accounts) {`, not `if (…) {`.
  if ((found = text.match(/^(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([\w$]+)\s*(?:<[^>]*>)?\s*\(.*(?:[{(,]|=>|\):?[^;]*)$/)) && !KEYWORDS.has(found[1])) return found[1];
  if ((found = text.match(/\bnew\s+([\w$.]+)\s*\(\s*(?:this|scope|self)\s*,\s*[`'"]([^`'"]+)/))) return `${found[1]} ${found[2]}`;
  if ((found = text.match(/^(?:['"]([^'"]+)['"]|\[([^\]]+)\]|([\w$.-]+))\s*(?::(?!:)|=(?![=>]))/))) return found[1] ?? found[2] ?? found[3];
  return null;
}

/**
 * Lines `a`..`b` (from 0) as units: each starts at a line of the outermost indent that has letters and starts something
 * (not a closer, nor a line going on with the one above), with the comment lines right above it, and has every line
 * after it that is deeper, blank or a closer. `{from, to, header, name, blank}`: `header` its first line not a
 * comment, `blank` whether a blank line is above it.
 */
function units(lines, a, b) {
  let base = Infinity;
  for (let i = a; i <= b; i++) if (LETTER.test(lines[i])) base = Math.min(base, indentOf(lines[i]));
  const out = [];
  let unit = null;
  let blank = false;
  for (let i = a; i <= b; i++) {
    const line = lines[i];
    if (!line.trim()) { blank = true; continue; }
    const comment = COMMENT.test(line);
    // A doc comment's opener (`/**`) starts what it documents, though it has no letters.
    const starts = indentOf(line) <= base && ((LETTER.test(line) && (comment || !GOES_ON.test(line))) || COMMENT_OPEN.test(line));
    if (starts && unit && unit.header === null && !blank) {
      unit.to = i; // a comment's line, or the line it is the doc comment of
      if (!comment) unit.header = i;
    } else if (starts || !unit) {
      unit = {from: i, to: i, header: comment ? null : i, blank};
      out.push(unit);
    } else {
      unit.to = i;
    }
    blank = false;
  }
  for (const each of out) each.name = each.header === null ? null : nameOf(lines[each.header]);
  return out;
}

const fits = (lines, from, to) => to - from + 1 <= PIECE.lines && sizeOf(lines, from, to) <= PIECE.chars;
const titled = (chain, names) => {
  const name = [chain.join('.'), [...new Set(names)].slice(0, 3).join(', ')].filter(Boolean).join(': ');
  return name ? name.slice(0, NAME_MAX) : null;
};

/**
 * Lines `a`..`b` (from 0) as pieces, `{from, to, name}` (from 1): small units together up to a piece's size, and a
 * unit too big for one cut at the units inside it, its first line going with the first of them and its closers with
 * the last. So a piece starts where something does (a key of an object, a statement), never on a closer, and is named
 * by what encloses it and what it declares: `_users: adilson, anna`. `chain` names what encloses `a`..`b`, `within`
 * has its first lines (from 1), outermost first: each piece's `within`.
 */
export function split(lines, a, b, chain = [], depth = 0, within = []) {
  const out = [];
  let piece = null;
  const close = () => { if (piece) out.push({from: piece.from + 1, to: piece.to + 1, name: titled(chain, piece.names), within}); piece = null; };
  const found = units(lines, a, b);
  for (const unit of found) {
    if (fits(lines, unit.from, unit.to)) {
      if (piece && fits(lines, piece.from, unit.to)) {
        piece.to = unit.to;
        if (unit.name) piece.names.push(unit.name);
      } else {
        close();
        piece = {from: unit.from, to: unit.to, names: unit.name ? [unit.name] : []};
      }
      continue;
    }
    close();
    // Too big: its head (comments and first line), what is inside it, and its closers (`},`, `} as const;`).
    const head = unit.header ?? unit.from;
    let tail = unit.to;
    while (tail > head && (!LETTER.test(lines[tail]) || (indentOf(lines[tail]) <= indentOf(lines[head]) && GOES_ON.test(lines[tail])))) tail--;
    // What declares something (a key, a function) encloses what is inside it; a paragraph of a docstring does not.
    const inside = unit.name ? [...within, unit.from + 1] : within;
    const inner = depth < 8 && tail > head ? split(lines, head + 1, tail, unit.name ? [...chain, unit.name] : chain, depth + 1, inside) : [];
    if (inner.length < 2) { // nothing inside to cut at: by lines
      for (const part of cut(lines, unit.from + 1, unit.to + 1)) out.push({...part, name: titled(chain, unit.name ? [unit.name] : []), within: inside});
      continue;
    }
    inner[0].from = unit.from + 1;
    inner.at(-1).to = unit.to + 1;
    out.push(...inner);
  }
  close();
  return out;
}

/**
 * Lines `from`..`to` (from 1) where no parser found definitions, as pieces (see `split`). Those with nothing but
 * punctuation in them (a lone `}`) are left out.
 */
export function blocks(lines, from = 1, to = lines.length, chain = []) {
  return split(lines, from - 1, to - 1, chain).filter(piece => LETTER.test(lines.slice(piece.from - 1, piece.to).join('\n')) || /[\p{N}]/u.test(lines.slice(piece.from - 1, piece.to).join('\n')));
}

/**
 * The pieces of `text`: `{from, to, kind, name, within, text}`, in order (`within`: the first lines of what encloses
 * the piece, outermost first; see contextOf). `found` is tree-sitter's (see pieces.lua), or null
 * without a parser: then the whole file goes in blocks. A piece too big is cut at what is inside it, each part named
 * by it. A piece with nothing of its own (imports, a closer) goes with the piece after it, or before it.
 */
export function piecesOf(text, found = null) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  const add = (from, to, kind, name, within = []) => {
    if (lines.slice(from - 1, to).join('\n').trim()) out.push({from, to, kind, name: name ?? null, within});
  };
  const gap = (from, to) => { for (const block of blocks(lines, from, to)) add(block.from, block.to, 'block', block.name, block.within); };
  let next = 1;
  for (const piece of (Array.isArray(found) ? found : []).toSorted((a, b) => a.from - b.from)) {
    const from = Math.max(piece.from, next);
    const to = Math.min(piece.to, lines.length);
    if (to < from) continue;
    if (from > next) gap(next, from - 1);
    const kind = piece.kind ?? 'definition';
    const within = Array.isArray(piece.within) ? piece.within.filter(Number.isInteger) : [];
    if (fits(lines, from - 1, to - 1)) add(from, to, kind, piece.name, within);
    else for (const part of split(lines, from - 1, to - 1, piece.name ? [piece.name] : [], 0, [...within, from])) add(part.from, part.to, kind, part.name ?? piece.name, part.within);
    next = to + 1;
  }
  if (next <= lines.length) gap(next, lines.length);
  // Imports alone, or a closer alone, are no piece to find: they go with a neighbour.
  const imports = importLines(lines);
  for (let i = 0; i < out.length; i++) {
    const piece = out[i];
    if (out.length < 2 || !thin(lines, piece.from - 1, piece.to - 1, imports)) continue;
    const first = lines.slice(piece.from - 1, piece.to).find(line => line.trim()) ?? '';
    const into = LETTER.test(first) && i + 1 < out.length ? i + 1 : i > 0 ? i - 1 : i + 1;
    out[into].from = Math.min(out[into].from, piece.from);
    out[into].to = Math.max(out[into].to, piece.to);
    out.splice(i--, 1);
  }
  // What encloses a piece, but not what starts where it does: its own first lines say that.
  return out.map(piece => ({...piece, within: [...new Set(piece.within)].filter(line => line < piece.from), text: lines.slice(piece.from - 1, piece.to).join('\n')}));
}

/**
 * The headless Neovim that finds pieces with tree-sitter. `definitions(paths)` answers a Map of each absolute path to
 * its pieces, or to null where no parser reads it (or Neovim is not there): those files go by blank lines. One
 * Neovim per call, for all its files; `parsers()` lists the parser files the user's Neovim has (it sends them at start).
 */
export class TreeSitter {
  constructor({nvim = 'nvim', parsers = () => [], log = () => {}} = {}) {
    Object.assign(this, {nvim, parsers, log});
    this.missing = false; // no Neovim to run: every file goes by blank lines, without trying again
    this.helper = HELPER;
  }

  definitions(paths) {
    const found = new Map(paths.map(path => [path, null]));
    if (this.missing || !paths.length) return Promise.resolve(found);
    return new Promise(resolve => {
      let child;
      try {
        child = spawn(this.nvim, ['--headless', '-u', 'NONE', '-i', 'NONE', '-n', '-l', this.helper], {stdio: ['pipe', 'pipe', 'ignore']});
      } catch {
        this.missing = true;
        return resolve(found);
      }
      let answered = 0;
      let timer;
      const done = () => {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve(found);
      };
      const wait = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.log(`pieces: tree-sitter took over ${FILE_MS / 1000} s for one file; the rest go by blank lines`);
          done();
        }, FILE_MS);
      };
      child.on('error', error => {
        if (error.code === 'ENOENT') this.missing = true;
        done();
      });
      child.on('close', done); // once its output is read too, not only when it exits
      child.stdin.on('error', () => {});
      readLines(child.stdout, message => {
        const path = paths[message.id];
        if (path !== undefined) found.set(path, Array.isArray(message.pieces) ? message.pieces : message.lang ? [] : null);
        if (++answered === paths.length) done();
        else wait();
      });
      wait();
      const parsers = this.parsers();
      if (parsers.length) child.stdin.write(`${JSON.stringify({parsers})}\n`);
      paths.forEach((path, id) => child.stdin.write(`${JSON.stringify({id, path})}\n`));
      child.stdin.end();
    });
  }
}

const CONTEXT_CHARS = 160; // of each line of a piece's context: a head and the first sentence of its doc
const SUMMARY_LINES = 40; // a file's own summary is in its first lines, or not at all
// A comment's markers: `///`, `//!`, `/**`, ` * `, `#`, `--[[`, `<!--`, and their closers.
const MARKERS = /^\s*(?:\/\/[/!]?|\/\*+!?|\*\/|\*(?!\/)|#+!?|-{2,}(?:\[=*\[)?|<!--|"""|''')\s?|\s*(?:\*\/|\]=*\]|-->|"""|''')\s*$/g;
const NOT_DOC = /licen[cs]e|copyright|spdx|eslint|prettier|@ts-|tslint|generated|do not edit|coding[:=]|vim:|^!/i;
const DECORATOR = /^\s*@[\w.]+/;
const DOCSTRING = /^\s*[rbuRBU]?("""|''')/;

/** `text` cut at its first sentence's end, at most `chars` long, on one line. */
export function sentence(text, chars = CONTEXT_CHARS) {
  const line = text.replace(/\s+/g, ' ').trim();
  const end = line.search(/(?<!\b(?:\d+|e\.g|i\.e|etc|vs))[.!?](\s|$)/);
  const first = end > 0 ? line.slice(0, end + 1) : line;
  return first.length > chars ? `${first.slice(0, chars).replace(/\s+\S*$/, '')}…` : first;
}

/** The text of comment lines `lines` without their markers, its tags (`@param`) left out: a doc's words, or ''. */
function prose(lines) {
  const kept = [];
  for (const line of lines) {
    const text = line.replace(MARKERS, '').trim().replace(/^@(?:file|fileoverview|overview|module|packageDocumentation)\b\s*/, '');
    if (/^[@:]\w/.test(text)) break; // @param, :param: — what follows is no summary
    kept.push(text);
  }
  return kept.join(' ').trim();
}

/** Lines `at`… (from 0) of a docstring opening there, up to its close, a few at most; or null. */
function docstring(lines, at) {
  const open = DOCSTRING.exec(lines[at] ?? '');
  if (!open) return null;
  const quote = open[1];
  const body = [];
  for (let i = at; i < Math.min(lines.length, at + 12); i++) {
    const line = i === at ? lines[i].slice(lines[i].indexOf(quote) + 3) : lines[i];
    const close = line.indexOf(quote);
    body.push(close >= 0 ? line.slice(0, close) : line);
    if (close >= 0) break;
  }
  return body.join(' ');
}

/**
 * What a definition starting at line `from` (from 1, its doc comment's first line) says of itself: its head (the first
 * line not a comment nor a decorator) and the first sentence of its doc (the comment above it, else a docstring below),
 * `"class Flask(App): The flask object implements a WSGI application."`; or null.
 */
export function headOf(lines, from) {
  const above = [];
  let at = from - 1;
  for (; at < lines.length && at < from + 30; at++) {
    if (!lines[at].trim()) continue;
    if (COMMENT.test(lines[at]) && !DOCSTRING.test(lines[at])) above.push(lines[at]);
    else if (!DECORATOR.test(lines[at])) break;
  }
  if (at >= lines.length || !LETTER.test(lines[at] ?? '')) return null;
  const head = lines[at].trim().replace(/\s*[{(:]?\s*$/, '').replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS);
  const doc = prose(above) || prose([docstring(lines, at + 1) ?? '']);
  const said = doc && !NOT_DOC.test(doc) ? sentence(doc) : '';
  return said ? `${head}: ${said}` : head;
}

/**
 * The heads of what encloses a piece (its `within`), outermost first, joined by " > ": a method's class, so a small
 * method keeps what it is part of. The outermost and the innermost at most; '' when nothing encloses it.
 */
export function contextOf(lines, within = []) {
  const heads = within.map(from => headOf(lines, from)).filter(Boolean);
  return (heads.length > 2 ? [heads[0], heads.at(-1)] : heads).join(' > ');
}

/**
 * A file's own summary, from its first lines: a Markdown or reStructuredText title, a module docstring, or its first
 * comment that is no licence, tool directive or shebang (Go's package comment, a JSDoc file header), to its first
 * sentence; or null.
 */
export function fileSummary(lines, file = '') {
  const first = lines.slice(0, SUMMARY_LINES);
  if (/\.(md|markdown|mdx)$/i.test(file)) {
    const title = first.find(line => /^#\s+\S/.test(line)) ?? first.find(line => /^title:\s*\S/.test(line));
    return title ? sentence(title.replace(/^#\s+|^title:\s*/, '').replace(/^['"]|['"]$/g, '')) : null;
  }
  if (/\.rst$/i.test(file)) {
    const at = first.findIndex((line, i) => i > 0 && /^([=\-~^*#])\1{2,}\s*$/.test(line) && LETTER.test(first[i - 1]));
    return at > 0 ? sentence(first[at - 1].trim()) : null;
  }
  for (let i = 0; i < first.length; i++) {
    if (!first[i].trim() || /^#!/.test(first[i])) continue;
    const doc = docstring(first, i);
    if (doc !== null) return prose([doc]) ? sentence(prose([doc])) : null;
    if (!COMMENT.test(first[i])) return null; // code before any comment: no summary of its own
    const block = [];
    while (i < first.length && COMMENT.test(first[i]) && first[i].trim()) block.push(first[i++]);
    i--; // the line after the block is looked at next
    const text = prose(block);
    if (text && !NOT_DOC.test(text)) return sentence(text);
  }
  return null;
}
