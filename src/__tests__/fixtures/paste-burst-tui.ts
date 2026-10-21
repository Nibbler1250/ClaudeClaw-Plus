/**
 * A stand-in for claude's TUI input box, for #559. It keeps the one behaviour
 * that issue is about, measured on CLI 2.1.296 with a real PTY:
 *
 *   - a burst of 64+ bytes without paste markers is read as a paste, and a CR
 *     inside it is kept as text: nothing is submitted;
 *   - text between bracketed-paste markers (`ESC[200~` … `ESC[201~`) is a
 *     paste of known length, and a CR after the end marker submits it;
 *   - a short burst is typed: a CR submits, Ctrl-U clears the line.
 *
 * Typed and pasted text is echoed, as the input box paints it, so the
 * supervisor's sentinel echo works. A submit paints what claude paints while a
 * turn runs (a running window title and the `esc to interrupt` footer, the
 * turn-start edge #562 requires), then `SUBMITTED<text>`, then the done-summary
 * and idle footer the output parser waits for before it ends the turn.
 */
const PASTE_BURST_BYTES = 64;
const START = "\x1b[200~";
const END = "\x1b[201~";

process.stdin.setRawMode?.(true);
process.stdout.write("\x1b[?2004h> ready\n");

let line = "";
let inPaste = false;

process.stdin.on("data", (buf: Buffer) => {
  let s = buf.toString("utf8");
  if (!inPaste && !s.includes(START) && s.length >= PASTE_BURST_BYTES) {
    line += s.replace(/\r/g, "\n");
    process.stdout.write(s.replace(/\r/g, ""));
    return;
  }
  while (s.length > 0) {
    if (inPaste) {
      const end = s.indexOf(END);
      const part = end < 0 ? s : s.slice(0, end);
      line += part;
      process.stdout.write(part);
      if (end < 0) return;
      inPaste = false;
      s = s.slice(end + END.length);
      continue;
    }
    if (s.startsWith(START)) {
      inPaste = true;
      s = s.slice(START.length);
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    if (ch === "\r") {
      process.stdout.write(
        `\n\x1b]0;◐ Work\x07✻ working… esc to interrupt\nSUBMITTED<${line}>\n✻ Baked for 1s · done 16:36\n> shift+tab to cycle\n`,
      );
      line = "";
    } else if (ch === "\x15") {
      line = "";
    } else {
      line += ch;
      process.stdout.write(ch);
    }
  }
});
