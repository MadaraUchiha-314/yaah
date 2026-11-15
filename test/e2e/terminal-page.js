/**
 * Runs in the browser page of the terminal tests: replays raw terminal output into
 * xterm.js (a page global) and returns the screen as text. Plain JavaScript, outside the
 * type-aware lint: it has no types to check — everything it touches is a page global.
 */
globalThis.renderTerminal = async (data, columns, rows) => {
  const host = document.querySelector('#terminal');
  host.replaceChildren();
  const terminal = new globalThis.Terminal({
    cols: columns,
    rows,
    fontSize: 14,
    theme: { background: '#0b0b0c' },
  });
  terminal.open(host);
  await new Promise((resolve) => {
    terminal.write(data, resolve);
  });
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
};
