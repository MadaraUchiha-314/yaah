import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// srcDir is docs/ itself; this file sits in docs/.vitepress/.
const docsRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The per-work-item spec artifacts are part of the site: a checked-in artifact nobody
// can find is a checked-in artifact nobody reads. The sidebar for docs/specs/ is
// GENERATED from the filesystem (requirement R8.6) so a new work item appears without
// anyone editing this file — nav upkeep is exactly the chore that stops getting done.
const SPEC_FILE_ORDER: [string, string][] = [
  ["brainstorm", "Brainstorm"],
  ["requirements", "Requirements"],
  ["bugfix", "Bugfix"],
  ["design", "Design"],
  ["testing-plan", "Testing plan"],
  ["tasks", "Tasks"],
  ["execution-log", "Execution log"],
];

function issueNumber(dir: string): number {
  const m = dir.match(/(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function specSidebarGroups() {
  const specsDir = join(docsRoot, "specs");
  const dirs = readdirSync(specsDir)
    .filter((d) => statSync(join(specsDir, d)).isDirectory())
    .sort((a, b) => issueNumber(a) - issueNumber(b));

  return dirs.map((dir) => {
    const present = new Set(
      readdirSync(join(specsDir, dir))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
    );
    const items = SPEC_FILE_ORDER.filter(([slug]) => present.has(slug)).map(
      ([slug, text]) => ({
        text,
        link: `/specs/${dir}/${slug}`,
      }),
    );
    return { text: dir, collapsed: true, items };
  });
}

// One sidebar for everything a contributor reads, so moving between the guide, the
// architecture and the specs never changes the furniture.
const developerSidebar = [
  {
    text: "Guide",
    items: [
      { text: "What is yaah?", link: "/guide/what-is-yaah" },
      { text: "Tech stack", link: "/guide/tech-stack" },
      { text: "Local development", link: "/guide/local-development" },
      { text: "Contributing", link: "/guide/contributing" },
      { text: "Releases", link: "/guide/releases" },
    ],
  },
  {
    text: "Architecture",
    items: [{ text: "Overview", link: "/architecture/architecture" }],
  },
  {
    text: "Capabilities",
    collapsed: true,
    items: [
      { text: "Index", link: "/capabilities/capabilities" },
      {
        text: "Repository toolchain",
        link: "/capabilities/repository-toolchain",
      },
      { text: "Documentation site", link: "/capabilities/documentation-site" },
    ],
  },
  {
    text: "Decisions",
    collapsed: true,
    items: [
      { text: "Decision log", link: "/decisions/decisions" },
      { text: "Conflicts & assumptions", link: "/decisions/conflicts" },
    ],
  },
  {
    text: "Learnings",
    collapsed: true,
    items: [{ text: "Learnings index", link: "/learnings/learnings" }],
  },
  {
    text: "Specs",
    collapsed: true,
    items: [{ text: "Overview", link: "/specs/" }, ...specSidebarGroups()],
  },
];

// withMermaid wraps defineConfig so ```mermaid fences render as diagrams rather than as
// code. The loop's artifacts lean on `draw it rather than describe it` — a design whose
// diagrams show up as source is a design nobody reads on this site.
export default withMermaid(
  defineConfig({
    // Mermaid renders node labels as foreignObject HTML by default, which sizes the box
    // before the font has settled and clips multi-line labels. SVG text labels are
    // measured exactly, so a wrapped label stays inside its box.
    mermaid: { flowchart: { htmlLabels: false } },
    title: "yaah",
    description:
      "Yet Another Agent Harness — documentation, architecture and decisions.",
    // Served from https://madarauchiha-314.github.io/yaah/ by the Pages workflow. Vite
    // bakes this into every asset URL, so it must match the deployed path exactly.
    base: "/yaah/",
    cleanUrls: true,
    lastUpdated: true,

    // Several checked-in documents link to repository paths outside docs/ — AGENTS.md,
    // .the-loop/harness-config.yaml, .pre-commit-config.yaml. Those links are correct on
    // GitHub, which is where those documents are read; rewriting them to satisfy the
    // site's srcDir would break the canonical copy to fix the rendered one.
    ignoreDeadLinks: true,

    markdown: {
      // The loop's artifacts are written for GitHub-flavoured Markdown and are full of
      // angle-bracket placeholders in prose — <id>, <nnn>, <phase>. VitePress compiles
      // Markdown as a Vue template, which treats a bare <id> as an unclosed HTML tag and
      // fails the build. Disabling raw-HTML passthrough renders them as literal text,
      // exactly how GitHub shows them. ```mermaid fences are unaffected.
      //
      // The other half of Vue's template syntax, `{ {` / `} }`, cannot be disabled the
      // same way: the delimiters are a compiler-wide setting and the default theme's own
      // components use them, so overriding them renders the theme's chrome as literal
      // text. Prose that needs to quote a GitHub Actions expression puts it in a fenced
      // code block, which VitePress marks `v-pre`. A page that gets this wrong fails the
      // build loudly — see docs/scripts/build.mjs.
      html: false,
    },

    themeConfig: {
      nav: [
        { text: "Guide", link: "/guide/what-is-yaah", activeMatch: "^/guide/" },
        { text: "Tech stack", link: "/guide/tech-stack" },
        { text: "Local development", link: "/guide/local-development" },
        {
          text: "Developer",
          items: [
            { text: "Architecture", link: "/architecture/architecture" },
            { text: "Capabilities", link: "/capabilities/capabilities" },
            { text: "Decisions", link: "/decisions/decisions" },
            { text: "Learnings", link: "/learnings/learnings" },
            { text: "Specs", link: "/specs/" },
          ],
        },
      ],

      sidebar: {
        "/guide/": developerSidebar,
        "/architecture/": developerSidebar,
        "/capabilities/": developerSidebar,
        "/decisions/": developerSidebar,
        "/learnings/": developerSidebar,
        "/specs/": developerSidebar,
      },

      socialLinks: [
        { icon: "github", link: "https://github.com/MadaraUchiha-314/yaah" },
      ],

      search: { provider: "local" },

      editLink: {
        pattern:
          "https://github.com/MadaraUchiha-314/yaah/edit/main/docs/:path",
        text: "Edit this page on GitHub",
      },

      footer: {
        message: "Released under the Apache 2.0 License.",
        copyright: "Copyright © MadaraUchiha-314",
      },
    },
  }),
);
