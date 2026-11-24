// mend: one patch tool for every AI edit format.
//
// SPEC.md (version 1) is the contract: four patch formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON edits), three-tier line matching
// with exact, trailing-whitespace and re-indented tiers, and all-or-nothing
// writes with exact stdout and exit codes. A file moved by a move edit
// prints one R line instead of its D and A lines.
//
// Node 22, standard library only. Run it as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to finish with exit 2 and a single `error: ...` line. */
class Bail {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to report that it failed; the tree rolls that edit back. */
class Fault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's text as the tool sees it: its line break, its lines, and whether it ends with a break. */
interface FileDoc {
  brk: string;
  lines: string[];
  tail: boolean;
}

function readDoc(text: string): FileDoc {
  if (text === '') return { brk: '\n', lines: [], tail: false };
  const firstNl = text.indexOf('\n');
  const brk = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const tail = text.endsWith(brk);
  if (tail) parts.pop();
  return { brk, lines: parts, tail };
}

function writeDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.brk) + (doc.tail ? doc.brk : '');
}

/** The tree as the edits leave it. `cur` holds paths an edit touched (null: deleted); the rest read from disk. `moves` records every successful move edit's [old, new] pair, for the R lines. */
class WorkTree {
  private readonly seen = new Map<string, string | null>();
  readonly cur = new Map<string, string | null>();
  readonly moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  /** The text at p as the edits left it, or its disk text when untouched. */
  at(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.original(p);
  }

  /** Record a move that succeeded: the old path is gone, the new path holds `text`. */
  relocate(from: string, to: string, text: string): void {
    this.cur.set(from, null);
    this.cur.set(to, text);
    this.moves.push([from, to]);
  }
}

type Edit = (tree: WorkTree) => void;

const trailOf = (s: string): string => s.replace(/[ \t]+$/, '');
const bothOf = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Do two lines match at the given tier (0 exact, 1 trailing whitespace ignored, 2 both ends ignored)? */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailOf(a) === trailOf(b);
  return bothOf(a) === bothOf(b);
}

