// The search index on disk: one SQLite file per repository, shared by its worktrees. It holds where each piece
// of code is (its file and lines, the hash of its text, its kind and name, and what encloses it), the words of each piece
// for the word search (an FTS5 index without the text it was made from), and a vector per piece's key (its hash, with
// what encloses it: see pieceKey in meaning.mjs) and embedding model: worktrees of
// one repository embed a piece of code they share once. No copy of the code is kept; its lines are read from the files.
// The file is in Neovim's data folder (semantic-grep/index/<repository>-<hash>.sqlite), or with index = "project" in the
// repository as .semantic-grep/index.sqlite, listed in .git/info/exclude rather than .gitignore.
//
// What was learned about the repository's code lives beside it, in <index>.learned.sqlite, attached to the same
// connection: the searches people made and the piece they opened ("pick"), notes on pieces (a sentence a coding agent
// or a model wrote on what a piece does: "note"), with their words and vectors, and notes on files, written from their
// pieces' notes ("file"). A rebuild, or a new SCHEMA, keeps it.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const SCHEMA = 6; // pairing-buddy's too, once on this library: 4 cuts pieces by indentation and titles their vectors, 6 adds what encloses a piece to its title
export const PROJECT_DIR = '.semantic-grep';
const MAX_PICKS = 5000; // the searches kept, newest first
const NOTE_CHARS = 1000;

/** Where what was learned of an index's repository is kept: beside the index file. */
export const learnedPath = indexPath => indexPath.replace(/\.sqlite$/, '') + '.learned.sqlite';

const git = (args, cwd) => new Promise(resolve => {
  execFile('git', args, {cwd}, (error, stdout) => resolve(error ? null : stdout.trim()));
});

/**
 * Where the index of the project at `root` is: `{path, repository, tree}`. Worktrees of one repository share a file:
 * it is named by the repository's git folder. In the project (`where` "project"), it is .semantic-grep/index.sqlite in
 * the repository's main worktree, and .semantic-grep/ goes in the repository's info/exclude.
 */
export async function indexPlace({dataDir, root, where = 'data', projectDir = PROJECT_DIR}) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const repository = common ? (basename(common) === '.git' ? dirname(common) : common) : root;
  if (where === 'project') {
    if (common) exclude(common, projectDir);
    return {path: join(repository, projectDir, 'index.sqlite'), repository, tree: root};
  }
  const name = basename(repository).replace(/\.git$/, '').replace(/[^\w.-]+/g, '-') || 'project';
  const hash = createHash('sha1').update(common ?? root).digest('hex').slice(0, 8);
  return {path: join(dataDir, 'index', `${name}-${hash}.sqlite`), repository, tree: root};
}

/** Lists .semantic-grep/ in the repository's info/exclude, once: git leaves the index out, and .gitignore stays the team's. */
export function exclude(common, projectDir = PROJECT_DIR) {
  const path = join(common, 'info', 'exclude');
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch {}
  const names = [`${projectDir}/`, projectDir, `/${projectDir}/`, `/${projectDir}`];
  if (text.split('\n').some(line => names.includes(line.trim()))) return false;
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}# the search index of semantic-grep\n${projectDir}/\n`);
  return true;
}

const vectorOf = blob => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

/** The FTS5 query for `terms` (words already split and lower case): every one (with `any`, any one), each as the start of a word. */
export function matchOf(terms, any = false) {
  return terms.map(term => (term.length > 2 ? `"${term}"*` : `"${term}"`)).join(any ? ' OR ' : ' AND ');
}

const opened = new Map(); // path -> {store, users}

