import { writeDocument, readDocument } from "../vault/vaultService";
import type { UserRecord } from "../store";
import type { FileEditProposal } from "./types";

const proposals = new Map<string, FileEditProposal>();

export function putFileEditProposal(proposal: FileEditProposal): FileEditProposal {
  proposals.set(proposal.id, proposal);
  return proposal;
}

export function getFileEditProposal(username: string, id: string): FileEditProposal | null {
  const proposal = proposals.get(id);
  if (!proposal || proposal.username !== username) {
    return null;
  }
  return proposal;
}

export function rejectFileEditProposal(username: string, id: string): FileEditProposal | null {
  const proposal = getFileEditProposal(username, id);
  if (!proposal) {
    return null;
  }
  proposal.status = "rejected";
  proposal.message = "Rejected";
  return proposal;
}

export async function applyFileEditProposal(user: UserRecord, id: string): Promise<FileEditProposal> {
  const proposal = getFileEditProposal(user.username, id);
  if (!proposal) {
    const error = new Error("File edit proposal not found");
    error.name = "NotFound";
    throw error;
  }
  if (proposal.status !== "pending" && proposal.status !== "conflict") {
    return proposal;
  }

  if (proposal.expectedHash === null) {
    const existing = await readDocument(user, proposal.path).catch(() => null);
    if (existing) {
      proposal.status = "conflict";
      proposal.message = "A file now exists at this path. Review before applying.";
      const error = new Error(proposal.message);
      error.name = "ConflictError";
      throw error;
    }
  }

  try {
    await writeDocument(user, proposal.path, proposal.proposedContent, proposal.expectedHash ?? undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "ConflictError") {
      proposal.status = "conflict";
      proposal.message = error.message;
    }
    throw error;
  }

  proposal.status = "applied";
  proposal.message = "Applied";
  return proposal;
}

export function clearFileEditProposalsForTest(): void {
  proposals.clear();
}
