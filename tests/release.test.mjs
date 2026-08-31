import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const sourceFiles = [
  "organizer.uc.mjs",
  "organizer-core.mjs",
  "zen-adapter.mjs",
  "providers.mjs",
  "organizer-page.mjs",
];

async function source(file) {
  return readFile(new URL(file, root), "utf8");
}

test("Sine metadata references the complete dependency-free package", async () => {
  const theme = JSON.parse(await source("theme.json"));
  assert.equal(theme.id, "zen-organizer");
  assert.equal(theme.version, "0.1.0");
  assert.equal(theme.chromeManifest, "chrome.manifest");
  assert.deepEqual(theme.scripts, {
    "organizer.uc.mjs": {
      include: ["chrome://browser/content/browser.xhtml"],
      loadOrder: 10,
    },
  });
  await Promise.all(
    [
      ...sourceFiles,
      "organizer.html",
      "organizer.css",
      theme.chromeManifest,
      "README.md",
      "LICENSE",
    ].map(source),
  );
});

test("all UI bindings resolve to unique document IDs", async () => {
  const html = await source("organizer.html");
  const page = await source("organizer-page.mjs");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const bindingBlock = page.match(/const elements = Object\.fromEntries\(([\s\S]*?)\.map\(/)?.[1];
  assert.ok(bindingBlock, "element binding list is present");
  for (const [, id] of bindingBlock.matchAll(/"([a-z][a-z0-9-]+)"/g)) {
    assert.ok(ids.includes(id), `missing #${id}`);
  }
});

test("privileged Zen access and network access stay in their boundaries", async () => {
  const sources = new Map(await Promise.all(sourceFiles.map(async file => [file, await source(file)])));
  for (const [file, contents] of sources) {
    if (file !== "zen-adapter.mjs") {
      assert.doesNotMatch(contents, /\b(?:gZenWorkspaces|gZenFolders|gBrowser|SessionStore)\b/);
    }
    if (file !== "providers.mjs") assert.doesNotMatch(contents, /\bfetch\s*\(/);
    assert.doesNotMatch(contents, /\b(?:IOUtils\.write|NetUtil\.asyncCopy|nsIServerSocket)\b/);
  }
  assert.doesNotMatch(await source("providers.mjs"), /zen-adapter\.mjs/);
});
