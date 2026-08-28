// Renders project Markdown documentation to print-ready PDF.
//
// Pipeline: markdown-it -> styled HTML shell -> headless Chromium (the same
// Playwright install scripts/capture-ui.mjs already uses) -> page.pdf().
// ```mermaid fences are rendered client-side by the real mermaid bundle, so
// the diagrams in the PDF are the same ones GitHub renders from the .md.
//
// Mermaid is loaded as an ES module over a local static server rooted at the
// repo, rather than injected inline: the bundle dynamic-imports its per-diagram
// chunks, and those only resolve relative to a real script URL.
//
// Usage:
//   node scripts/build-docs-pdf.mjs                 # every document below
//   node scripts/build-docs-pdf.mjs docs/USAGE_GUIDE_EN.md
import { chromium } from "playwright";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "pdf");
const BUILD_DIR = path.join(REPO_ROOT, "docs", ".pdf-build");

/** The documents this script knows how to build. */
const DOCUMENTS = [
  {
    source: "docs/USAGE_GUIDE_EN.md",
    output: "Rudrayani-CRM-User-Guide.pdf",
    title: "Rudrayani CRM — Complete Usage Guide",
    subtitle: "End-to-end guide with a journey for every role",
  },
  {
    source: "docs/TECHNICAL_DOCUMENTATION.md",
    output: "Rudrayani-CRM-Technical-Documentation.pdf",
    title: "Rudrayani CRM — Technical Documentation",
    subtitle: "Architecture, data model, and the complete decision register",
  },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * GitHub-compatible heading slugs. The documents hand-write their tables of
 * contents against GitHub's scheme (`## 3. The five roles` -> `#3-the-five-roles`),
 * so markdown-it's default slugify would silently break every internal link.
 */
function slugify(str) {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function renderMarkdown(markdown) {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

  // Hand mermaid blocks through untouched for the browser to render; everything
  // else falls back to markdown-it's normal fenced-code rendering.
  const defaultFence = md.renderer.rules.fence.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === "mermaid") {
      return `<div class="diagram"><pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre></div>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  md.use(anchor, { slugify, tabIndex: false });
  return md.render(markdown);
}

function shell({ title, subtitle, bodyHtml, commit, builtOn }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }

  :root {
    --ink: #16202b;
    --muted: #5a6b7d;
    --rule: #d3dce6;
    --brand: #1f4e79;
    --brand-soft: #eef4fb;
    --code-bg: #f4f6f8;
  }

  * { box-sizing: border-box; }

  body {
    font-family: "Segoe UI", Inter, -apple-system, system-ui, sans-serif;
    font-size: 10.2pt;
    line-height: 1.55;
    color: var(--ink);
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ---- Cover ------------------------------------------------------- */
  .cover {
    height: 244mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    page-break-after: always;
    border-top: 6px solid var(--brand);
    padding-top: 24mm;
  }
  .cover .eyebrow {
    font-size: 10pt; letter-spacing: .18em; text-transform: uppercase;
    color: var(--brand); font-weight: 700; margin-bottom: 10mm;
  }
  .cover h1 {
    font-size: 30pt; line-height: 1.15; margin: 0 0 6mm;
    color: var(--brand); border: 0; padding: 0;
  }
  .cover .subtitle { font-size: 13pt; color: var(--muted); margin-bottom: 22mm; }
  .cover dl {
    display: grid; grid-template-columns: 34mm 1fr; gap: 2.5mm 6mm;
    font-size: 9.5pt; margin: 0; padding-top: 8mm; border-top: 1px solid var(--rule);
  }
  .cover dt { color: var(--muted); }
  .cover dd { margin: 0; font-weight: 600; }

  /* ---- Headings ---------------------------------------------------- */
  h1, h2, h3, h4 { color: var(--brand); line-height: 1.25; break-after: avoid; }
  h1 {
    font-size: 20pt; margin: 0 0 6mm; padding-bottom: 3mm;
    border-bottom: 2px solid var(--brand); break-before: page;
  }
  h2 { font-size: 14.5pt; margin: 9mm 0 3mm; }
  h3 { font-size: 11.8pt; margin: 6mm 0 2mm; }
  h4 { font-size: 10.5pt; margin: 5mm 0 2mm; color: var(--ink); }

  p { margin: 0 0 3mm; orphans: 2; widows: 2; }
  a { color: var(--brand); text-decoration: none; }
  strong { font-weight: 650; }

  ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
  li { margin-bottom: 1.2mm; }
  li > ul, li > ol { margin-top: 1.2mm; }

  /* ---- Tables ------------------------------------------------------ */
  .table-wrap { break-inside: avoid; margin: 0 0 4mm; }
  table {
    width: 100%; border-collapse: collapse; font-size: 8.8pt;
  }
  th, td {
    border: 1px solid var(--rule); padding: 1.8mm 2.4mm;
    text-align: left; vertical-align: top;
  }
  th { background: var(--brand-soft); color: var(--brand); font-weight: 650; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  td code { font-size: 8pt; }

  /* ---- Code -------------------------------------------------------- */
  code {
    font-family: "Cascadia Mono", Consolas, "SF Mono", monospace;
    font-size: 8.8pt; background: var(--code-bg);
    padding: 0.3mm 1.2mm; border-radius: 2px;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--rule); border-radius: 3px;
    padding: 3mm; overflow: hidden; white-space: pre-wrap; word-wrap: break-word;
    font-size: 8.6pt; break-inside: avoid; margin: 0 0 4mm;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  /* ---- Blockquotes / callouts -------------------------------------- */
  blockquote {
    margin: 0 0 4mm; padding: 3mm 4mm; border-left: 3px solid var(--brand);
    background: var(--brand-soft); break-inside: avoid;
  }
  blockquote > :last-child { margin-bottom: 0; }
  blockquote h3 { margin-top: 0; }

  hr { border: 0; border-top: 1px solid var(--rule); margin: 7mm 0; }

  /* ---- Diagrams ---------------------------------------------------- */
  .diagram {
    break-inside: avoid; page-break-inside: avoid;
    margin: 4mm 0 6mm; text-align: center;
  }
  .diagram svg {
    max-width: 100% !important; height: auto !important;
    /* A tall diagram must shrink to fit the printable column rather than
       spill onto a page it cannot be split across. Kept close to the full
       printable height (259mm) so a big diagram gets a page of its own
       instead of being shrunk harder than it needs to be. */
    max-height: 240mm;
  }
  pre.mermaid { background: none; border: 0; padding: 0; }
</style>
</head>
<body>
  <section class="cover">
    <div class="eyebrow">Rudrayani Fintech</div>
    <h1>${title}</h1>
    <div class="subtitle">${subtitle}</div>
    <dl>
      <dt>Document</dt><dd>${title}</dd>
      <dt>Generated</dt><dd>${builtOn}</dd>
      <dt>Source commit</dt><dd>${commit}</dd>
      <dt>Status</dt><dd>Internal documentation</dd>
    </dl>
  </section>
  <main>${bodyHtml}</main>

  <script type="module">
    import mermaid from "/node_modules/mermaid/dist/mermaid.esm.min.mjs";
    window.__mermaidErrors = [];
    window.addEventListener("error", (e) => window.__mermaidErrors.push(String(e.message)));
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      securityLevel: "loose",
      fontFamily: '"Segoe UI", Inter, system-ui, sans-serif',
      themeVariables: {
        primaryColor: "#eef4fb",
        primaryTextColor: "#16202b",
        primaryBorderColor: "#5b9bd5",
        lineColor: "#5a6b7d",
        secondaryColor: "#f4f6f8",
        tertiaryColor: "#ffffff",
        /* Deliberately larger than the on-screen default: a dense diagram
           gets scaled down to fit the page, so the base size has to carry
           enough headroom for the label text to survive that. */
        fontSize: "19px",
      },
      flowchart: { htmlLabels: true, useMaxWidth: true },
      sequence: { useMaxWidth: true, wrap: true },
      er: { useMaxWidth: true },
      timeline: { useMaxWidth: true },
    });
    try {
      await mermaid.run({ querySelector: "pre.mermaid" });
      window.__mermaidDone = true;
    } catch (err) {
      window.__mermaidErrors.push(String(err && err.message ? err.message : err));
      window.__mermaidDone = true;
    }
  </script>
</body>
</html>`;
}

/** Static file server rooted at the repo, so mermaid's chunked ESM resolves. */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(REPO_ROOT, rel);
      if (!filePath.startsWith(REPO_ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function footerTemplate(title) {
  return `<div style="width:100%;font-size:7.5pt;color:#5a6b7d;font-family:'Segoe UI',sans-serif;
      padding:0 16mm;display:flex;justify-content:space-between;border-top:1px solid #d3dce6;padding-top:2mm;">
      <span>${title}</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`;
}

async function build(doc, page, port) {
  const sourcePath = path.join(REPO_ROOT, doc.source);
  const markdown = await readFile(sourcePath, "utf8");

  const html = shell({
    title: doc.title,
    subtitle: doc.subtitle,
    bodyHtml: renderMarkdown(markdown),
    commit: gitCommit(),
    builtOn: new Date().toISOString().slice(0, 10),
  });

  const buildFile = path.join(BUILD_DIR, `${path.basename(doc.output, ".pdf")}.html`);
  await writeFile(buildFile, html, "utf8");

  const url = `http://127.0.0.1:${port}/docs/.pdf-build/${path.basename(buildFile)}`;
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mermaidDone === true, null, { timeout: 120_000 });

  // Wrap tables after render so `break-inside: avoid` applies to the whole
  // table rather than each row; markdown-it emits bare <table> elements.
  await page.evaluate(() => {
    document.querySelectorAll("main table").forEach((t) => {
      if (t.parentElement?.classList.contains("table-wrap")) return;
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });
  });

  const errors = await page.evaluate(() => window.__mermaidErrors ?? []);
  const rendered = await page.evaluate(
    () => document.querySelectorAll("pre.mermaid svg, .diagram svg").length,
  );
  const expected = (markdown.match(/^```mermaid\s*$/gm) ?? []).length;
  const broken = await page.evaluate(
    () => document.querySelectorAll(".diagram .error-icon, .diagram .error-text").length,
  );

  if (errors.length) throw new Error(`Mermaid reported errors:\n  - ${errors.join("\n  - ")}`);
  if (rendered !== expected) {
    throw new Error(`Expected ${expected} rendered diagrams, found ${rendered}.`);
  }
  if (broken > 0) throw new Error(`${broken} diagram(s) rendered as a mermaid error graphic.`);

  // What makes a diagram illegible in print is the shrink factor it ends up
  // being drawn at, not its aspect ratio: a tall-but-narrow diagram survives
  // fitting to page height, while a wide one of the same ratio does not.
  // Measure the actual scale the page box forces and warn below ~0.55x.
  const SCALE_FLOOR = 0.4;
  const cramped = await page.evaluate(
    ({ boxW, boxH, floor }) => {
      const out = [];
      document.querySelectorAll(".diagram").forEach((wrap, i) => {
        const svg = wrap.querySelector("svg");
        if (!svg) return;
        const box = svg.getBBox?.();
        const w = box?.width || svg.clientWidth;
        const h = box?.height || svg.clientHeight;
        if (!w || !h) return;
        const scale = Math.min(1, boxW / w, boxH / h);
        if (scale >= floor) return;
        // The nearest preceding heading identifies the diagram far better
        // than an ordinal does when you go to fix it.
        let node = wrap.previousElementSibling;
        while (node && !/^H[1-4]$/.test(node.tagName)) node = node.previousElementSibling;
        out.push({
          index: i + 1,
          scale: +scale.toFixed(2),
          where: node ? node.textContent.trim().slice(0, 46) : "(no preceding heading)",
        });
      });
      return out;
    },
    // Printable column at 96dpi: 178mm wide, and the 240mm `max-height` cap.
    // The floor is calibrated against the 19px diagram base font above:
    // 0.4x still lands label text around 7.5px, which reads in print.
    { boxW: 673, boxH: 907, floor: SCALE_FLOOR },
  );
  if (cramped.length) {
    console.log(`\n  warning: diagrams shrunk below ${SCALE_FLOOR}x to fit the page —`);
    for (const d of cramped) console.log(`    #${d.index} at ${d.scale}x  under "${d.where}"`);
    console.log("    Rebalance the shape (TD vs LR, subgraphs) or split the diagram.");
    process.stdout.write("  ...continuing ");
  }

  const outPath = path.join(OUT_DIR, doc.output);
  await page.pdf({
    path: outPath,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: footerTemplate(doc.title),
    margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
  });

  return { outPath, diagrams: rendered };
}

async function main() {
  const requested = process.argv.slice(2);
  const docs = requested.length
    ? DOCUMENTS.filter((d) => requested.some((r) => d.source.endsWith(r.replace(/\\/g, "/"))))
    : DOCUMENTS;

  if (!docs.length) {
    console.error(`No known document matches: ${requested.join(", ")}`);
    console.error(`Known documents:\n${DOCUMENTS.map((d) => `  ${d.source}`).join("\n")}`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(BUILD_DIR, { recursive: true });

  const { server, port } = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  let failed = false;
  try {
    for (const doc of docs) {
      process.stdout.write(`Building ${doc.output} ... `);
      try {
        const { outPath, diagrams } = await build(doc, page, port);
        console.log(`ok (${diagrams} diagrams) -> ${path.relative(REPO_ROOT, outPath)}`);
      } catch (err) {
        failed = true;
        console.log("FAILED");
        console.error(`  ${err.message}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  if (failed) process.exit(1);
}

await main();
