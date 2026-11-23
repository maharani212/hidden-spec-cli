// main.ts is mend, the CLI SPEC.md specifies. It applies an edit an AI model wrote, in four formats
// (unified diff, SEARCH/REPLACE, V4A, JSON), to a tree of text files. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its break, its lines, and whether it ends with a break. */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** New path -> the path it was moved from, for `R` output lines. */
  readonly origin = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** A path's value after the patch (what the tree holds now, or the original). */
  after(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string): void {
    const o = this.origin.get(oldP) ?? oldP;
    this.origin.delete(oldP);
    this.origin.set(newP, o);
  }
  snapshot(): { now: Map<string, string | null>; origin: Map<string, string> } {
    return { now: new Map(this.now), origin: new Map(this.origin) };
  }
  restore(s: { now: Map<string, string | null>; origin: Map<string, string> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.origin.clear();
    for (const [k, v] of s.origin) this.origin.set(k, v);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at tier, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j], tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which O occurs exactly at `pos`, or null. */
function tierAt(lines: string[], pos: number, O: string[], strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (pos + j >= lines.length || normLine(lines[pos + j], t) !== normLine(O[j], t)) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier with one. */
function findAnchor(lines: string[], from: number, anchor: string, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

/** One body line: 'ctx' (context), 'old' (-), 'new' (+). `blank` marks a patch line that was
 *  blank (empty or only whitespace), for the trailing-blank rule of V4A sections. */
interface Op {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  blank?: boolean;
}

/**
 * Build the lines that replace a matched O, from the ops of a hunk/chunk. Context lines are
 * written as the file's own matched lines; other new lines are re-indented at tier 2.
 */
function applyMatch(fileLines: string[], pos: number, ops: Op[], tier: number): string[] {
  const O = ops.filter((o) => o.kind !== 'new').map((o) => o.text);
  const F = leadWS(fileLines[pos] ?? '');
  const P = O.length > 0 ? leadWS(O[0]) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'old') {
      oIdx++;
      continue;
    }
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]);
      oIdx++;
      continue;
    }
    const t = op.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
    else out.push(t);
  }
  return out;
}

/** Re-indent plain new lines (no context lines) against O at tier 2. */
function reindentNew(fileLines: string[], pos: number, O: string[], N: string[], tier: number): string[] {
  if (tier !== 2) return [...N];
  const F = leadWS(fileLines[pos] ?? '');
  const P = O.length > 0 ? leadWS(O[0]) : '';
  return N.map((t) => (t !== '' && t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t));
}