/** One repository's index file. `IndexStore.open(path)` shares it between the worktrees open at once. */
export class IndexStore {
  static open(path) {
    let entry = opened.get(path);
    if (!entry) {
      entry = {store: new IndexStore(path), users: 0};
      opened.set(path, entry);
    }
    entry.users += 1;
    return entry.store;
  }

  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    try {
      this.setUp();
    } catch (error) {
      this.db.close(); // not a database, or not writable: closed now, not when collected
      throw error;
    }
  }

  setUp() {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== SCHEMA) {
      // Made by another version (or empty): made again, from the files.
      this.db.exec('DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS pieces; DROP TABLE IF EXISTS words; DROP TABLE IF EXISTS meta');
      this.db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
        CREATE TABLE vectors (model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL); -- rows of 1 KB and more: no WITHOUT ROWID
        CREATE UNIQUE INDEX vectors_key ON vectors (model, hash);
        CREATE TABLE files (tree TEXT NOT NULL, file TEXT NOT NULL, size INTEGER, mtime REAL, skipped INTEGER NOT NULL DEFAULT 0, note TEXT, PRIMARY KEY (tree, file)) WITHOUT ROWID;
        CREATE TABLE pieces (id INTEGER PRIMARY KEY, tree TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, last INTEGER NOT NULL, hash TEXT NOT NULL, kind TEXT, name TEXT, key TEXT NOT NULL, context TEXT);
        CREATE INDEX pieces_file ON pieces (tree, file);
        CREATE INDEX pieces_hash ON pieces (hash);
        CREATE INDEX pieces_key ON pieces (key);
        CREATE VIRTUAL TABLE words USING fts5 (body, content = '', contentless_delete = 1, tokenize = 'porter unicode61');
        PRAGMA user_version = ${SCHEMA};
      `);
    }
    this.statements = {
      files: this.db.prepare('SELECT file, size, mtime, skipped, note FROM files WHERE tree = ?'),
      pieces: this.db.prepare('SELECT id, file, line, last, hash, kind, name, key, context FROM pieces WHERE tree = ? ORDER BY file, line'),
      piecesOf: this.db.prepare('SELECT id FROM pieces WHERE tree = ? AND file = ?'),
      deleteWords: this.db.prepare('DELETE FROM words WHERE rowid = ?'),
      deletePieces: this.db.prepare('DELETE FROM pieces WHERE tree = ? AND file = ?'),
      deleteFile: this.db.prepare('DELETE FROM files WHERE tree = ? AND file = ?'),
      putFile: this.db.prepare('INSERT OR REPLACE INTO files (tree, file, size, mtime, skipped, note) VALUES (?, ?, ?, ?, ?, ?)'),
      putPiece: this.db.prepare('INSERT INTO pieces (tree, file, line, last, hash, kind, name, key, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      putWords: this.db.prepare('INSERT INTO words (rowid, body) VALUES (?, ?)'),
      vector: this.db.prepare('SELECT vector FROM vectors WHERE model = ? AND hash = ?'),
      vectors: this.db.prepare('SELECT v.hash, v.vector FROM vectors v WHERE v.model = ? AND v.hash IN (SELECT key FROM pieces WHERE tree = ?)'),
      putVector: this.db.prepare('INSERT OR REPLACE INTO vectors (model, hash, vector) VALUES (?, ?, ?)'),
      search: this.db.prepare('SELECT p.id AS id FROM words JOIN pieces p ON p.id = words.rowid WHERE words MATCH ? AND p.tree = ? ORDER BY bm25(words) LIMIT ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      putMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    };    this.setUpLearned();
  }

  setUpLearned() {
    this.db.prepare('ATTACH DATABASE ? AS learned').run(learnedPath(this.path));
    this.db.exec(`
      PRAGMA learned.journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS learned.extras (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, hash TEXT, file TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL, source TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS learned.extras_hash ON extras (kind, hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS learned.extras_words USING fts5 (body, content = '', contentless_delete = 1, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS learned.vectors (model TEXT NOT NULL, key TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (model, key));
    `);
    this.writes = 0; // what this connection wrote to it: data_version counts only the others'
    Object.assign(this.statements, {
      extras: this.db.prepare('SELECT id, kind, hash, file, line, text, source, at FROM learned.extras ORDER BY id'),
      extraSearch: this.db.prepare('SELECT rowid AS id FROM learned.extras_words WHERE extras_words MATCH ? ORDER BY bm25(extras_words) LIMIT ?'),
      noteOf: this.db.prepare("SELECT id FROM learned.extras WHERE kind = 'note' AND hash = ?"),
      fileNoteOf: this.db.prepare("SELECT id FROM learned.extras WHERE kind = 'file' AND file = ?"),
      pickOf: this.db.prepare("SELECT id FROM learned.extras WHERE kind = 'pick' AND file = ? AND line = ? AND text = ?"),
      putExtra: this.db.prepare('INSERT INTO learned.extras (kind, hash, file, line, text, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      touchExtra: this.db.prepare('UPDATE learned.extras SET at = ?, hash = coalesce(?, hash) WHERE id = ?'),
      deleteExtra: this.db.prepare('DELETE FROM learned.extras WHERE id = ?'),
      putExtraWords: this.db.prepare('INSERT INTO learned.extras_words (rowid, body) VALUES (?, ?)'),
      deleteExtraWords: this.db.prepare('DELETE FROM learned.extras_words WHERE rowid = ?'),
      oldPicks: this.db.prepare("SELECT id FROM learned.extras WHERE kind = 'pick' ORDER BY at DESC LIMIT -1 OFFSET ?"),
      learnedVectors: this.db.prepare('SELECT key, vector FROM learned.vectors WHERE model = ?'),
      putLearnedVector: this.db.prepare('INSERT OR REPLACE INTO learned.vectors (model, key, vector) VALUES (?, ?, ?)'),
    });
  }

  /** What was learned: `{id, kind: "pick" | "note" | "file", hash, file, line, text, source, at}`, oldest first. */
  extras() { return this.statements.extras.all(); }

  /** Changes whenever anything learned changes, by this connection or another (another Neovim, the notes command). */
  learnedVersion() { return `${this.db.prepare('PRAGMA learned.data_version').get().data_version}:${this.writes}`; }

  dropExtra(id) {
    this.statements.deleteExtraWords.run(id);
    this.statements.deleteExtra.run(id);
  }

  /** A search and the piece opened for it (`hash`, and where it was): kept, the newest MAX_PICKS of them. */
  putPick({hash = null, file, line, query, words: body, at = Date.now()}) {
    this.transaction(() => {
      const known = this.statements.pickOf.get(file, line, query);
      if (known) this.statements.touchExtra.run(at, hash, known.id);
      else {
        const {lastInsertRowid} = this.statements.putExtra.run('pick', hash, file, line, query, 'pick', at);
        this.statements.putExtraWords.run(lastInsertRowid, body);
      }
      for (const {id} of this.statements.oldPicks.all(MAX_PICKS)) this.dropExtra(id);
      this.writes += 1;
    });
  }

  /** A note on the piece of `hash` (one each: a new one replaces it; an empty one removes it). */
  putNote({hash, file, line, note, words: body, source = null, at = Date.now()}) {
    this.transaction(() => {
      for (const {id} of this.statements.noteOf.all(hash)) this.dropExtra(id);
      const text = String(note ?? '').trim().slice(0, NOTE_CHARS);
      if (text) {
        const {lastInsertRowid} = this.statements.putExtra.run('note', hash, file, line, text, source, at);
        this.statements.putExtraWords.run(lastInsertRowid, body);
      }
      this.writes += 1;
    });
  }

  /**
   * A note on what the file `file` is for, written from its pieces' notes (one each: a new one replaces it; an empty one
   * removes it). It is no piece's: its words are not searched, it titles the file's small pieces (contextFor).
   */
  putFileNote({file, note, source = null, at = Date.now()}) {
    this.transaction(() => {
      for (const {id} of this.statements.fileNoteOf.all(file)) this.dropExtra(id);
      const text = String(note ?? '').trim().slice(0, NOTE_CHARS);
      if (text) this.statements.putExtra.run('file', null, file, 0, text, source, at);
      this.writes += 1;
    });
  }

  /** The learned rows with every one of `terms` (each as a word's start), best first by BM25: their ids. */
  extraSearch(terms, limit) {
    if (!terms.length) return [];
    return this.statements.extraSearch.all(matchOf(terms), limit).map(row => row.id);
  }

  /** The vectors of what was learned, by `model`: key -> Float32Array. */
  learnedVectors(model) {
    return new Map(this.statements.learnedVectors.all(model).map(row => [row.key, vectorOf(row.vector)]));
  }

  putLearnedVectors(model, entries) {
    this.transaction(() => {
      for (const [key, vector] of entries) this.statements.putLearnedVector.run(model, key, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    });
  }

  transaction(work) {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The files of worktree `tree` as last read: file -> {size, mtimeMs, skipped, note} (`note`: the file's note it was read with). */
  files(tree) {
    return new Map(this.statements.files.all(tree).map(row => [row.file, {size: row.size, mtimeMs: row.mtime, skipped: !!row.skipped, note: row.note ?? null}]));
  }

  /** The pieces of worktree `tree`: `{id, file, from, to, hash, kind, name, key, context}`. */
  pieces(tree) {
    return this.statements.pieces.all(tree).map(row => ({id: row.id, file: row.file, from: row.line, to: row.last, hash: row.hash, kind: row.kind, name: row.name, key: row.key, context: row.context ?? ''}));
  }

  /**
   * A file read again: its pieces (`{from, to, hash, kind, name, key, context, words}`) replace the ones it had, in one go; each comes
   * back with its id. `skipped` keeps a file found not worth indexing (binary, minified) from being read again; `note`
   * is the file's note its pieces were titled with, if any (a new one has them read again).
   */
  putFile(tree, file, {size, mtimeMs, skipped = false, note = null}, pieces = []) {
    return this.transaction(() => {
      this.dropPieces(tree, file);
      this.statements.putFile.run(tree, file, size, mtimeMs, skipped ? 1 : 0, note);
      this.touch();
      return pieces.map(piece => {
        const key = piece.key ?? piece.hash;
        const {lastInsertRowid} = this.statements.putPiece.run(tree, file, piece.from, piece.to, piece.hash, piece.kind ?? null, piece.name ?? null, key, piece.context || null);
        this.statements.putWords.run(lastInsertRowid, piece.words);
        return {id: Number(lastInsertRowid), file, from: piece.from, to: piece.to, hash: piece.hash, kind: piece.kind ?? null, name: piece.name ?? null, key, context: piece.context ?? ''};
      });
    });
  }

  dropPieces(tree, file) {
    for (const {id} of this.statements.piecesOf.all(tree, file)) this.statements.deleteWords.run(id);
    this.statements.deletePieces.run(tree, file);
  }

  /** A file gone from worktree `tree`. */
  removeFile(tree, file) {
    this.transaction(() => {
      this.dropPieces(tree, file);
      this.statements.deleteFile.run(tree, file);
    });
  }

  /** The vectors of `model` for the pieces of worktree `tree`: key (see pieceKey) -> Float32Array. */
  vectors(model, tree) {
    return new Map(this.statements.vectors.all(model, tree).map(row => [row.hash, vectorOf(row.vector)]));
  }

  /** The vector of `model` for one key, made in any worktree; or null. */
  vector(model, key) {
    const row = this.statements.vector.get(model, key);
    return row ? vectorOf(row.vector) : null;
  }

  putVectors(model, entries) {
    this.transaction(() => {
      for (const [hash, vector] of entries) this.statements.putVector.run(model, hash, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    });
    this.touch();
  }

  /** The ids of worktree `tree`'s pieces that have every one of `terms`, best first by BM25. */
  wordSearch(tree, terms, limit, any = false) {
    if (!terms.length) return [];
    return this.statements.search.all(matchOf(terms, any), tree, limit).map(row => row.id);
  }

  /**
   * Vectors no piece of any worktree has any more leave, and those of another model than `model`. Without a model (words
   * only: the notes command, a Neovim without an embedding model) the other models' vectors stay: they are not its to drop.
   */
  prune(model = null) {
    if (model) this.db.prepare('DELETE FROM vectors WHERE model != ? OR hash NOT IN (SELECT key FROM pieces)').run(model);
    else this.db.prepare('DELETE FROM vectors WHERE hash NOT IN (SELECT key FROM pieces)').run();
  }

  /** Worktrees whose folders are gone leave the index, with their pieces. */
  forgetTrees(exists) {
    const trees = this.db.prepare('SELECT DISTINCT tree FROM files').all().map(row => row.tree);
    for (const tree of trees.filter(tree => !exists(tree))) {
      this.transaction(() => {
        for (const {file} of this.statements.files.all(tree)) this.dropPieces(tree, file);
        this.db.prepare('DELETE FROM files WHERE tree = ?').run(tree);
      });
    }
  }

  meta(key, value) {
    if (value === undefined) return this.statements.getMeta.get(key)?.value ?? null;
    this.statements.putMeta.run(key, String(value));
  }

  touch() { this.meta('updatedAt', Date.now()); }

  /** The write-ahead log folded into the file and emptied: after a build, it would otherwise stay as big as the build. */
  checkpoint() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA learned.wal_checkpoint(TRUNCATE)'); } catch {}
  }

  /** The file's size on disk (with its write-ahead log) and when a vector last came. */
  stats() {
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try { bytes += statSync(`${this.path}${suffix}`).size; } catch {}
    }
    const updatedAt = Number(this.meta('updatedAt')) || null;
    return {path: this.path, bytes, updatedAt};
  }

  /** One worktree is done with the file; the last one closes it. */
  release() {
    const entry = opened.get(this.path);
    if (entry && --entry.users > 0) return;
    opened.delete(this.path);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.checkpoint();
    this.db.close();
  }
}

/** Deletes an index file with its write-ahead log; the store must be closed. What was learned stays (see removeLearned). */
export function removeIndex(path) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, {force: true});
}

/** Deletes what was learned beside an index file: the searches kept and the notes. */
export function removeLearned(path) { removeIndex(learnedPath(path)); }
