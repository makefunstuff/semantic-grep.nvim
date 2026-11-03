// Line-delimited JSON on a stream: the backend's stdio, and the headless Neovim that finds pieces with tree-sitter.
import {createInterface} from 'node:readline';

/** Calls `onMessage` with each line of `stream` that is JSON; other lines are skipped. */
export function readLines(stream, onMessage) {
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  lines.on('error', () => {}); // the stream's owner handles its errors
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    onMessage(message);
  });
  return lines;
}

/** Writes `message` as one line, if the stream is still open. */
export function writeLine(stream, message) {
  if (!stream.destroyed && stream.writable) stream.write(`${JSON.stringify(message)}\n`);
}
