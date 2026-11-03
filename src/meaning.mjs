// Search by meaning: an index of each project open, and a search that ranks its pieces of code by what the words mean
// and by the words themselves, fused by reciprocal rank. The index holds the files git lists (tracked and untracked,
// without what .gitignore leaves out; without git, ripgrep's list), cut into pieces (functions, classes and methods
// with their doc comments where Neovim has a tree-sitter parser, else blocks between blank lines; see pieces.mjs), the
// words of each piece for the word search, and a vector per piece from the embedding model (see embedder.mjs). It is a
// SQLite file per repository, shared by its worktrees (see index-store.mjs). A piece is embedded again only when its
// text changed: a save reads that file again, and the project is looked over when it opens and every ten minutes, for
// changes made outside Neovim. The word search works without any embedding model. A decision model may rerank a
// settled list's first pieces (see rerank.mjs). Builds, searches and reranks go to the host's `book`.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative} from 'node:path';
import {apiKeyOf} from './config.mjs';
import {HttpEmbedder, tuningOf} from './embedder.mjs';
import {IndexStore, indexPlace, PROJECT_DIR, removeIndex, removeLearned} from './index-store.mjs';
import {importLines, piecesOf, TreeSitter, withoutImports} from './pieces.mjs';
import {NO_NOTE, NotesWriter} from './notes.mjs';
import {pieceText, SNIPPET_CHARS} from './rerank.mjs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_AVERAGE = 300; // minified or generated: no lines worth reading
const BATCH = 4; // pieces per embedder call: a search waits for at most one batch
const BOOKED_PIECES = 10; // a build this big is booked (`book`); a save's few pieces are not
export const MAX_PIECES = 20_000; // per project, about 45 min of a first build on two cores; files past it are left out
export const RESCAN_MS = 10 * 60_000;
const NOTES_TICK_MS = 15_000; // how often the notes writer looks whether it may write
const NOTES_REST_MS = 5 * 60_000; // after a writer failed for a whole batch, how long it rests
const NOTES_BATCH = 4; // pieces a writer's lane takes at a time: a search waits for one piece at most
const PARSE_GROUP = 200; // files per headless Neovim of tree-sitter
const PROGRESS_MS = 2000; // how often a build in progress tells the editors how far it is
const HEAD_CHARS = 100;
const RRF_K = 60;
const LIST = 50; // of each ranking, how many go into the fusion
// Meaning hits further below the best than the model's `band` are left out (unrelated code scores close, too); a search
// kept (someone opened a piece for it) whose words mean at least the model's `pickNear` close to a new search's: the
// piece goes first. Both are the model's own, measured on the bench (see embedder.mjs, tuningOf).
const PICKED_PER_SEARCH = 3;
// The files view: a file is ranked by the pieces it has among a search's first FILE_PIECES, each worth 1/(FILE_K +
// rank), its best in full and each next one FILE_DECAY of the one before: the best piece first, and a small bonus for
// several. Tuned on the bench's dev questions (docs/benchmark.md, "Files"); meaning's list there is not cut by the band,
// the depth is, and the words alone take the pieces with any of them.
export const FILE_PIECES = 60;
const FILE_K = 5;
const FILE_DECAY = 0.5;
// Words of a question that say nothing about where to look: left out of the word search, not the meaning's.
const STOPWORDS = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my not of on or our so that the their them then there these this to was we were what when where which who why will with you your'.split(' '));
// A line that is a comment, or only opens or closes one: a piece's head is the first line that is not.
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!\w)|--|;|"""|'''|<!--)|^\s*[-*]\/\s*$/;

// Files whose text is no code or prose to search: pictures, sound, archives, fonts, lockfiles, source maps.
const SKIP = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svg|pdf|mp3|mp4|m4a|wav|ogg|flac|webm|mov|avi|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|sqlite3?|sqlite-(wal|shm)|db|pyc|map|litertlm|gguf|onnx|safetensors|pt|npy|npz)$/i;
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'flake.lock']);

const run = (command, args, cwd) => new Promise(resolve => {
  execFile(command, args, {cwd, maxBuffer: 64 << 20}, (error, stdout) => resolve(error ? null : stdout));
});

/** Whether the file at `path` (relative to the project) is one to index, by its name alone. */
export function indexable(path, projectDir = PROJECT_DIR) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return !SKIP.test(name) && !LOCKFILES.has(name) && !/\.min\.(js|css)$/.test(name) && !path.startsWith(`${projectDir}/`);
}

/** The project's files to index, relative to `root`: git's list without what it ignores, else ripgrep's, else none. */
export async function projectFiles(root, projectDir = PROJECT_DIR) {
  const git = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
  // Without git, ripgrep keeps to .gitignore only when told to.
  const listed = git !== null ? git.split('\0') : (await run('rg', ['--files', '--null', '--no-require-git'], root))?.split('\0') ?? [];
  return [...new Set(listed.filter(Boolean))].filter(path => indexable(path, projectDir)).sort();
}

/**
 * A piece is known by its file's path, its name (its title's: see embedder.mjs) and its text: worktrees of a
 * repository share its vector, a restart embeds nothing twice.
 */
export const pieceHash = (file, text, name = null) => createHash('sha1').update(name ? `${file}\n${name}\n${text}` : `${file}\n${text}`).digest('hex');

/**
 * The words of `text` for the word search: lower case, with identifiers split too (removeUserFromTeam, retry_count:
 * remove, user, from, team; retry, count). Comments and strings are words like any other.
 */
export function words(text) {
  const found = [];
  for (const token of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const lower = token.toLowerCase();
    if (lower.length > 1) found.push(lower);
    const parts = token.split(/_+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).filter(part => part.length > 1);
    if (parts.length > 1) for (const part of parts) found.push(part.toLowerCase());
  }
  return found;
}

/** The words of a search that say where to look: its own and its identifiers' parts, without a question's small words. */
export const searchTerms = query => [...new Set(words(query))].filter(term => !STOPWORDS.has(term));

/** Reciprocal rank fusion of ranked lists of keys: each key scores 1/(k + rank) in every list it is in. */
export function fuse(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/**
 * Ranked pieces (or results: anything with a `file`), best first, as files, best first: `[{file, score, hits, best}]`,
 * `best` the file's first piece in the list, `hits` how many it has there. See FILE_PIECES.
 */
export function filesOf(ranked, {k = FILE_K, decay = FILE_DECAY} = {}) {
  const files = new Map();
  ranked.forEach((piece, rank) => {
    const file = files.get(piece.file);
    const worth = 1 / (k + rank + 1);
    if (!file) files.set(piece.file, {file: piece.file, score: worth, hits: 1, best: piece, next: decay});
    else {
      file.score += worth * file.next;
      file.next *= decay;
      file.hits++;
    }
  });
  return [...files.values()].sort((a, b) => b.score - a.score).map(({next, ...file}) => file);
}

/** The lines of the project's files, kept for the few files read last: a piece's head and its text to embed. */
class Lines {
  constructor(root, size = 64) {
    Object.assign(this, {root, size});
    this.files = new Map(); // file -> {mtimeMs, lines}
  }

  async get(file) {
    let info;
    try { info = await stat(join(this.root, file)); } catch { return null; }
    const known = this.files.get(file);
    if (known?.mtimeMs === info.mtimeMs && known.size === info.size) {
      this.files.delete(file);
      this.files.set(file, known);
      return known.lines;
    }
    let text;
    try { text = await readFile(join(this.root, file), 'utf8'); } catch { return null; }
    this.files.set(file, {mtimeMs: info.mtimeMs, size: info.size, lines: text.split('\n')});
    if (this.files.size > this.size) this.files.delete(this.files.keys().next().value);
    return this.files.get(file).lines;
  }
}

/**
 * One project's index (one worktree: `root`), on the repository's `store`: its pieces (`{id, file, from, to, hash,
 * kind, name}`), their vectors by hash, and the pieces still waiting for theirs. `embedder` is the Meaning's: its
 * `id`, `document(file, text)`, `query(text)` and `embed(texts, {urgent})`.
 */
export class ProjectIndex {
  constructor({root, store, embedder, treeSitter, projectDir = PROJECT_DIR, log = () => {}, now = Date.now, onProgress = () => {}, embedding = () => true}) {
    Object.assign(this, {root, store, embedder, treeSitter, projectDir, log, now, onProgress, embedding});
    this.files = new Map(); // relative path -> {size, mtimeMs, skipped}, as last read
    this.byFile = new Map(); // relative path -> its pieces
    this.vectors = new Map(); // hash -> Float32Array, of the embedder's model
    this.documents = new Map(); // hash -> the text to embed, while it waits; read again from its file after a restart
    this.lines = new Lines(root);
    this.waiting = null; // the pieces still without a vector, worked through by step(); null once the files change
    this.matrix = null; // the vectors in one array, for the search; null once they change
    this.capped = false; // the project has more pieces than MAX_PIECES: some files are left out
    this.reading = null; // {done, total} while files are read and cut into pieces
    this.scannedAt = 0;
  }

  get model() { return this.embedder?.id ?? 'none'; }

  /** The embedder's band and pickNear: its own, or its model's (a host's embedder may not say). */
  get tuning() { return this.embedder?.tuning ?? tuningOf({model: this.embedder?.id}); }

  /** What the store has of this worktree: its files, pieces and their vectors, made here or in another worktree. */
  load() {
    this.files = this.store.files(this.root);
    this.byFile = new Map();
    for (const piece of this.store.pieces(this.root)) {
      if (!this.byFile.has(piece.file)) this.byFile.set(piece.file, []);
      this.byFile.get(piece.file).push(piece);
    }
    this.vectors = this.store.vectors(this.model, this.root);
    this.changed();
    this.loadLearned();
  }

  changed() {
    this.waiting = null;
    this.matrix = null;
    this.byId = null;
    this.byHash = null;
  }

  /** What was learned of the repository (see index-store.mjs): the searches kept, the notes, and their vectors. */
  loadLearned() {
    this.learnedAt = this.store.learnedVersion();
    const rows = this.store.extras();
    this.extrasById = new Map(rows.map(row => [row.id, row]));
    this.notesByHash = new Map(rows.filter(row => row.kind === 'note').map(row => [row.hash, row]));
    this.picks = rows.filter(row => row.kind === 'pick');
    this.learnedVectors = this.store.learnedVectors(this.model);
    this.matrix = null;
  }

  /** Loaded again when another connection (another Neovim, the notes command) learned something since. */
  refreshLearned() {
    if (this.store && !this.store.closed && this.store.learnedVersion() !== this.learnedAt) this.loadLearned();
  }

  /** The piece of this worktree a learned row is about: the one of its hash, else (a search kept) the one at its line. */
  pieceOfExtra(row) {
    this.byHash ??= new Map(this.pieces.map(piece => [piece.hash, piece]));
    const exact = row.hash ? this.byHash.get(row.hash) : null;
    if (exact || row.kind !== 'pick') return exact ?? null;
    return (this.byFile.get(row.file) ?? []).find(piece => piece.from <= row.line && row.line <= piece.to) ?? null;
  }

  /** A learned row's vector, by what is embedded: a search's words, or a note with its piece. */
  extraKey(row) { return createHash('sha1').update(row.kind === 'note' ? `note\n${row.hash}\n${row.text}` : `pick\n${row.text}`).digest('hex'); }

  /** The learned rows still without a vector of the embedder's model: a note only once its piece is in this worktree. */
  learnedPending() {
    if (!this.embedder || !this.extrasById) return [];
    return [...this.extrasById.values()].filter(row => !this.learnedVectors.has(this.extraKey(row)) && (row.kind === 'pick' || this.pieceOfExtra(row)));
  }

  /** Embeds what was learned and waits, a batch of it; false when none waits. */
  async stepLearned() {
    const todo = this.learnedPending().slice(0, 16);
    if (!todo.length) return false;
    const texts = todo.map(row => (row.kind === 'pick' ? this.embedder.query(row.text) : this.embedder.document(row.file, row.text, this.pieceOfExtra(row).name)));
    const vectors = await this.embed(texts);
    if (this.closed) return false;
    const entries = todo.map((row, i) => [this.extraKey(row), vectors[i]]);
    this.store.putLearnedVectors(this.model, entries);
    for (const [key, vector] of entries) this.learnedVectors.set(key, vector);
    this.matrix = null;
    return true;
  }

  get pieces() { return [...this.byFile.values()].flat(); }

  /** The vectors of texts the project no longer has leave memory too (the file keeps those other worktrees have). */
  trim() {
    const hashes = new Set(this.pieces.map(piece => piece.hash));
    for (const hash of [...this.vectors.keys()]) if (!hashes.has(hash)) this.vectors.delete(hash);
    this.matrix = null;
  }

  /** Looks the whole project over: files new, changed and gone. Read in groups, each cut into pieces by one Neovim. */
  async scan() {
    const listed = await projectFiles(this.root, this.projectDir);
    const keep = new Set(listed);
    for (const file of [...this.files.keys()]) if (!keep.has(file)) this.forget(file);
    let count = this.pieces.length;
    this.capped = false;
    const changed = [];
    for (const file of listed) {
      let info;
      try { info = await stat(join(this.root, file)); } catch { this.forget(file); continue; }
      const known = this.files.get(file);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue;
      if (!known && count >= MAX_PIECES) { this.capped = true; continue; }
      changed.push({file, info});
      count += Math.ceil(info.size / 1000); // about a piece a kilobyte, until it is read
    }
    if (changed.length) await this.readAll(changed);
    this.scannedAt = this.now();
  }

  /** A file saved in Neovim, by its path (relative to the project, or absolute). Outside it, or ignored, it changes nothing. */
  async saved(path, {force = false} = {}) {
    const file = isAbsolute(path) ? relative(this.root, path) : path;
    if (file.startsWith('..') || !this.files.has(file) && !(await projectFiles(this.root, this.projectDir)).includes(file)) return;
    let info;
    try { info = await stat(join(this.root, file)); } catch { return this.forget(file); }
    const known = this.files.get(file);
    // `force`: its text changed though its size and time did not (cp -p, rsync -t, a coarse clock).
    if (!force && known && known.size === info.size && known.mtimeMs === info.mtimeMs) return;
    if (!force) this.forced?.delete(file); // saved anew: a mismatch may be read again
    await this.readAll([{file, info}]);
  }

  forget(file) {
    if (!this.files.has(file) && !this.byFile.has(file)) return;
    this.store.removeFile(this.root, file);
    this.files.delete(file);
    this.byFile.delete(file);
    this.changed();
  }

  /** Reads `changed` files (`{file, info}`) and cuts them into pieces: tree-sitter's where it can, blank lines elsewhere. */
  readAll(changed) {
    // One read at a time: a save during a scan waits for it, so the newer text is the one kept.
    const read = (this.readChain ?? Promise.resolve()).then(() => this.readNow(changed));
    this.readChain = read.catch(() => {});
    return read;
  }

  async readNow(changed) {
    if (this.closed) return;
    const total = changed.length;
    const reading = {done: 0, total};
    this.reading = reading;
    let told = this.now();
    try {
      for (let start = 0; start < changed.length; start += PARSE_GROUP) {
        const texts = [];
        for (const {file, info} of changed.slice(start, start + PARSE_GROUP)) {
          if (!info.isFile() || info.size > MAX_FILE_BYTES || !indexable(file, this.projectDir)) { this.forget(file); continue; }
          let text;
          try { text = await readFile(join(this.root, file), 'utf8'); } catch { this.forget(file); continue; }
          const lines = text.split('\n').length;
          if (text.slice(0, 8192).includes('\0') || text.length / lines > MAX_LINE_AVERAGE) {
            this.store.putFile(this.root, file, {size: info.size, mtimeMs: info.mtimeMs, skipped: true});
            this.files.set(file, {size: info.size, mtimeMs: info.mtimeMs, skipped: true});
            this.byFile.delete(file);
            continue;
          }
          texts.push({file, info, text});
        }
        const found = await this.treeSitter.definitions(texts.map(({file}) => join(this.root, file)));
        if (this.closed) return; // the session ended, or the index is made again: its file is closed
        for (const {file, info, text} of texts) {
          const pieces = piecesOf(text, found.get(join(this.root, file))).map(piece => ({
            ...piece, hash: pieceHash(file, piece.text, piece.name), words: words(`${file} ${piece.name ?? ''} ${piece.text}`).join(' '),
          }));
          for (const old of this.byFile.get(file) ?? []) this.documents.delete(old.hash); // a text gone from the file
          const stored = this.store.putFile(this.root, file, {size: info.size, mtimeMs: info.mtimeMs}, pieces);
          this.files.set(file, {size: info.size, mtimeMs: info.mtimeMs, skipped: false});
          this.byFile.set(file, stored);
          pieces.forEach(piece => {
            if (this.vectors.has(piece.hash)) return;
            const shared = this.store.vector(this.model, piece.hash); // made in another worktree of the repository
            if (shared) this.vectors.set(piece.hash, shared);
            // Kept to embed soon, only while there is a model: words alone read the file again when it comes.
            else if (this.embedder && this.embedding()) this.documents.set(piece.hash, this.document(file, piece.text, piece.name));
          });
        }
        reading.done = Math.min(total, start + PARSE_GROUP);
        this.changed();
        if (this.now() - told > PROGRESS_MS) {
          told = this.now();
          this.onProgress({phase: 'reading', done: reading.done, total});
        }
      }
    } finally {
      if (this.reading === reading) this.reading = null;
    }
  }

  /** The pieces still without a vector, one per hash, oldest file first. */
  pending() {
    const seen = new Set();
    return this.pieces.filter(piece => !this.vectors.has(piece.hash) && !seen.has(piece.hash) && seen.add(piece.hash));
  }

  /** The text to embed for `piece`: kept since it was read, or read again from its file (after a restart). */
  async documentOf(piece) {
    if (this.documents.has(piece.hash)) return this.documents.get(piece.hash);
    const lines = await this.lines.get(piece.file);
    if (!lines) return null;
    const text = lines.slice(piece.from - 1, piece.to).join('\n');
    return pieceHash(piece.file, text, piece.name) === piece.hash ? this.document(piece.file, text, piece.name) : null; // changed since: the next scan reads it
  }

  /** What the embedder reads of a piece: its text without its imports, titled by its file and name. */
  document(file, text, name) { return this.embedder.document(file, withoutImports(text), name); }

  /** Embeds the next few pieces waiting; false when none waits. The list of those is made again once it runs out, or the files change. */
  async step() {
    if (this.closed) return false;
    if (await this.stepLearned()) return true;
    if (this.closed) return false;
    if (!this.waiting?.length) this.waiting = this.pending();
    const waiting = this.waiting; // a file read meanwhile makes a new list; this batch keeps to its own
    const batch = [];
    const stale = new Set();
    while (waiting.length && batch.length < (this.embedder.batch ?? BATCH)) {
      if (this.closed) return false;
      const piece = waiting.shift();
      if (this.vectors.has(piece.hash)) continue;
      const shared = this.store.vector(this.model, piece.hash); // another worktree embedded it meanwhile
      if (shared) {
        this.vectors.set(piece.hash, shared);
        this.matrix = null;
        continue;
      }
      const document = await this.documentOf(piece);
      if (document === null) stale.add(piece.file);
      else batch.push({hash: piece.hash, document});
    }
    // A file changed since it was read: read again now, its pieces wait in the next list.
    this.forced ??= new Set();
    let reread = false;
    for (const file of stale) {
      if (this.closed) return false;
      if (this.forced.has(file)) continue; // read again once already: left to the next save
      this.forced.add(file);
      reread = true;
      await this.saved(file, {force: true}).catch(() => {});
    }
    if (this.closed) return false;
    if (!batch.length) return reread;
    const vectors = await this.embed(batch.map(item => item.document));
    if (this.closed) return false; // the session ended, or the index is being made again: its file is closed
    const entries = batch.map((item, i) => [item.hash, vectors[i]]);
    this.store.putVectors(this.model, entries);
    for (const [hash, vector] of entries) {
      this.vectors.set(hash, vector);
      this.documents.delete(hash);
    }
    this.matrix = null;
    return true;
  }

  embed(texts, options) { return this.embedder.embed(texts, options); }

  /**
   * The pieces that have every word of the query, each as the start of one of theirs (`retr` finds `retryCount`), best
   * first by BM25. A piece the store has and this index does not was read by another Neovim's backend on the same
   * worktree: what the store has is loaded again, once.
   */
  wordRanking(query, limit = LIST, {any = false} = {}) {
    this.refreshLearned();
    const terms = searchTerms(query);
    const ids = this.store.wordSearch(this.root, terms, limit, any);
    let byId = this.byId ??= new Map(this.pieces.map(piece => [piece.id, piece]));
    if (ids.some(id => !byId.has(id)) && !this.reading) {
      this.load();
      byId = this.byId = new Map(this.pieces.map(piece => [piece.id, piece]));
    }
    const own = ids.map(id => byId.get(id)).filter(Boolean);
    // What was learned with every word: a search kept goes first (these words found that piece before), a note's piece
    // is fused with the code's ranking.
    const learned = this.store.extraSearch(terms, limit).map(id => this.extrasById.get(id)).filter(Boolean);
    const piecesOf = kind => learned.filter(row => row.kind === kind).map(row => this.pieceOfExtra(row)).filter(Boolean);
    const noted = piecesOf('note');
    return [...new Set([...piecesOf('pick'), ...(noted.length ? fuse([own, noted]) : own)])].slice(0, limit);
  }

  /** The vectors of the pieces that have one, in one array: compared with a search's vector in one pass. */
  matrixOf() {
    if (this.matrix) return this.matrix;
    const pieces = this.pieces.filter(piece => this.vectors.has(piece.hash));
    const size = pieces.length ? this.vectors.get(pieces[0].hash).length : 0;
    const data = new Float32Array(pieces.length * size);
    pieces.forEach((piece, i) => {
      const vector = this.vectors.get(piece.hash);
      if (vector.length === size) data.set(vector, i * size);
    });
    // A note's vector stands for its piece too, where it is the closer of the two.
    const notes = [];
    pieces.forEach((piece, i) => {
      const note = this.notesByHash?.get(piece.hash);
      const vector = note && this.learnedVectors.get(this.extraKey(note));
      if (vector?.length === size) notes.push([i, vector]);
    });
    this.matrix = {pieces, size, data, notes};
    return this.matrix;
  }

  /** The pieces opened for searches kept whose words mean close to the query's vector `q`, closest first: `[piece, similarity]`. */
  pickedFor(q) {
    const {pickNear} = this.tuning;
    const best = new Map();
    for (const row of this.picks ?? []) {
      const vector = this.learnedVectors.get(this.extraKey(row));
      if (vector?.length !== q.length) continue;
      let sum = 0;
      for (let j = 0; j < q.length; j++) sum += q[j] * vector[j];
      if (sum < pickNear) continue;
      const piece = this.pieceOfExtra(row);
      if (piece && sum > (best.get(piece) ?? -Infinity)) best.set(piece, sum);
    }
    return [...best].sort((a, b) => b[1] - a[1]).slice(0, PICKED_PER_SEARCH);
  }

  /** The pieces closest in meaning to the query's vector `q`, best first, within the band below the best: `[piece, similarity]`. */
  meaningRanking(q, limit = LIST, band = this.tuning.band) {
    this.refreshLearned();
    const {pieces, size, data, notes} = this.matrixOf();
    if (!pieces.length || q.length !== size) return [];
    const scores = new Float32Array(pieces.length);
    for (let i = 0; i < pieces.length; i++) {
      let sum = 0;
      for (let j = 0, at = i * size; j < size; j++) sum += q[j] * data[at + j];
      scores[i] = sum;
    }
    for (const [i, vector] of notes) {
      let sum = 0;
      for (let j = 0; j < size; j++) sum += q[j] * vector[j];
      if (sum > scores[i]) scores[i] = sum;
    }
    let best = -Infinity;
    for (const score of scores) if (score > best) best = score;
    const near = [];
    for (let i = 0; i < pieces.length; i++) if (scores[i] >= best - band) near.push([pieces[i], scores[i]]);
    // Opened before for a search worded close to this one: first.
    const picked = this.pickedFor(q);
    const first = new Set(picked.map(([piece]) => piece));
    return [...picked, ...near.filter(([piece]) => !first.has(piece)).sort((a, b) => b[1] - a[1])].slice(0, limit);
  }

  /**
   * The line a piece is shown and opened at: its first with letters that is neither a comment (its doc comment is
   * above it) nor an import, with its text; not a `],`.
   */
  async headOf(piece) {
    const lines = await this.lines.get(piece.file);
    const body = lines?.slice(piece.from - 1, piece.to) ?? [];
    const prose = /\.(md|markdown|txt|rst)$/i.test(piece.file); // a heading is no comment there
    const imports = importLines(body);
    const letters = line => /\p{L}/u.test(line);
    let at = body.findIndex((line, i) => letters(line) && !imports.has(i) && (prose || !COMMENT.test(line)));
    if (at < 0) at = body.findIndex(line => letters(line));
    if (at < 0) at = Math.max(0, body.findIndex(line => line.trim()));
    return {line: piece.from + at, head: (body[at] ?? '').trim().slice(0, HEAD_CHARS)};
  }

  /**
   * A search result's text from its doc comment on, as the reranker reads it (see rerank.mjs): without its imports,
   * from its first line with letters; its head without its file.
   */
  async textOf(result, chars) {
    const lines = await this.lines.get(result.file);
    const text = lines && withoutImports(lines.slice(result.from - 1, result.to).join('\n')).replace(/^[^\p{L}]*\n/u, '').slice(0, chars);
    return text?.trim() ? text : result.head ?? '';
  }

  /** A piece as a search answers it: `{file, line, from, to, head, kind, name, meaning, words, note}`. */
  async result(piece, {meaning = null, words = false} = {}) {
    const {line, head} = await this.headOf(piece);
    return {
      file: piece.file, line, from: piece.from, to: piece.to, head, kind: piece.kind, name: piece.name,
      meaning: meaning === null ? null : Math.round(meaning * 1000) / 1000, words, note: this.notesByHash?.get(piece.hash)?.text ?? null,
    };
  }

  /** The word search alone: what shows on every key. */
  async wordSearch(query, {limit = 30} = {}) {
    return Promise.all(this.wordRanking(query, limit).map(piece => this.result(piece, {words: true})));
  }

  /** The meaning search alone: the query embedded once, against every vector. Words only without an embedder. */
  async meaningSearch(query, {limit = 30} = {}) {
    if (!this.embedder) return [];
    const [q] = await this.embed([this.embedder.query(query)], {urgent: true});
    return Promise.all(this.meaningRanking(q, limit).map(([piece, score]) => this.result(piece, {meaning: score})));
  }

  /** Meaning and words fused by reciprocal rank, best first. */
  async search(query, {limit = 30} = {}) {
    if (!this.embedder) return this.wordSearch(query, {limit});
    // Asked even before anything is embedded: an embedder that cannot run is found now, and said.
    const [q] = await this.embed([this.embedder.query(query)], {urgent: true});
    const meaning = q ? this.meaningRanking(q, Math.max(LIST, limit)) : [];
    const keyword = this.wordRanking(query, Math.max(LIST, limit));
    const similarity = new Map(meaning);
    const keywordSet = new Set(keyword);
    const ranked = fuse([meaning.map(([piece]) => piece), keyword]).slice(0, limit);
    return Promise.all(ranked.map(piece => this.result(piece, {meaning: similarity.get(piece) ?? null, words: keywordSet.has(piece)})));
  }

  /**
   * The pieces a search of `mode` ranks for the files view, best first: 'words' (pieces with any of the words, by BM25:
   * a sentence's words are seldom all in one piece), 'meaning' (the query's vector against every piece's, within `band`
   * below the best, the model's by default) or 'fused' (meaning and the pieces with every word, by reciprocal rank).
   * The words alone without an embedder.
   */
  async ranking(query, mode, {limit = LIST, band} = {}) {
    if (mode === 'words' || !this.embedder) return this.wordRanking(query, limit, {any: true});
    const [q] = await this.embed([this.embedder.query(query)], {urgent: true});
    const meaning = q ? this.meaningRanking(q, Math.max(LIST, limit), band).map(([piece]) => piece) : [];
    if (mode === 'meaning') return meaning.slice(0, limit);
    return fuse([meaning, this.wordRanking(query, Math.max(LIST, limit))]).slice(0, limit);
  }

  /**
   * The files a search of `mode` (see ranking) finds, best first, each as its best piece's result with `score` and
   * `hits` (its pieces among the first FILE_PIECES). `results` instead of a ranking: those, ranked as files.
   */
  async fileSearch(query, {mode = 'fused', limit = 20, results = null} = {}) {
    const ranked = results ?? await this.ranking(query, mode, {limit: FILE_PIECES, band: 2});
    return Promise.all(filesOf(ranked).slice(0, limit).map(async ({best, score, hits}) => ({
      ...(results ? best : await this.result(best)), score: Math.round(score * 10000) / 10000, hits,
    })));
  }

  /** How far the index is: files, pieces (by hash), how many have vectors, the file's bytes and when it changed. */
  progress() {
    const hashes = new Set(this.pieces.map(piece => piece.hash));
    const embedded = [...hashes].filter(hash => this.vectors.has(hash)).length;
    const files = [...this.files.values()].filter(file => !file.skipped).length;
    return {root: this.root, files, chunks: hashes.size, embedded, ...this.store.stats(), capped: this.capped, reading: this.reading};
  }
}

const seconds = ms => `${Math.round(ms / 1000)} s`;
// Turned off (turnOff) with an "embedding" model: nothing to delete but the indexes, and this note that keeps it off.
const offPath = dataDir => join(dataDir, 'off');
const FAILED_MS = 60_000;
const UNOPENED = 'the search index cannot be opened (see :checkhealth semantic-grep): :SemanticGrep rebuild makes it again';

/**
 * Search by meaning for one host (the stdio server one Neovim spawns, or another program that embeds the library).
 * The word search works once a project is open; meaning needs a model: the config's `embedding` entry (an
 * OpenAI-compatible /v1/embeddings, see embedder.mjs), or an `embedder` the host passes in. `config` is
 * `{index: "data" | "project", projectDir}`, or false to turn it all off.
 *
 * Hooks for the host, all optional:
 * - `embedder`: `{id, ready, msPerText, document(file, text), query(text), embed(texts, {urgent}), fail(error), close()}`;
 *   `id` names its vectors in the index (another model's are never compared with its own).
 * - `provider`: a model the host fetches and runs itself (a local runtime and its download), for `embedder`:
 *   `{name, state() -> "off" | "installing" | "downloading" | "on", needs() -> {runtime, model}, turnOn({progress,
 *   signal}) -> {runtime, model}, turnOff() -> {venv}, snapshot() -> {...}}`. Without one, an `embedder` is on.
 * - `book(root, kind, text, {detail})`: a build, a search, a rerank, for a log of what happened ("indexed",
 *   "searched", "reranked").
 * - `progress(root, {phase: "reading" | "embedding" | "done" | "failed", done, total, text})`: how far a build is.
 * - `log(line)`: what went wrong, for the host's log.
 * Indexes the projects opened (`open`, and `leave` once done), one batch at a time across them, in the background.
 * `reranker` (see rerank.mjs), when the config has one, reorders the first pieces of `search`'s fused list, and of a
 * picker's once it settles (`rerank`).
 */
export class Meaning {
  constructor({dataDir, config = {}, embedding = null, reranker = null, notes = null, writer = null, log = () => {}, book = () => {}, progress = () => {}, fetch = globalThis.fetch, embedder = null, provider = null, treeSitter = null, now = Date.now}) {
    Object.assign(this, {dataDir, config, embedding, reranker, log, book, fetch, now, provider});
    this.reranking = new Map(); // an asker (a Neovim) -> the turn of its latest picker rerank: an older one is stale
    this.tell = progress;
    this.disabled = config === false;
    this.parsers = []; // the tree-sitter parsers of the user's Neovim, as it says at its hello
    this.embedder = embedder ?? (embedding ? new HttpEmbedder({entry: embedding, apiKey: () => apiKeyOf(embedding), fetch, log}) : null);
    this.treeSitter = treeSitter ?? new TreeSitter({parsers: () => this.parsers, log});
    this.indexes = new Map(); // root -> ProjectIndex
    this.failures = new Map(); // root -> {at, index}: an index file that could not be opened lately
    this.wanted = new Set(); // the roots open
    this.turning = null; // a turnOn under way
    this.problem = null; // why the embedder cannot run, until the next try
    this.problemAt = 0;
    this.working = false;
    this.timer = setInterval(() => this.rescan().catch(error => log(`meaning: ${error.message}`)), RESCAN_MS);
    this.timer.unref?.();
    // The notes writer (notes.mjs): off without a `notes` entry. It writes while nothing is searched (see writeNotes).
    this.writer = writer ?? (notes ? new NotesWriter({entry: notes, fetch, log}) : null);
    this.activeAt = this.now();
    this.noting = null; // {abort} while the writer writes
    this.notesRestUntil = 0;
    this.notesFailed = new Set(); // pieces the writer gave no note for, this session: not asked again until the next
    if (this.writer) {
      this.notesTimer = setInterval(() => this.writeNotes().catch(error => log(`meaning: notes: ${error.message}`)), NOTES_TICK_MS);
      this.notesTimer.unref?.();
    }
  }

  /**
   * 'disabled' (config false), 'off' (words only: no model, or turned off), 'installing' or 'downloading' (the
   * provider's model is on its way) or 'on'.
   */
  get state() {
    if (this.disabled) return 'disabled';
    if (this.embedding) return existsSync(offPath(this.dataDir)) ? 'off' : 'on';
    if (this.provider) return this.provider.state();
    return this.embedder ? 'on' : 'off';
  }

  /** The model that gives the vectors, for people. */
  get modelName() { return this.embedding ? `${this.embedding.model} at ${this.embedding.baseUrl}` : this.provider?.name ?? this.embedder?.id ?? null; }

  /** The tree-sitter parsers a Neovim has (`parser/<lang>.so` paths): the pieces of their languages' files are found by them. */
  useParsers(paths) {
    if (Array.isArray(paths)) this.parsers = [...new Set([...this.parsers, ...paths.filter(path => typeof path === 'string')])];
  }

  /** The project at `root` has a session: its index loads, is looked over and builds in the background. */
  open(root) {
    if (this.disabled) return null;
    this.wanted.add(root);
    if (this.indexes.has(root)) return this.indexes.get(root);
    const failed = this.failures.get(root);
    if (failed && this.now() - failed.at < FAILED_MS) return failed.index; // not tried again on every key
    const index = new ProjectIndex({root, store: null, embedder: this.embedder, projectDir: this.config?.projectDir, treeSitter: this.treeSitter, log: this.log, now: this.now, onProgress: how => this.tell(root, how), embedding: () => this.state === 'on'});
    index.wantedAt = 0; // a search, or a rebuild, sets it: the project last wanted is embedded first
    this.indexes.set(root, index);
    index.loaded = (async () => {
      const place = await indexPlace({dataDir: this.dataDir, root, where: this.config?.index, projectDir: this.config?.projectDir});
      index.store = IndexStore.open(place.path);
      index.store.forgetTrees(tree => tree === root || existsSync(tree));
      index.load();
    })();
    index.ready = index.loaded.then(async () => {
      // A first build tells the editors as it starts; its words take seconds, and need no `book` line of their own.
      const first = !index.files.size;
      if (first) this.tell(root, {phase: 'reading', done: 0, total: null});
      await index.scan();
      index.scanned = true;
      index.store.prune(index.embedder ? index.model : null);
      if (first) {
        const {chunks, embedded} = index.progress();
        index.told = this.state === 'on' && embedded < chunks;
        this.tell(root, {phase: index.told ? 'embedding' : 'done', done: embedded, total: chunks});
      }
    }).then(() => {
      // Searched while its files were still being read: now it has pieces waiting, it goes first.
      if (this.building && this.building !== index && index.wantedAt > (this.building.wantedAt ?? 0)) this.reorder = true;
      this.work();
    }, error => {
      // An index file that cannot be opened (or read): this project goes without, and the next search tries again.
      this.log(`meaning: ${root}: ${error.message}`);
      index.closed = true;
      index.store?.release();
      if (this.indexes.get(root) === index) this.indexes.delete(root);
      index.failure = error;
      this.failures.set(root, {at: this.now(), index});
    });
    return index;
  }

  /** The session at `root` ended: the index leaves memory (it is on disk already). */
  async leave(root) {
    this.wanted.delete(root);
    const index = this.indexes.get(root);
    if (!index) return;
    this.indexes.delete(root);
    index.closed = true; // a batch under way is dropped, not written to a closed file
    await index.ready;
    if (!index.failure) index.store?.release();
  }

  /** A file saved in Neovim at `root`: its changed pieces are embedded again. */
  async saved(root, path) {
    const index = this.indexes.get(root);
    if (!index) return;
    await index.ready;
    await index.saved(path);
    this.work();
  }

  /** Projects looked over again every RESCAN_MS, for changes made outside Neovim (a checkout, a pull). */
  async rescan() {
    for (const index of [...this.indexes.values()]) {
      await index.ready;
      if (this.indexes.get(index.root) !== index || index.closed) continue;
      try {
        await index.scan();
        if (!index.closed) {
          index.store.prune(index.embedder ? index.model : null);
          index.store.checkpoint();
          index.trim();
        }
      } catch (error) {
        this.log(`meaning: ${index.root}: ${error.message}`);
      }
    }
    this.work();
  }

  /**
   * Embeds what waits, one batch at a time, project after project, and again while any project has pieces waiting
   * (a save elsewhere meanwhile); stops at a problem with the embedder. A build of BOOKED_PIECES or more gets a
   * `book` line, and tells the project's editors how far it is.
   */
  async work() {
    if (this.working || this.state !== 'on') return;
    if (this.problem && this.now() - this.problemAt < RESCAN_MS) return;
    this.working = true;
    this.problem = null;
    let index = null;
    try {
      for (let more = true, passes = 0; more && passes < 10; passes++) { // a few passes at most: never a loop
        more = false;
        // The project searched last goes first; the others in the order their sessions came.
        projects: for (index of [...this.indexes.values()].toSorted((a, b) => (b.wantedAt ?? 0) - (a.wantedAt ?? 0))) {
          const waiting = index.pending().length + index.learnedPending().length;
          if (!waiting) continue;
          more = true;
          const build = {startedAt: this.now(), chunks: waiting, toldAt: this.now()};
          // Each step embeds a batch or reads a changed file again: bounded all the same, never a spin.
          let steps = 0;
          const most = waiting + 50;
          const step = () => index.step().catch(error => {
            if (index.closed) return false; // closed under it: the session ended, or a rebuild
            throw error;
          });
          this.building = index;
          while (this.indexes.get(index.root) === index && !this.reorder && steps++ < most && await step()) {
            if (build.chunks >= BOOKED_PIECES && this.now() - build.toldAt > PROGRESS_MS) {
              build.toldAt = this.now();
              index.told = true;
              const {chunks, embedded} = index.progress();
              this.tell(index.root, {phase: 'embedding', done: embedded, total: chunks});
            }
          }
          this.building = null;
          if (this.reorder) { // another project was searched: it goes first, and this one goes on after it
            this.reorder = false;
            passes--;
            break projects;
          }
          if (this.indexes.get(index.root) !== index) continue;
          if (build.chunks < BOOKED_PIECES) {
            if (index.told && !index.pending().length) { // the editors heard it start: they hear it end
              index.told = false;
              const {chunks, embedded} = index.progress();
              this.tell(index.root, {phase: 'done', done: embedded, total: chunks});
            }
            continue;
          }
          index.told = false;
          index.store.checkpoint();
          const {files, chunks, embedded, bytes} = index.progress();
          this.tell(index.root, {phase: 'done', done: embedded, total: chunks});
          this.book(index.root, 'indexed', `indexed ${build.chunks} piece${build.chunks === 1 ? '' : 's'} by meaning in ${seconds(this.now() - build.startedAt)}: ${files} files, ${chunks} pieces, ${Math.round(bytes / 1024)} KB`);
        }
      }
    } catch (error) {
      this.problem = error.message;
      this.problemAt = this.now();
      this.log(`meaning: indexing stops: ${error.message}`);
      if (index) this.tell(index.root, {phase: 'failed', text: error.message});
    } finally {
      this.working = false;
      this.building = null;
      this.reorder = false;
    }
  }

  /** `index` is searched (or rebuilt): it goes first among the projects waiting, between two batches of another. */
  want(index) {
    index.wantedAt = this.now();
    if (this.building && this.building !== index) this.reorder = true;
  }

  /** Someone searches: the notes writer stops what it writes (its model's CPU or GPU is the search's), and waits. */
  active() {
    this.activeAt = this.now();
    this.noting?.abort();
  }

  /** The index of `root`, opened if it had no session yet, with what is on disk loaded (its scan may still run). */
  async indexOf(root, {quiet = false} = {}) {
    const index = this.open(root);
    if (!index) return null;
    if (!quiet) {
      this.want(index);
      this.active();
    }
    try {
      await index.loaded; // what is on disk; a scan under way is not waited for
    } catch {
      return null; // its file cannot be opened: said in the log, tried again at the next search
    }
    if (index.closed) return null; // its scan failed and closed it: tried again a minute later
    if (!this.working) index.ready.then(() => this.work()); // pieces still waiting (the model came since) are embedded
    return index;
  }

  /** How far the index of `root` is, for a search's answer. */
  about(index) {
    const {chunks, embedded, capped, reading} = index.progress();
    // A first build that has not listed its files yet is reading them too: a search then finds nothing, not for its words.
    const listing = !reading && !index.scanned && !index.files.size ? {done: 0, total: null} : null;
    return {chunks, embedded, ...(capped ? {capped: MAX_PIECES} : {}), ...(reading ?? listing ? {reading: reading ?? listing} : {})};
  }

  /** The word search in `root`: what a picker shows on every key. `{type: 'found', phase: 'words', results, ...}`. */
  async words(root, query, {limit = 30} = {}) {
    const answer = {phase: 'words', query, state: this.state, results: []};
    const index = await this.indexOf(root);
    if (!index) return this.disabled ? answer : {...answer, problem: UNOPENED};
    answer.results = await index.wordSearch(query, {limit});
    return Object.assign(answer, this.about(index));
  }

  /** The meaning search alone in `root`: what a picker adds once typing stops. Off, or failing, it says why. */
  async meaningOnly(root, query, {limit = 30} = {}) {
    const answer = {phase: 'meaning', query, state: this.state, results: []};
    if (this.state !== 'on') return answer;
    const index = await this.indexOf(root);
    if (!index) return {...answer, problem: UNOPENED};
    const started = this.now();
    try {
      answer.results = await index.meaningSearch(query, {limit});
      this.recovered();
    } catch (error) {
      this.failed(error);
      answer.problem = error.message;
    }
    return Object.assign(answer, {ms: this.now() - started}, this.about(index), this.reranker?.available ? {reranker: this.reranker.model} : {});
  }

  /**
   * `results` (a search's, best first) with the reranker's order for their first pieces: `{results, rerank}`, where
   * `rerank` says what happened (`{model, top, ms, applied, moved}`, `model` the one that answered, or with `why` the
   * order was kept, `model` the one that failed last), with `skipped`, the models before it that failed or rest
   * (`{model, why, problem}` each), or is null without a reranker. The model reads each piece's text from the files. `options` go to the reranker's rerank.
   */
  async reranked(index, query, results, options = {}) {
    const reranker = this.reranker;
    if (!reranker || (!options.prepare && results.length < 2)) return {results, rerank: null};
    // A note goes first: a sentence on what the piece does says more in the model's few characters than its code.
    const textsOf = list => Promise.all(list.slice(0, reranker.top).map(async result => pieceText(result, `${result.note ? `${result.note} | ` : ''}${await index.textOf(result, reranker.chars ?? SNIPPET_CHARS)}`, reranker.chars ?? SNIPPET_CHARS)));
    const done = options.prepare
      ? await reranker.rerank(query, [], {...options, prepare: async () => { const list = await options.prepare(); return {results: list, texts: await textsOf(list)}; }})
      : await reranker.rerank(query, results, {...options, texts: await textsOf(results)});
    const skipped = (done.skipped ?? []).map(skip => ({model: skip.model, why: skip.why, problem: skip.error}));
    const rerank = {
      model: done.model ?? reranker.model, top: done.top ?? reranker.top, ms: done.ms, applied: done.ok,
      ...(done.ok ? {moved: done.moved} : {why: done.why, problem: done.error}), ...(skipped.length ? {skipped} : {}),
    };
    return {results: done.results, rerank};
  }

  /**
   * A picker's search, settled (typing stopped and meaning came): the fused ranking's first pieces, as /find's,
   * reranked, for the picker to put first. `{phase: 'rerank', query, results, rerank}`. `who` is the asking Neovim: its
   * newer rerank, or its next key (`dropRerank`), makes this one stale ("aborted", not booked). It waits its turn for
   * the model; its ranking is read once the model is its.
   */
  async rerank(root, query, {who = null} = {}) {
    const answer = {phase: 'rerank', query, state: this.state, results: [], rerank: null};
    const reranker = this.reranker;
    if (!reranker) return answer;
    const turn = (this.reranking.get(who) ?? 0) + 1; // taken at once: a key from now on drops it
    this.reranking.set(who, turn);
    const index = await this.indexOf(root);
    if (!index) return answer;
    let before = [];
    const prepare = async () => {
      try {
        before = this.state === 'on' ? await index.search(query, {limit: reranker.top}) : await index.wordSearch(query, {limit: reranker.top});
      } catch {
        before = await index.wordSearch(query, {limit: reranker.top}).catch(() => []);
      }
      return before;
    };
    const stale = () => this.reranking.get(who) !== turn || this.reranker !== reranker;
    const done = await this.reranked(index, query, [], {wait: true, prepare, stale});
    if (this.reranking.get(who) === turn) this.reranking.delete(who);
    Object.assign(answer, {results: done.results, rerank: done.rerank});
    if (done.rerank && done.rerank.why !== 'aborted') this.bookRerank(root, query, before, answer, ' in the picker');
    return answer;
  }

  /** The picker of `who` moved on (a key, or it closed): its rerank waiting or under way is not used. */
  dropRerank(who) {
    this.reranking.set(who, (this.reranking.get(who) ?? 0) + 1);
  }

  /** A Neovim went: what it asked is forgotten. */
  forget(who) {
    this.reranking.delete(who);
  }

  /** A rerank booked: what moved, or why the order stayed, with the order before and after behind ⏎. Each model that failed
   * before the one that answered is named, with why. */
  bookRerank(root, query, before, {results, rerank}, how = '') {
    const failure = why => (why === 'timeout' ? 'too slow' : why === 'flat' ? 'saw no piece stand out' : why === 'down' ? 'not answering lately' : why === 'busy' ? 'busy with another search'
      : why === 'short' ? 'had too little to rank' : why === 'malformed' ? 'answered oddly' : 'failed');
    const at = result => `${result.file}:${result.line}`;
    // The models asked before, or not asked while they rest: "after d3-flash too slow (no answer within 1000 ms)".
    const earlier = rerank.skipped?.length ? ` (after ${rerank.skipped.map(skip => `${skip.model} ${failure(skip.why)} (${skip.problem})`).join(', ')})` : '';
    const text = rerank.applied
      ? `"${query}"${how} with ${rerank.model}${earlier} in ${rerank.ms} ms: ${rerank.moved ? `${rerank.moved} of ${Math.min(before.length, rerank.top)} moved${at(results[0]) !== at(before[0]) ? `, first now ${at(results[0])} (was ${at(before[0])})` : ''}` : 'the order stayed'}`
      : `"${query}"${how}: kept the search's order, ${rerank.model} ${failure(rerank.why)} (${rerank.problem})${earlier}`;
    const lines = list => list.slice(0, rerank.top).map(result => `${at(result)}${result.rerank !== undefined ? `  ${result.rerank}` : ''}  ${result.head}`).join('\n');
    this.book(root, 'reranked', text, {detail: {output: rerank.applied ? `before:\n${lines(before)}\n\nafter (the model's probability):\n${lines(results)}` : lines(before)}});
  }

  recovered() {
    if (!this.problem) return;
    this.problem = null; // the embedder runs again (the runtime was installed, say): the build goes on
    this.work();
  }

  failed(error) {
    this.problem = error.message;
    this.problemAt = this.now();
  }

  /**
   * What a search in the project at `root` finds, meaning and words fused: `{query, state, results, ...why}`. Without
   * meaning (off, or its model failing), the words alone, and why.
   */
  async search(root, query, {limit = 30, book = true, rerank = true} = {}) {
    const state = this.state;
    const answer = {query, state, results: []};
    const index = await this.indexOf(root);
    if (!index) return this.disabled ? answer : {...answer, problem: UNOPENED};
    const started = this.now();
    if (state !== 'on') answer.results = await index.wordSearch(query, {limit});
    else {
      try {
        answer.results = await index.search(query, {limit});
        this.recovered();
      } catch (error) {
        // The embedder cannot run: the words still rank, and the answer says why meaning is missing.
        this.failed(error);
        answer.problem = error.message;
        answer.results = await index.wordSearch(query, {limit});
      }
    }
    if (rerank && this.reranker?.available) { // resting after a failure: the failure was booked once
      const before = answer.results;
      Object.assign(answer, await this.reranked(index, query, before));
      if (answer.rerank) this.bookRerank(root, query, before, answer); // vim.ui.select's too, whose search is booked at the pick
    }
    Object.assign(answer, {ms: this.now() - started}, this.about(index));
    if (book) this.booked(root, query, answer.results);
    return answer;
  }

  /**
   * The files a search in `root` finds, best first (ProjectIndex's fileSearch): `{query, state, results: [{file, line,
   * from, to, head, score, hits, ...}], rerank?, ...why}`. `mode` is 'rerank' (the files view: fused, then the
   * reranker's order when there is one), 'fused', 'words' or 'meaning'. Without meaning, the words alone, and why.
   */
  async files(root, query, {limit = 20, mode = 'rerank'} = {}) {
    const answer = {query, state: this.state, results: []};
    const index = await this.indexOf(root);
    if (!index) return this.disabled ? answer : {...answer, problem: UNOPENED};
    const started = this.now();
    const on = this.state === 'on';
    if (mode === 'words' || !on) answer.results = mode === 'meaning' ? [] : await index.fileSearch(query, {mode: 'words', limit});
    else {
      try {
        const rerank = mode === 'rerank' && this.reranker?.available;
        if (!rerank) answer.results = await index.fileSearch(query, {mode: mode === 'rerank' ? 'fused' : mode, limit});
        else {
          const pieces = await Promise.all((await index.ranking(query, 'fused', {limit: FILE_PIECES, band: 2})).map(piece => index.result(piece)));
          const done = await this.reranked(index, query, pieces);
          answer.rerank = done.rerank;
          answer.results = await index.fileSearch(query, {limit, results: done.results});
        }
        this.recovered();
      } catch (error) {
        this.failed(error);
        answer.problem = error.message;
        answer.results = mode === 'meaning' ? [] : await index.fileSearch(query, {mode: 'words', limit});
      }
    }
    return Object.assign(answer, {ms: this.now() - started}, this.about(index));
  }

  /**
   * A search booked, with its ranking behind ⏎. One booked " in the picker" is what someone opened from the picker
   * (the stdio server's "chosen", pairing-buddy's find_chosen): it is learned too (see `learn`).
   */
  booked(root, query, results, how = '') {
    if (how === ' in the picker' && results.length) this.learn(root, query, results).catch(error => this.log(`meaning: learning a search: ${error.message}`));
    const top = results[0];
    this.book(root, 'searched', `by meaning "${query}"${how}: ${results.length} result${results.length === 1 ? '' : 's'}${top ? `, first ${top.file}:${top.line}` : ''}`, {
      detail: {output: results.map(result => `${result.file}:${result.line}  ${result.meaning ?? '-'}${result.words ? ' +words' : ''}  ${result.head}`).join('\n')},
    });
  }

  /**
   * The piece someone opened for `query` (`results`, a picker's choice, `{file, line|from}` each): kept, so the same
   * search, or one worded close to it, finds that piece first, by its words and by their meaning. Kept per repository,
   * across rebuilds; the newest searches only.
   */
  async learn(root, query, results) {
    const text = String(query ?? '').trim();
    const index = this.indexes.get(root);
    if (!text || !index || this.disabled) return;
    await index.loaded;
    if (index.closed || !index.store) return;
    for (const result of results.slice(0, PICKED_PER_SEARCH)) {
      const line = Number(result?.line ?? result?.from);
      if (typeof result?.file !== 'string' || !Number.isInteger(line)) continue;
      const piece = (index.byFile.get(result.file) ?? []).find(each => each.from <= line && line <= each.to);
      index.store.putPick({hash: piece?.hash ?? null, file: result.file, line: piece?.from ?? line, query: text, words: words(text).join(' '), at: this.now()});
    }
    index.loadLearned();
    this.work(); // its words' vector
  }

  /**
   * The pieces of `root` without a note, for a coding agent to write one each (see `addNotes`): `{pieces: [{hash, file,
   * from, to, name, text}], pending, noted}`, at most `limit` of them; `pending` counts them all.
   */
  async pendingNotes(root, {limit = 50, quiet = false, skip = null} = {}) {
    const index = await this.indexOf(root, {quiet});
    if (!index) return {problem: UNOPENED, pieces: [], pending: 0, noted: 0};
    await index.ready?.catch(() => {});
    index.refreshLearned();
    const seen = new Set();
    const pieces = [];
    let pending = 0;
    for (const piece of index.pieces) {
      if (seen.has(piece.hash) || index.notesByHash.has(piece.hash) || skip?.has(piece.hash)) continue;
      seen.add(piece.hash);
      pending += 1;
      if (pieces.length >= limit) continue;
      const lines = await index.lines.get(piece.file);
      const text = lines?.slice(piece.from - 1, piece.to).join('\n');
      if (text === undefined || pieceHash(piece.file, text, piece.name) !== piece.hash) continue; // changed since: read again first
      pieces.push({hash: piece.hash, file: piece.file, from: piece.from, to: piece.to, name: piece.name, text});
    }
    return {pieces, pending, noted: index.notesByHash.size};
  }

  /**
   * Notes on pieces of `root`, `{hash, note}` each (an empty note removes one): searched by their words and meaning
   * with their piece, and read by the reranker. A hash the index does not have (its code changed) is `unknown`.
   */
  async addNotes(root, notes, {source = 'agent', quiet = false} = {}) {
    const index = await this.indexOf(root, {quiet});
    if (!index) return {problem: UNOPENED, added: 0, unknown: []};
    await index.ready?.catch(() => {});
    let added = 0;
    const unknown = [];
    for (const each of Array.isArray(notes) ? notes : []) {
      const piece = typeof each?.hash === 'string' && typeof each.note === 'string' ? index.pieceOfExtra({kind: 'note', hash: each.hash}) : null;
      if (!piece) { unknown.push(each?.hash ?? null); continue; }
      index.store.putNote({hash: piece.hash, file: piece.file, line: piece.from, note: each.note, words: words(each.note).join(' '), source: each.source ?? source, at: this.now()});
      added += 1;
    }
    index.loadLearned();
    this.work(); // the notes' vectors
    return {added, unknown};
  }

  /**
   * The notes writer's turn (every NOTES_TICK_MS): when nothing was searched for its `idleMs` and no project is being
   * embedded, it writes a note for each piece of the open projects that has none (the project searched last first), a
   * few pieces at a time, and stops as soon as someone searches. A batch it got no note for at all rests it a few
   * minutes; a piece it got none for is left until the next session. Resolves how many notes it wrote.
   */
  async writeNotes({idle = () => this.now() - this.activeAt >= this.writer.entry.idleMs} = {}) {
    // A first build (or a checkout's) goes first: its pieces' vectors are the search's. The notes' own vectors are not.
    const building = () => this.working && [...this.indexes.values()].some(index => index.store && !index.closed && index.pending().length);
    if (!this.writer || this.noting || building() || this.disabled) return 0;
    if (this.now() < this.notesRestUntil || !idle()) return 0;
    const controller = new AbortController();
    this.noting = controller;
    let written = 0;
    try {
      for (const index of [...this.indexes.values()].toSorted((a, b) => (b.wantedAt ?? 0) - (a.wantedAt ?? 0))) {
        const started = this.now();
        let here = 0;
        while (!controller.signal.aborted && !building() && idle() && this.indexes.get(index.root) === index && !index.closed) {
          const {pieces, pending, problem} = await this.pendingNotes(index.root, {limit: this.writer.entry.concurrency * NOTES_BATCH, quiet: true, skip: this.notesFailed});
          if (problem || !pieces.length) break;
          const {notes, errors} = await this.writer.write(pieces, {signal: controller.signal});
          if (notes.length) { // those written before a search stopped it too
            await this.addNotes(index.root, notes, {source: this.writer.name, quiet: true});
            here += notes.length;
          }
          if (controller.signal.aborted) break;
          const noted = new Set(notes.map(note => note.hash));
          // A model that answered with no note is asked of other pieces; one that did not answer rests.
          const unanswered = errors.some(error => !error.endsWith(NO_NOTE));
          if (!notes.length && unanswered) {
            this.notesRestUntil = this.now() + NOTES_REST_MS;
            this.log(`meaning: notes: ${this.writer.about} wrote none of ${pieces.length} (${errors[0]}); resting ${seconds(NOTES_REST_MS)}`);
            break;
          }
          if (!unanswered) for (const piece of pieces) if (!noted.has(piece.hash)) this.notesFailed.add(piece.hash);
          if (pending <= pieces.length) break;
        }
        written += here;
        if (here) this.book(index.root, 'noted', `wrote ${here} note${here === 1 ? '' : 's'} with ${this.writer.entry.model} in ${seconds(this.now() - started)}`);
      }
      return written;
    } finally {
      this.noting = null;
    }
  }

  /** A rebuild (:SemanticGrep rebuild): the repository's index file is deleted and made again from the files, every vector too. */
  async rebuild(root) {
    if (this.disabled) return null;
    this.failures.delete(root);
    const index = this.indexes.get(root);
    if (index) await index.ready;
    // Its file, though it could not be opened: a broken one is what a rebuild is for.
    const path = index?.store?.path ?? (await indexPlace({dataDir: this.dataDir, root, where: this.config?.index, projectDir: this.config?.projectDir})).path;
    const roots = [...new Set([root, ...[...this.indexes.values()].filter(each => each.store?.path === path).map(each => each.root)])];
    for (const each of roots) await this.leave(each);
    removeIndex(path);
    for (const each of roots) { const reopened = this.open(each); if (reopened && each === root) this.want(reopened); }
    return path;
  }

  /** What `turnOn` would fetch, as the provider says: `{runtime, model}`. Nothing without one. */
  async needs() {
    if (this.disabled || this.embedding || !this.provider) return {runtime: null, model: false};
    return this.provider.needs();
  }

  /**
   * On: the provider fetches what its model needs (`progress({phase, bytes, total})` hears how far), or the
   * "embedding" model is asked again after turnOff; then the open projects are indexed. Resolves what the provider
   * fetched, `{runtime, model}`.
   */
  async turnOn({progress = () => {}} = {}) {
    if (this.disabled) throw new Error('search by meaning is turned off in the config');
    if (this.turning) return this.turning.then(() => ({runtime: null, model: false}));
    this.problem = null;
    this.turning = (async () => {
      await rm(offPath(this.dataDir), {force: true});
      if (this.embedding || !this.provider) return {runtime: null, model: false};
      return this.provider.turnOn({progress});
    })().finally(() => { this.turning = null; });
    const result = await this.turning;
    for (const root of [...this.wanted]) this.open(root);
    this.work();
    return result;
  }

  /**
   * Off again: every index of the open projects is deleted, and the provider deletes its model; with an "embedding"
   * model, a note in `dataDir` keeps it off until turnOn. Resolves the provider's answer (`{venv}`), or {venv: false}.
   */
  async turnOff() {
    const indexes = [...this.indexes.values()];
    this.indexes.clear();
    this.failures.clear();
    this.embedder?.fail?.(new Error('search by meaning was turned off')); // a batch under way is dropped, not waited for
    this.problem = null;
    const paths = new Set();
    for (const index of indexes) {
      index.closed = true;
      await index.ready;
      if (index.store) paths.add(index.store.path);
      if (!index.failure) index.store?.release();
    }
    for (const path of paths) { removeIndex(path); removeLearned(path); } // off: what was learned of the code goes too
    await rm(join(this.dataDir, 'index'), {recursive: true, force: true});
    const removed = !this.embedding && this.provider ? await this.provider.turnOff() : null;
    if (this.embedding) {
      await mkdir(this.dataDir, {recursive: true, mode: 0o700});
      await writeFile(offPath(this.dataDir), 'search by meaning was turned off; turning it on removes this file\n');
    }
    return {venv: !!removed?.venv};
  }

  /** The index's ranking of `query` in `root` for the search trail: the top pieces, or null when it has none. */
  async trailHits(root, query, limit = 2) {
    const index = this.indexes.get(root);
    // Only while the embedder answers at once: the trail does not wait for a model to load.
    if (this.state !== 'on' || !index || !index.vectors.size || this.problem || this.embedder?.ready === false) return null;
    await index.loaded;
    const hits = (await index.search(query, {limit})).filter(result => result.meaning !== null);
    this.book(root, 'searched', `by meaning "${query}", for the search trail: ${hits.map(hit => `${hit.file}:${hit.line}`).join(', ') || 'nothing close'}`);
    return hits;
  }

  /** For a health check and the host's status. */
  snapshot() {
    return {
      state: this.state, model: this.modelName, embedding: this.embedding ? {model: this.embedding.model, baseUrl: this.embedding.baseUrl, dimensions: this.embedding.dimensions ?? null} : null,
      problem: this.problem, rerank: this.reranker?.snapshot() ?? null,
      notes: this.writer ? {model: this.writer.about, written: this.writer.written, resting: this.now() < this.notesRestUntil, writing: !!this.noting} : null, msPerChunk: this.embedder?.msPerText ?? null,
      ...(this.provider?.snapshot ? this.provider.snapshot() : {}),
      treeSitter: this.treeSitter.missing ? 'no nvim' : 'nvim',
      indexes: [...this.indexes.values()].filter(index => index.store && !index.closed).map(index => index.progress()),
    };
  }

  async close() {
    clearInterval(this.timer);
    clearInterval(this.notesTimer);
    this.noting?.abort();
    for (const root of [...this.indexes.keys()]) await this.leave(root);
    this.embedder?.close?.();
  }
}
