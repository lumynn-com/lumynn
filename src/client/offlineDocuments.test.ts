import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listLocalMediaUrlsForDocument } from "./offlineDocuments";

describe("offline document media cache discovery", () => {
  it("finds local image references outside markdown code", () => {
    const urls = listLocalMediaUrlsForDocument(
      [
        "![[Images/photo.png]]",
        "![scan](../assets/scan.jpg \"Scan\")",
        "![cached](/api/documents/media?path=Images%2Fcached.png&base=Folder%2FNote.md)",
        "![remote](https://example.com/remote.png)",
        "![data](data:image/png;base64,AAAA)",
        "`![[inline-skip.png]]`",
        "```md",
        "![[fenced-skip.png]]",
        "```"
      ].join("\n"),
      "Folder/Note.md"
    );

    assert.deepEqual(new Set(urls), new Set([
      "/api/documents/media?path=Images%2Fphoto.png&base=Folder%2FNote.md",
      "/api/documents/media?path=..%2Fassets%2Fscan.jpg&base=Folder%2FNote.md",
      "/api/documents/media?path=Images%2Fcached.png&base=Folder%2FNote.md"
    ]));
  });
});
