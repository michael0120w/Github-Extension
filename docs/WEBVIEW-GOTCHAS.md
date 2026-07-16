# Webview gotchas

Things that have broken Branch Explorer's webview in ways that took hours
to diagnose. Read this before editing the inline `<script>` block in
`extension.js`.

---

## The nested-template-literal landmine (v0.5.19 → v0.5.25)

### Symptom

Every button in the panel silently stopped responding. No console error,
no extension host crash, no log line, nothing in the Branch Explorer
output channel. The HTML rendered fine — buttons, branches, badges,
everything was on screen — they just didn't react to clicks.

### Root cause

The entire inline webview script body is itself the contents of an
**outer JS template literal** in `extension.js` (the one that builds the
HTML response in `baseHtml()` / `renderCombinedHtml()`):

```js
return `<!DOCTYPE html>
...
<script nonce="${nonce}">
  // ← THIS ENTIRE BLOCK IS THE CONTENTS OF THE OUTER \` \` TEMPLATE LITERAL
  someFunction('hello\n there');
</script>
...`;
```

So when `extension.js` runs, the JS engine evaluates the outer template
literal. **Backslash escape sequences inside the script body get
processed by the outer template literal, not by the browser.**

What this means in practice:

| In `extension.js` source | What the browser actually receives |
|---|---|
| `'\n'` (newline escape) | `'<actual newline>'` — **unterminated string literal** |
| `'\t'` | `'<actual tab>'` — usually still parses, but broken |
| `'\r'` | `'<actual CR>'` — same |
| `'\\n'` | `'\n'` — **correct, what we want** |
| `'\\\\'` | `'\\'` — correct |
| `` `template` `` | The outer literal closes early at the first backtick |
| `${anything}` | Interpolated by the OUTER literal (almost never what you want) |

Browsers silently drop a `<script>` tag with a parse error. There's no
console message because `window.onerror` is a *runtime* listener that
can only fire if the script tag containing it parsed successfully. A
parse error happens *before* execution, so the listener itself never
gets registered.

### How to detect this before shipping

Run this from the repo root:

```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('extension.js','utf8').split('\n');
let start=-1, end=-1;
for (let i=0;i<lines.length;i++) {
  if (lines[i].startsWith('<script nonce')) start = i+1;
  if (start>0 && lines[i] === '</script>') { end = i; break; }
}
const body = lines.slice(start, end).join('\n');
const rendered = new Function('nonce','return \`' + body.replace(/\\\\/g,'\\\\\\\\').replace(/\`/g,'\\\\\`').replace(/(?<!\\\\)\\\$\{(?!nonce\\})/g,'\\\\\${') + '\`')('TEST');
try { new Function(rendered); console.log('✓ rendered script body parses cleanly'); }
catch (e) { console.error('✗ PARSE ERROR in rendered output:', e.message); process.exit(1); }
"
```

This:
1. Extracts the inline script body from `extension.js`
2. Simulates the outer template literal evaluation
3. Tries to parse the rendered output with V8 (same parser as Chromium)

If it prints `✓ rendered script body parses cleanly`, the script will
load in the browser. If it errors, you have a hidden landmine.

`node --check extension.js` is **NOT** sufficient — it only checks that
`extension.js` itself is syntactically valid JS. It doesn't check what
gets *produced* by the template literals inside `extension.js`.

### The rule

**Inside the `<script nonce="...">` block in `baseHtml()`, escape every
backslash you want to reach the browser:**

- `'\n'` → write `'\\n'`
- `'\t'` → write `'\\t'`
- `'\r'` → write `'\\r'`
- `'\\'` → write `'\\\\'`
- Regex like `/\d/` → write `/\\d/`
- A literal backtick → can't use it; pick a different quote style or use
  `String.fromCharCode(96)`
- A literal `${...}` that should NOT be interpolated by the outer
  literal → write `\${...}`

This rule applies **only** inside the `<script>` block (and any nested
template strings in `${...}` interpolations that produce strings the
script will then evaluate, e.g. data attributes that JS later parses
back). The HTML/CSS outside the script tag is a literal string and
doesn't run anywhere — escapes there are harmless.

### Why this was missed

- `node --check extension.js` passed (and still does — it can't see
  inside the template literal).
- The three offending call sites all looked like ordinary JS:
  - `showReconcileError((msg.error || '').split('\n')[0])` (v0.5.19)
  - `'\n' + e.error.stack` (v0.5.24)
  - `'\n' + reason.stack` (v0.5.24)
- The parse error happens at script-load time, *before* any JS in the
  tag executes, so `window.onerror` and `try/catch` inside the same tag
  can't catch it.
- The webview UI still rendered normally because HTML/CSS parsing is
  independent of the script tag.
- No CSP violation, no network error, no message in any log channel.

### Permanent safety net

`baseHtml()` now embeds a red `<div id="webview-script-status">` banner
in the HTML body **before** the script tag. The script's first action
is to remove that banner. If the banner is ever visible to a user, the
script tag failed to execute — no matter why. It is the only signal
that survives this exact failure mode.

**Do not remove that banner.** It costs effectively nothing on a
healthy load (one DOM node removed in microseconds) and is the only
diagnostic that catches the parse-error-in-inline-script class of bugs.

---

## Other webview things to remember

- **Inline scripts require a CSP nonce.** The current CSP is
  `script-src 'nonce-<value>'`. The same nonce must appear in both the
  `<meta>` CSP and the `<script nonce="...">` attribute.
- **`acquireVsCodeApi()` can only be called once per webview.** If you
  split the script into multiple `<script>` tags, only the first one
  may call it; subsequent tags should read from `window.<something>`
  that the first tag stored there.
- **`webview.cspSource` is the URL prefix** for any external assets you
  add to `localResourceRoots`. Inline content uses the nonce, external
  content uses `cspSource`.
- **The webview reloads its entire HTML on every refresh.** Every state
  collection, every background fetch, every git operation triggers a
  full `webview.html = ...` reassignment. Don't rely on any in-memory
  state surviving across refreshes — push it to the extension host via
  `postMessage` instead.

---

## Adding new diagnostic signals

When debugging silent failures in the webview, prefer signals that
**don't** require JavaScript to execute, in this order:

1. **HTML body content** (e.g. the script-status banner) — works even
   if CSP blocks scripts or the script tag has a parse error.
2. **CSS-only indicators** (e.g. a `:not(.script-ran)` selector that
   shows an element until JS removes the class) — works as long as CSS
   loads.
3. **Inline `<script>` postMessages** — works only if the script tag
   parses and executes.
4. **External `<script src="...">`** — works only if CSP allows the
   origin AND the script downloads AND parses.

Each tier catches strictly more failures than the next. The
script-status banner is tier 1; the `window.onerror` and
`webviewReady` postMessages are tier 3.
