import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const api = await readFile(new URL("../public/api.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const i18n = await readFile(new URL("../public/i18n.js", import.meta.url), "utf8");

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

test("user-facing app rendering avoids HTML string sinks", () => {
  assert.doesNotMatch(app + i18n, /\.innerHTML\s*=/);
  assert.doesNotMatch(app + i18n, /insertAdjacentHTML|outerHTML\s*=/);
});

test("browser authentication uses cookies rather than browser-readable access tokens", () => {
  assert.doesNotMatch(app + api, /rap\.token|TOKEN_KEY|access_token/);
  assert.match(api, /credentials:'include'/);
  assert.match(api, /if\(MOCK\)\{[\s\S]*?localStorage\.getItem\('rap\.actor'\)/);
});

test("the document has no inline scripts so the self-only CSP can execute", () => {
  assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*[^<\s]/i);
});

test("English and Chinese resources have identical leaf keys", () => {
  const resources = new Function(`${i18n}\nreturn I18N_RES;`)() as {
    en: { translation: Record<string, unknown> };
    zh: { translation: Record<string, unknown> };
  };
  assert.deepEqual(
    leafKeys(resources.en.translation).sort(),
    leafKeys(resources.zh.translation).sort(),
  );
});

test("static and literal dynamic translation keys resolve in both languages", () => {
  const resources = new Function(`${i18n}\nreturn I18N_RES;`)() as {
    en: { translation: Record<string, unknown> };
    zh: { translation: Record<string, unknown> };
  };
  const available = new Set(leafKeys(resources.en.translation));
  const staticKeys = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const dynamicKeys = [...app.matchAll(/\bt\(['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((key) => !key.endsWith("."));
  for (const key of new Set([...staticKeys, ...dynamicKeys])) {
    assert.ok(available.has(key), `missing EN/ZH translation key: ${key}`);
  }
});

test("language changes cover the document, login gates, mode, and safe errors", () => {
  assert.match(i18n, /document\.title = t\('app\.title'\)/);
  assert.match(app, /function renderModeTag\(\)/);
  assert.match(app, /renderModeTag\(\);\s*if\(!loop\) return/);
  assert.match(app, /blurb\.dataset\.i18n='login\.blurb'/);
  assert.match(app, /button\.dataset\.i18n='login\.retry'/);
  assert.match(app, /function prepareGate\(\)/);
  assert.match(app, /\$\('#sessionBar'\)\.classList\.remove\('show'\)/);
  assert.match(app, /function errorText\(error\)/);
  assert.doesNotMatch(app, /saveFail[^;\n]*e\.message/);
  assert.doesNotMatch(app, /MOCK · localStorage|LIVE · /);
});

test("loop lifecycle writes share one queue and recover a failed graph save first", () => {
  assert.match(app, /function enqueueMutation\(run\)/);
  assert.match(app, /async function persistDirtyCurrentLoop\(\)/);
  assert.match(app, /startLoopTitleEdit\(\)[\s\S]*?enqueueMutation\(async\(\)=>/);
  assert.match(app, /\$\('#publishBtn'\)\.onclick=async\(\)=>[\s\S]*?enqueueMutation\(async\(\)=>/);
  assert.match(app, /async function doFork\(id, title\)[\s\S]*?enqueueMutation\(async\(\)=>/);
  assert.match(app, /persistDirtyCurrentLoop\(\)[\s\S]*?API\.publish/);
});

test("legacy and hostile pattern rows are normalized before rendering", () => {
  assert.match(app, /function ensureShape\(s\)/);
  assert.match(app, /Array\.from\(\{length:sec\.rows\}/);
  assert.match(app, /Array\.from\(\{length:STEPS\}/);
  assert.match(app, /row\[c\]===true/);
  assert.match(app, /g\.nodes\.slice\(0,256\)/);
  assert.match(app, /n\.reps=Number\.isInteger\(n\.reps\)/);
  assert.match(app, /ids\.has\(e\.from\) && ids\.has\(e\.to\)/);
  assert.match(app, /s\.bpm=Number\.isFinite\(s\.bpm\)\?Math\.max\(20,Math\.min\(400,s\.bpm\)\):88/);
});

test("hostile stored graph values normalize to bounded renderable data", () => {
  const normalizeStart = app.indexOf("function normalizeGraph(g)");
  const ensureStart = app.indexOf("function ensureShape(s)");
  const ensureEnd = app.indexOf("/* select a node", ensureStart);
  assert.ok(normalizeStart >= 0 && ensureStart > normalizeStart && ensureEnd > ensureStart);
  const makeNormalizer = new Function(
    "SECTIONS",
    "STEPS",
    `${app.slice(normalizeStart, ensureEnd)}; return normalizeGraph;`,
  );
  const normalizeGraph = makeNormalizer(
    [
      { id: "drums", rows: 5 },
      { id: "k808", rows: 6 },
      { id: "keys", rows: 8 },
      { id: "bars", rows: 1 },
    ],
    16,
  );
  const graph = normalizeGraph({
    nodes: [
      null,
      {
        id: `bad id`,
        x: "far",
        y: 1e200,
        reps: 999,
        state: {
          grids: { drums: [[true, "yes"]] },
          bars: { 0: "123456789012345", 99: "drop", nope: {} },
          bpm: 1e20,
          swing: -4,
        },
      },
    ],
    edges: [{ from: "missing", to: "missing" }],
    master: { align: "yes", bpm: -1 },
  });

  assert.equal(graph.nodes.length, 1);
  assert.match(graph.nodes[0].id, /^legacy_/);
  assert.equal(graph.nodes[0].x, 40);
  assert.equal(graph.nodes[0].y, 100000);
  assert.equal(graph.nodes[0].reps, 64);
  assert.equal(graph.nodes[0].state.grids.drums.length, 5);
  assert.equal(graph.nodes[0].state.grids.drums[0].length, 16);
  assert.deepEqual(graph.nodes[0].state.grids.drums[0].slice(0, 2), [true, false]);
  assert.deepEqual(graph.nodes[0].state.bars, { 0: "1234567890" });
  assert.equal(graph.nodes[0].state.bpm, 400);
  assert.equal(graph.nodes[0].state.swing, 0);
  assert.deepEqual(graph.edges, []);
  assert.equal(graph.master.align, false);
  assert.equal(graph.master.bpm, 20);
});