/** Positions >= `from` where `old` matches `lines` at `tier`; when `endOnly`, only positions ending at the last line. */
function findSpots(lines: string[], old: string[], tier: number, from: number, endOnly: boolean): number[] {
  const spots: number[] = [];
  const last = lines.length - old.length;
  for (let i = Math.max(from, 0); i <= last; i += 1) {
    if (endOnly && i + old.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

/** The first tier at which `old` occurs at or after `from` (only tier 0 when strict), with its positions. */
function firstTier(lines: string[], old: string[], strict: boolean, from: number, endOnly: boolean): { tier: number; spots: number[] } | null {
  if (old.length === 0) return null;
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier += 1) {
    const spots = findSpots(lines, old, tier, from, endOnly);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** One body line of a hunk or chunk. A context line carries its index in O; `slash` says a `\` line follows it at once. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  at: number;
  slash: boolean;
}

/**
 * Turn raw body items (lines starting with ' ', '-', '+', '\', or empty) into
 * ops and O (the context and deleted lines). A `\` line marks the body line
 * before it; an empty item is a context line with empty text.
 */
function parseBody(items: string[]): { ops: BodyLine[]; old: string[] } {
  const ops: BodyLine[] = [];
  const old: string[] = [];
  let prev = -1;
  for (const raw of items) {
    if (raw.startsWith('\\')) {
      if (prev >= 0) ops[prev]!.slash = true;
      prev = -1;
      continue;
    }
    const kind = raw === '' || raw.startsWith(' ') ? 'ctx' : raw.startsWith('-') ? 'del' : 'add';
    const text = raw === '' ? '' : raw.slice(1);
    const op: BodyLine = { kind, text, at: -1, slash: false };
    if (kind === 'ctx') {
      op.at = old.length;
      old.push(text);
    } else if (kind === 'del') {
      old.push(text);
    }
    ops.push(op);
    prev = ops.length - 1;
  }
  return { ops, old };
}

/** Whether a `\` line follows the last context or `+` line of these ops. */
function endsBare(ops: BodyLine[]): boolean {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i]!;
    if (op.kind === 'ctx' || op.kind === 'add') return op.slash;
  }
  return false;
}

/**
 * The lines N writes for a match at `pos`: context lines come from the file
 * itself, added lines are re-indented at tier 2 (the patch's leading
 * whitespace on O's first line is swapped for the file's).
 */
function renderNew(fileLines: string[], pos: number, old: string[], ops: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 ? leadOf(fileLines[pos]!) : '';
  const p = tier === 2 && old.length > 0 ? leadOf(old[0]!) : '';
  for (const op of ops) {
    if (op.kind === 'ctx') out.push(fileLines[pos + op.at]!);
    else if (op.kind === 'add') {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/* ---- section 6: unified diffs ---- */

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;

interface Hunk {
  start: number;
  ops: BodyLine[];
  old: string[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNew: boolean;
  isGone: boolean;
  hunks: Hunk[];
}

function blankSection(): Section {
  return { pairOld: null, pairNew: null, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, isNew: false, isGone: false, hunks: [] };
}

/** A leading a/ or b/ comes off either path a ---, +++ or diff --git line names. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a --- or +++ line names: text after the four characters, up to the first tab, spaces trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** A named path, or null when it means no file (/dev/null). `prefixed` says an a/ or b/ may lead it. */
function namedPath(raw: string | null, prefixed: boolean): string | null {
  if (raw === null) return null;
  const p = prefixed ? stripAB(raw) : raw;
  return p === '/dev/null' ? null : p;
}

/**
 * Apply one section's hunks in order to a file's lines. `d` tracks how much
 * earlier hunks grew or shrank the file, so the next hunk's line number
 * still lands near its match. Returns the new lines and final-break flag.
 */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = doc.lines.slice();
  let tail = doc.tail;
  let d = 0;
  for (const h of hunks) {
    if (h.old.length === 0) {
      const at = Math.max(0, Math.min(h.start + d, lines.length));
      const added = renderNew(lines, at, [], h.ops, 0);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...added);
      if (atEnd) tail = !endsBare(h.ops);
      d += added.length;
      continue;
    }
    const found = firstTier(lines, h.old, strict, 0, false);
    if (found === null) throw new Fault('no-match', path);
    const target = h.start - 1 + d;
    let best = found.spots[0]!;
    let bestDist = Math.abs(best - target);
    for (const s of found.spots) {
      const dist = Math.abs(s - target);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }
    const made = renderNew(lines, best, h.old, h.ops, found.tier);
    const toEnd = best + h.old.length === lines.length;
    lines.splice(best, h.old.length, ...made);
    if (toEnd) tail = !endsBare(h.ops);
    d += made.length - h.old.length;
  }
  return { brk: doc.brk, lines, tail };
}

/** The text a creation holds: the + lines of all its hunks, LF breaks, a final one unless a \ line follows its last + line. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let bare = false;
  for (const h of hunks) {
    for (const op of h.ops) {
      if (op.kind === 'add') {
        plus.push(op.text);
        bare = op.slash;
      }
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (bare ? '' : '\n');
}

/** One section's edit: creation, deletion, move, or change of one path. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldRaw = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newRaw = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const oldPath = namedPath(oldRaw, sec.pairOld !== null);
  const newPath = namedPath(newRaw, sec.pairNew !== null);
  const isCreate = oldPath === null || sec.isNew;
  const isDelete = newPath === null || sec.isGone;
  return (tree) => {
    if (isCreate) {
      if (newPath === null) return;
      if (!isSafe(newPath)) throw new Fault('unsafe', newPath);
      if (tree.at(newPath) !== null) throw new Fault('exists', newPath);
      tree.cur.set(newPath, creationText(sec.hunks));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (!isSafe(oldPath)) throw new Fault('unsafe', oldPath);
      if (tree.at(oldPath) === null) throw new Fault('missing', oldPath);
      tree.cur.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!isSafe(oldPath!)) throw new Fault('unsafe', oldPath!);
      if (!isSafe(newPath!)) throw new Fault('unsafe', newPath!);
      const text = tree.at(oldPath!);
      if (text === null) throw new Fault('missing', oldPath!);
      if (tree.at(newPath!) !== null) throw new Fault('exists', newPath!);
      const done = applyHunks(readDoc(text), sec.hunks, strict, oldPath!);
      tree.relocate(oldPath!, newPath!, writeDoc(done));
      return;
    }
    if (!isSafe(oldPath!)) throw new Fault('unsafe', oldPath!);
    const text = tree.at(oldPath!);
    if (text === null) throw new Fault('missing', oldPath!);
    const done = applyHunks(readDoc(text), sec.hunks, strict, oldPath!);
    tree.cur.set(oldPath!, writeDoc(done));
  };
}

/** Read a unified patch into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null || cur === null) throw new Bail(`error: parse ${i + 1}`);
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          items.push(b);
          j += 1;
          continue;
        }
        break;
      }
      while (items.length > 0 && items[items.length - 1] === '') items.pop();
      const parsed = parseBody(items);
      cur.hunks.push({ start: Number(m[1]), ops: parsed.ops, old: parsed.old });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) throw new Bail(`error: parse ${i + 2}`);
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(next);
      i += 2;
      continue;
    }
    if ((cur === null || !inHeader) && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = blankSection();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isGone = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

const SEARCH_MARK = '<<<<<<< SEARCH';
const SPLIT_MARK = '=======';
const END_MARK = '>>>>>>> REPLACE';

/** A line is one of the three block markers when its trailing whitespace is removed. */
const isMark = (line: string, mark: string): boolean => line.trimEnd() === mark;

/** Read SEARCH/REPLACE blocks into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isMark(lines[i]!, SEARCH_MARK)) {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (isMark(lines[j]!, SPLIT_MARK)) {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Bail(`error: parse ${searchAt + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (isMark(lines[j]!, END_MARK)) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Bail(`error: parse ${searchAt + 1}`);
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand) || cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Bail(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(searchEdit(path, oldLines, newLines, strict));
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

function searchEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new Fault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.at(path) !== null) throw new Fault('exists', path);
      tree.cur.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.at(path);
    if (text === null) throw new Fault('missing', path);
    const doc = readDoc(text);
    const found = firstTier(doc.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fault('no-match', path);
    if (found.spots.length > 1) throw new Fault('ambiguous', path);
    const at = found.spots[0]!;
    const made = renderNew(doc.lines, at, oldLines, newLines.map((t) => ({ kind: 'add' as const, text: t, at: -1, slash: false })), found.tier);
    const lines = doc.lines.slice();
    lines.splice(at, oldLines.length, ...made);
    tree.cur.set(path, writeDoc({ brk: doc.brk, lines, tail: doc.tail }));
  };
}

/* ---- section 8: V4A patches ---- */

const ADD_HEAD = '*** Add File: ';
const DEL_HEAD = '*** Delete File: ';
const UPD_HEAD = '*** Update File: ';
const MOVE_HEAD = '*** Move to: ';
const END_FILE = '*** End of File';

interface Chunk {
  anchor: string | null;
  eof: boolean;
  ops: BodyLine[];
  old: string[];
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: Chunk[];
}

/** Read a V4A patch into one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Bail(`error: parse ${first + 1}`);
  const last = lines.map((l, k) => (isBlank(l) ? -1 : k)).reduce((a, b) => Math.max(a, b), -1);
  if (lines[last]!.trim() !== '*** End Patch') throw new Bail(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = lines[i]!;
    let kind: V4aSection['kind'] | null = null;
    let prefix = '';
    if (head.startsWith(ADD_HEAD)) {
      kind = 'add';
      prefix = ADD_HEAD;
    } else if (head.startsWith(DEL_HEAD)) {
      kind = 'del';
      prefix = DEL_HEAD;
    } else if (head.startsWith(UPD_HEAD)) {
      kind = 'upd';
      prefix = UPD_HEAD;
    } else {
      throw new Bail(`error: parse ${i + 1}`);
    }
    const path = head.slice(prefix.length).trim();
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith(ADD_HEAD) || l.startsWith(DEL_HEAD) || l.startsWith(UPD_HEAD)) break;
      raw.push(l);
      j += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    edits.push(buildV4a(kind, path, raw, i + 1, strict));
    i = j;
  }
  return edits;
}

function buildV4a(kind: V4aSection['kind'], path: string, raw: string[], headLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const made: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') made.push('');
      else if (l.startsWith('+')) made.push(l.slice(1));
      else throw new Bail(`error: parse ${headLine + 1 + k}`);
    }
    return (tree) => {
      if (!isSafe(path)) throw new Fault('unsafe', path);
      if (tree.at(path) !== null) throw new Fault('exists', path);
      tree.cur.set(path, made.length === 0 ? '' : `${made.join('\n')}\n`);
    };
  }
  if (kind === 'del') {
    if (raw.length > 0) throw new Bail(`error: parse ${headLine + 1}`);
    return (tree) => {
      if (!isSafe(path)) throw new Fault('unsafe', path);
      if (tree.at(path) === null) throw new Fault('missing', path);
      tree.cur.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let at = 0;
  if (raw.length > 0 && raw[0]!.startsWith(MOVE_HEAD)) {
    moveTo = raw[0]!.slice(MOVE_HEAD.length).trim();
    at = 1;
  }
  const chunks: Chunk[] = [];
  let open: { anchor: string | null; eof: boolean; items: string[] } | null = null;
  const closeChunk = (): void => {
    if (open === null) return;
    const parsed = parseBody(open.items);
    chunks.push({ anchor: open.anchor, eof: open.eof, ops: parsed.ops, old: parsed.old });
    open = null;
  };
  let firstChunk = true;
  while (at < raw.length) {
    const l = raw[at]!;
    const lineNo = headLine + 1 + at;
    if (l.startsWith('@@')) {
      closeChunk();
      open = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, items: [] };
      firstChunk = false;
      at += 1;
      continue;
    }
    if (l === END_FILE) {
      if (open === null) throw new Bail(`error: parse ${lineNo}`);
      open.eof = true;
      closeChunk();
      firstChunk = false;
      at += 1;
      while (at < raw.length && isBlank(raw[at]!)) at += 1;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (open === null) {
        if (!firstChunk) throw new Bail(`error: parse ${lineNo}`);
        open = { anchor: null, eof: false, items: [] };
        firstChunk = false;
      }
      open.items.push(l);
      at += 1;
      continue;
    }
    throw new Bail(`error: parse ${lineNo}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Bail(`error: parse ${headLine}`);
  return (tree) => {
    if (!isSafe(path)) throw new Fault('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new Fault('unsafe', moveTo);
    const text = tree.at(path);
    if (text === null) throw new Fault('missing', path);
    if (moveTo !== null && tree.at(moveTo) !== null) throw new Fault('exists', moveTo);
    const doc = readDoc(text);
    let lines = doc.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const hit = firstTier(lines, [ch.anchor], strict, cursor, false);
        if (hit === null) throw new Fault('no-match', path);
        cursor = hit.spots[0]! + 1;
      }
      if (ch.old.length === 0) {
        const atPos = ch.eof ? lines.length : cursor;
        const made = renderNew(lines, atPos, [], ch.ops, 0);
        lines.splice(atPos, 0, ...made);
        cursor = atPos + made.length;
        continue;
      }
      const found = firstTier(lines, ch.old, strict, cursor, ch.eof);
      if (found === null) throw new Fault('no-match', path);
      const atPos = found.spots[0]!;
      const made = renderNew(lines, atPos, ch.old, ch.ops, found.tier);
      lines.splice(atPos, ch.old.length, ...made);
      cursor = atPos + made.length;
    }
    const out = writeDoc({ brk: doc.brk, lines, tail: doc.tail });
    if (moveTo !== null) tree.relocate(path, moveTo, out);
    else tree.cur.set(path, out);
  };
}

/* ---- section 9: JSON edits ---- */

/** One JSON edit object, or null when it is not one. */
function readJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: WorkTree): string => {
    if (!isSafe(p)) throw new Fault('unsafe', p);
    const t = tree.at(p);
    if (t === null) throw new Fault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fault('unsafe', p);
      if (tree.at(p) !== null) throw new Fault('exists', p);
      tree.cur.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const fold = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = fold(before);
      const old = fold(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fault('no-match', p);
      if (count > 1) throw new Fault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + fold(newStr) + t.slice(at + old.length);
      tree.cur.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const brk = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(brk);
      const tail = before !== '' && before.endsWith(brk);
      if (tail) lines.pop();
      if (lineNo < 0 || lineNo > lines.length) throw new Fault('no-match', p);
      lines.splice(lineNo, 0, ...add);
      tree.cur.set(p, lines.length === 0 ? '' : lines.join(brk) + (tail ? brk : ''));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Bail('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Bail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Bail(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = readJsonEdit(x);
      if (e === null) throw new Bail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = readJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Bail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- section 4: detecting the format ---- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === SEARCH_MARK)) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- sections 1, 2 and 10: invocation, output, order and atomicity ---- */

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Bail('error: parse 1');
  } catch (e) {
    if (e instanceof Bail) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: Fault[] = [];
  for (const edit of edits) {
    const beforeCur = new Map(tree.cur);
    const beforeMoves: [string, string][] = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fault)) throw e;
      tree.cur.clear();
      for (const [k, v] of beforeCur) tree.cur.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalOf = (p: string): string | null => (tree.cur.has(p) ? tree.cur.get(p)! : tree.original(p));
  const rows: { key: string; line: string }[] = [];
  const hiddenA = new Set<string>();
  const hiddenD = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (hiddenA.has(to) || hiddenD.has(from)) continue;
    if (tree.original(from) !== null && finalOf(from) === null && tree.original(to) === null && finalOf(to) !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      hiddenA.add(to);
      hiddenD.add(from);
    }
  }
  for (const p of [...tree.cur.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.cur.get(p)!;
    if (was === now) continue;
    if (now === null && hiddenD.has(p)) continue;
    if (was === null && hiddenA.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.cur.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.cur.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.cur.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.cur.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
