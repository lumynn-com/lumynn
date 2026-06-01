import assert from "node:assert/strict";
import test from "node:test";
import { isRagIndexableDocumentPath } from "./indexJobs";

test("isRagIndexableDocumentPath excludes files under the copilot folder", () => {
  assert.equal(isRagIndexableDocumentPath("copilot/session.md"), false);
  assert.equal(isRagIndexableDocumentPath("Copilot/session.md"), false);
  assert.equal(isRagIndexableDocumentPath("copilot\\session.md"), false);
  assert.equal(isRagIndexableDocumentPath("Notes/copilot/session.md"), true);
  assert.equal(isRagIndexableDocumentPath("copilot.md"), true);
  assert.equal(isRagIndexableDocumentPath("Projects/Note.md"), true);
});
