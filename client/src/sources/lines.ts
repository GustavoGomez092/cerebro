import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export const MAX_READ_BYTES = 16 * 1024 * 1024;

export interface CompleteLines {
  lines: { lineNo: number; text: string }[];
  nextOffset: number;
  nextLine: number;
}

/**
 * Reads newline-terminated lines starting at byte `fromOffset` (line numbers start at `fromLine`).
 * A trailing partial line is left for the next call: offsets only advance past a `\n`.
 * Reads about 16 MB per call (a single longer line is read whole so the cursor never stalls).
 * Never throws; an unreadable file yields no lines and an unchanged cursor.
 */
export function readCompleteLines(path: string, fromOffset: number, fromLine: number): CompleteLines {
  const none: CompleteLines = { lines: [], nextOffset: fromOffset, nextLine: fromLine };
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (fromOffset >= size) return none;
    fd = openSync(path, "r");
    let buf = Buffer.alloc(Math.min(MAX_READ_BYTES, size - fromOffset));
    let got = readFully(fd, buf, fromOffset);
    // No newline in a full chunk: keep reading until one shows up (or EOF) so the line is not stuck forever.
    while (buf.subarray(0, got).indexOf(10) < 0 && fromOffset + got < size) {
      const more = Buffer.alloc(Math.min(MAX_READ_BYTES, size - fromOffset - got));
      const n = readFully(fd, more, fromOffset + got);
      if (n === 0) break;
      buf = Buffer.concat([buf.subarray(0, got), more.subarray(0, n)]);
      got += n;
    }
    const lines: { lineNo: number; text: string }[] = [];
    let start = 0;
    let lineNo = fromLine;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl < 0 || nl >= got) break;
      let end = nl;
      if (end > start && buf[end - 1] === 13) end--;
      lines.push({ lineNo, text: buf.toString("utf8", start, end) });
      lineNo++;
      start = nl + 1;
    }
    return { lines, nextOffset: fromOffset + start, nextLine: lineNo };
  } catch {
    return none;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

const HEAD_CHUNK = 16 * 1024;
const HEAD_MAX = MAX_READ_BYTES;

/**
 * The first `count` complete lines of a file (fewer when the file has fewer), for reading a header cheaply.
 * Reads in growing chunks, so a short header costs one small read and a long one (up to 16 MB) is still found.
 * Never throws.
 */
export function headLines(path: string, count = 1): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    let buf = Buffer.alloc(0);
    let chunk = HEAD_CHUNK;
    for (;;) {
      const more = Buffer.alloc(Math.min(chunk, size - buf.length, HEAD_MAX - buf.length));
      const n = more.length ? readFully(fd, more, buf.length) : 0;
      buf = Buffer.concat([buf, more.subarray(0, n)]);
      let lines = 0;
      for (let i = buf.indexOf(10); i >= 0 && lines < count; i = buf.indexOf(10, i + 1)) lines++;
      if (lines >= count || n === 0 || buf.length >= size || buf.length >= HEAD_MAX) break;
      chunk *= 2;
    }
    const end = buf.lastIndexOf(10);
    if (end < 0) return [];
    return buf.toString("utf8", 0, end).split("\n").slice(0, count).map((l) => l.replace(/\r$/, ""));
  } catch {
    return [];
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function readFully(fd: number, buf: Buffer, position: number): number {
  let total = 0;
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, position + total);
    if (n === 0) break;
    total += n;
  }
  return total;
}
