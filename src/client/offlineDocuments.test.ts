import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOfflineCacheResumePlan, listLocalMediaUrlsForDocument, type OfflineCacheStatus } from "./offlineDocuments";

function cacheStatus(overrides: Partial<OfflineCacheStatus> = {}): OfflineCacheStatus {
  return {
    fullLibrary: false,
    pinned: [],
    progress: { running: false, done: 0 },
    cachedDocumentCount: 0,
    cachedFolderCount: 0,
    ...overrides
  };
}

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

describe("offline cache startup resume", () => {
  it("does not recache a completed full-library cache on page startup", () => {
    assert.equal(getOfflineCacheResumePlan(cacheStatus({
      fullLibrary: true,
      fullLibraryCachedAt: "2026-07-10T10:00:00.000Z"
    })), null);
  });

  it("resumes a full-library cache that has not completed", () => {
    assert.deepEqual(getOfflineCacheResumePlan(cacheStatus({ fullLibrary: true })), {
      scope: "fullLibrary"
    });
  });

  it("only resumes incomplete pinned items", () => {
    const status = cacheStatus({
      pinned: [
        {
          key: "user\ndocument\ncomplete.md",
          username: "user",
          kind: "document",
          path: "complete.md",
          createdAt: "2026-07-10T09:00:00.000Z",
          cachedAt: "2026-07-10T10:00:00.000Z"
        },
        {
          key: "user\nfolder\nincomplete",
          username: "user",
          kind: "folder",
          path: "incomplete",
          createdAt: "2026-07-10T09:00:00.000Z"
        }
      ]
    });

    assert.deepEqual(getOfflineCacheResumePlan(status), {
      scope: "targets",
      targets: [{ kind: "folder", path: "incomplete" }]
    });
  });
});
