import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { muyaToObsidianMarkdown, obsidianToMuyaMarkdown } from "./obsidianEmbeds";

describe("Obsidian image embed transforms", () => {
  it("round-trips a plain image embed", () => {
    const input = "before ![[attachments/a.png]] after";
    const muya = obsidianToMuyaMarkdown(input, "Notes/today.md");

    assert.match(muya, /!\[a\.png\]\(\/api\/documents\/media\?/);
    assert.match(muya, /path=attachments%2Fa\.png/);
    assert.match(muya, /base=Notes%2Ftoday\.md/);
    assert.equal(muyaToObsidianMarkdown(muya), input);
  });

  it("round-trips image embeds with captions", () => {
    const input = "Logo ![[assets/logo.webp|Product logo]]";
    const muya = obsidianToMuyaMarkdown(input, "README.md");

    assert.match(muya, /!\[Product logo\]\(/);
    assert.match(muya, /owdMeta=Product\+logo/);
    assert.equal(muyaToObsidianMarkdown(muya), input);
  });

  it("round-trips image embeds with dimensions", () => {
    const input = "![[diagrams/flow.svg|300x200]]";
    const muya = obsidianToMuyaMarkdown(input);

    assert.match(muya, /!\[flow\.svg\]\(/);
    assert.match(muya, /owdMeta=300x200/);
    assert.equal(muyaToObsidianMarkdown(muya), input);
  });

  it("ignores fenced code and inline code", () => {
    const input = [
      "`![[inline.png]]`",
      "```md",
      "![[fenced.png]]",
      "```",
      "![[real.png]]"
    ].join("\n");
    const muya = obsidianToMuyaMarkdown(input);

    assert.match(muya, /`!\[\[inline\.png\]\]`/);
    assert.match(muya, /!\[\[fenced\.png\]\]/);
    assert.match(muya, /!\[real\.png\]\(/);
    assert.equal(muyaToObsidianMarkdown(muya), input);
  });

  it("leaves wiki links and non-image embeds untouched", () => {
    const input = "[[Page Name]] ![[note.pdf]]";

    assert.equal(obsidianToMuyaMarkdown(input), input);
  });
});