/* ------------------------------------------------------------------ */
/* Section 4: detecting the format.                                    */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (as the starter).                             */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, serializeDoc({ br: doc.br, lines, final: doc.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Old start line number A (1-based). */
  A: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolAfterLastPlus: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDashPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/b stripped. */
function headerPath(line: string): string {
  return stripAB(line.slice(4).split('\t')[0].trim());
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Convert hunk body lines to ops, and work out the `\` (no-newline) flags. */
function bodyToHunk(A: number, bodyLines: string[]): Hunk {
  const ops: Op[] = [];
  for (const b of bodyLines) {
    if (b.startsWith('\\')) continue;
    if (b === '') ops.push({ kind: 'ctx', text: '' });
    else if (b[0] === ' ') ops.push({ kind: 'ctx', text: b.slice(1) });
    else if (b[0] === '-') ops.push({ kind: 'old', text: b.slice(1) });
    else if (b[0] === '+') ops.push({ kind: 'new', text: b.slice(1) });
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let j = 0; j < bodyLines.length; j++) {
    const b = bodyLines[j];
    if (b === '' || b[0] === ' ' || b[0] === '+') lastCtxPlus = j;
    if (b[0] === '+') lastPlus = j;
  }
  const noEolAfterLast = lastCtxPlus >= 0 && lastCtxPlus + 1 < bodyLines.length && bodyLines[lastCtxPlus + 1].startsWith('\\');
  const noEolAfterLastPlus = lastPlus >= 0 && lastPlus + 1 < bodyLines.length && bodyLines[lastPlus + 1].startsWith('\\');
  return { A, ops, noEolAfterLast, noEolAfterLastPlus };
}

function newSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    dashOld: null,
    dashNew: null,
    hasDashPair: false,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasDashPair) {
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]);
        cur.hasDashPair = true;
      } else {
        cur = newSection();
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]);
        cur.hasDashPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1], 10);
      inHeader = false;
      i++;
      const bodyLines: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          bodyLines.push(b);
          i++;
        } else break;
      }
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      cur.hunks.push(bodyToHunk(A, bodyLines));
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply one hunk to a file's lines. Returns the new lines, final break, and length delta. */
function applyHunk(lines: string[], final: boolean, hunk: Hunk, d: number, strict: boolean, path: string): { lines: string[]; final: boolean; delta: number } {
  const ops = hunk.ops;
  const O = ops.filter((o) => o.kind !== 'new').map((o) => o.text);
  if (O.length === 0) {
    const N = ops.filter((o) => o.kind === 'new').map((o) => o.text);
    const at = Math.min(hunk.A + d, lines.length);
    const newLines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
    let newFinal = final;
    if (at === lines.length) newFinal = !hunk.noEolAfterLastPlus;
    return { lines: newLines, final: newFinal, delta: N.length };
  }
  const found = findTier(lines, O, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.A - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const replacement = applyMatch(lines, best, ops, found.tier);
  const newLines = [...lines.slice(0, best), ...replacement, ...lines.slice(best + O.length)];
  let newFinal = final;
  if (best + O.length === lines.length) newFinal = !hunk.noEolAfterLast;
  return { lines: newLines, final: newFinal, delta: replacement.length - O.length };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  let oldRaw: string | null = null;
  let newRaw: string | null = null;
  if (sec.hasDashPair) {
    oldRaw = sec.dashOld;
    newRaw = sec.dashNew;
  } else if (sec.renameFrom !== null || sec.renameTo !== null) {
    oldRaw = sec.renameFrom;
    newRaw = sec.renameTo;
  } else {
    oldRaw = sec.gitOld;
    newRaw = sec.gitNew;
  }
  const oldIsNull = oldRaw === '/dev/null' || oldRaw === null;
  const newIsNull = newRaw === '/dev/null' || newRaw === null;
  const oldP = oldIsNull ? null : oldRaw;
  const newP = newIsNull ? null : newRaw;
  const kind = sec.isCreate || oldIsNull ? 'create' : sec.isDelete || newIsNull ? 'delete' : oldRaw !== newRaw ? 'move' : 'change';
  return (tree) => {
    const named: string[] = [];
    if (oldP !== null) named.push(oldP);
    if (newP !== null && newP !== oldP) named.push(newP);
    for (const p of named) if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'create') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const newLines: string[] = [];
      let lastPlusHunk: Hunk | null = null;
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'new') newLines.push(op.text);
        if (h.ops.some((o) => o.kind === 'new')) lastPlusHunk = h;
      }
      const endsWithBreak = lastPlusHunk === null ? true : !lastPlusHunk.noEolAfterLastPlus;
      tree.now.set(np, newLines.length === 0 ? '' : newLines.join('\n') + (endsWithBreak ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (kind === 'move') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    const doc = parseDoc(before);
    let lines = doc.lines;
    let final = doc.final;
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(lines, final, h, d, strict, op);
      lines = r.lines;
      final = r.final;
      d += r.delta;
    }
    const content = serializeDoc({ br: doc.br, lines, final });
    if (kind === 'move') {
      const np = newP!;
      tree.now.set(op, null);
      tree.now.set(np, content);
      tree.move(op, np);
    } else {
      tree.now.set(op, content);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let blockEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > blockEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE' || lines[j].trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (lines[j].trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      const found = findTier(doc.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0];
      const replacement = reindentNew(doc.lines, pos, oldLines, newLines, found.tier);
      const newDocLines = [...doc.lines.slice(0, pos), ...replacement, ...doc.lines.slice(pos + oldLines.length)];
      tree.now.set(p, serializeDoc({ br: doc.br, lines: newDocLines, final: doc.final }));
    });
    prevPath = path;
    blockEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null: no anchor. */
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

type V4aSection =
  | { kind: 'add'; path: string; fileLines: { text: string; blank: boolean }[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: { text: string; blank: boolean }[] = [];
      i++;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          fileLines.push({ text: l.slice(1), blank: false });
          i++;
        } else if (l === '') {
          fileLines.push({ text: '', blank: true });
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1].blank) fileLines.pop();
      sections.push({ kind: 'add', path, fileLines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, ops: [] };
          chunks.push(cur);
          firstChunk = false;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (firstChunk) {
              cur = { anchor: null, eof: false, ops: [] };
              chunks.push(cur);
              firstChunk = false;
            } else throw new Exit2(`error: parse ${i + 1}`);
          }
          const isBlankLine = blank(l);
          if (l === '') cur.ops.push({ kind: 'ctx', text: '', blank: true });
          else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1), blank: isBlankLine });
          else if (l[0] === '-') cur.ops.push({ kind: 'old', text: l.slice(1) });
          else cur.ops.push({ kind: 'new', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of the section are not part of it: strip trailing blank
      // body lines from the last chunk.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (lastChunk.ops.length > 0 && lastChunk.ops[lastChunk.ops.length - 1].blank) lastChunk.ops.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function applyV4aChunk(lines: string[], cursor: number, chunk: V4aChunk, strict: boolean, path: string): { lines: string[]; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const pos = findAnchor(lines, cur, chunk.anchor, strict);
    if (pos === -1) throw new Fail('no-match', path);
    cur = pos + 1;
  }
  const O = chunk.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
  if (O.length === 0) {
    const N = chunk.ops.filter((o) => o.kind === 'new').map((o) => o.text);
    const at = chunk.eof ? lines.length : cur;
    const newLines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
    return { lines: newLines, cursor: at + N.length };
  }
  if (chunk.eof) {
    const cand = lines.length - O.length;
    if (cand < cur) throw new Fail('no-match', path);
    const tier = tierAt(lines, cand, O, strict);
    if (tier === null) throw new Fail('no-match', path);
    const replacement = applyMatch(lines, cand, chunk.ops, tier);
    const newLines = [...lines.slice(0, cand), ...replacement, ...lines.slice(cand + O.length)];
    return { lines: newLines, cursor: cand + replacement.length };
  }
  const found = findTier(lines, O, strict, cur);
  if (!found) throw new Fail('no-match', path);
  const pos = found.occ[0];
  const replacement = applyMatch(lines, pos, chunk.ops, found.tier);
  const newLines = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + O.length)];
  return { lines: newLines, cursor: pos + replacement.length };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const text = s.fileLines.map((x) => x.text);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text.length === 0 ? '' : text.join('\n') + '\n');
      });
    } else if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = s.path;
      const moveTo = s.moveTo;
      const chunks = s.chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const doc = parseDoc(before);
        let ls = doc.lines;
        let cursor = 0;
        for (const chunk of chunks) {
          const r = applyV4aChunk(ls, cursor, chunk, strict, p);
          ls = r.lines;
          cursor = r.cursor;
        }
        const content = serializeDoc({ br: doc.br, lines: ls, final: doc.final });
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, content);
          tree.move(p, moveTo);
        } else {
          tree.now.set(p, content);
        }
      });
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: invocation, output, order and atomicity.       */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
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
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per changed path, in byte order; a move prints `R old -> new` and sorts by new.
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const moveRows = new Map<string, string>();
  const moveOlds = new Set<string>();
  for (const p of changed) {
    const now = tree.now.get(p)!;
    const was = tree.original(p);
    if (now === null || was !== null) continue;
    const o = tree.origin.get(p);
    if (o === undefined) continue;
    if (tree.original(o) === null) continue;
    if (tree.after(o) !== null) continue;
    moveRows.set(p, o);
    moveOlds.add(o);
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of changed) {
    if (moveRows.has(p)) {
      rows.push({ key: p, line: `R ${moveRows.get(p)} -> ${p}` });
    } else if (moveOlds.has(p)) {
      continue;
    } else {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
