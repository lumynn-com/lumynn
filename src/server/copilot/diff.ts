export function createUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return `--- a/${path}\n+++ b/${path}\n`;
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const table = buildLcsTable(beforeLines, afterLines);
  const lines = [`--- a/${path}`, `+++ b/${path}`];

  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      lines.push(` ${beforeLines[i]}`);
      i += 1;
      j += 1;
    } else if (j < afterLines.length && (i === beforeLines.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push(`+${afterLines[j]}`);
      j += 1;
    } else if (i < beforeLines.length) {
      lines.push(`-${beforeLines[i]}`);
      i += 1;
    }
  }

  return lines.join("\n");
}

function buildLcsTable(a: string[], b: string[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export type ApplyEditResult =
  | { ok: true; content: string }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "AMBIGUOUS"; occurrences: number };

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(content: string, searchText: string): number {
  if (!searchText) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(searchText, pos)) !== -1) {
    count += 1;
    pos += 1;
  }
  return count;
}

function stripBom(content: string): { content: string; hasBom: boolean } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { content: content.slice(1), hasBom: true };
  }
  return { content, hasBom: false };
}

interface TextSearchResult {
  found: boolean;
  occurrences: number;
  usedFuzzyMatch: boolean;
  workingContent: string;
  workingSearch: string;
  workingReplace: string;
}

function findTextForReplacement(content: string, oldText: string, newText: string): TextSearchResult {
  const exactOccurrences = countOccurrences(content, oldText);
  if (exactOccurrences > 0) {
    return {
      found: true,
      occurrences: exactOccurrences,
      usedFuzzyMatch: false,
      workingContent: content,
      workingSearch: oldText,
      workingReplace: newText
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyNewText = normalizeForFuzzyMatch(newText);
  const fuzzyOccurrences = countOccurrences(fuzzyContent, fuzzyOldText);

  return {
    found: fuzzyOccurrences > 0,
    occurrences: fuzzyOccurrences,
    usedFuzzyMatch: true,
    workingContent: fuzzyContent,
    workingSearch: fuzzyOldText,
    workingReplace: fuzzyNewText
  };
}

function mapFuzzyIndexToNormal(normalLines: string[], fuzzyLines: string[], fuzzyIndex: number): number {
  let normalOffset = 0;
  let fuzzyOffset = 0;
  for (let lineIndex = 0; lineIndex < fuzzyLines.length; lineIndex += 1) {
    const fuzzyLine = fuzzyLines[lineIndex] ?? "";
    const normalLine = normalLines[lineIndex] ?? "";
    const nextFuzzyOffset = fuzzyOffset + fuzzyLine.length;
    if (fuzzyIndex <= nextFuzzyOffset) {
      const inLine = Math.max(0, fuzzyIndex - fuzzyOffset);
      return normalOffset + Math.min(inLine, normalLine.length);
    }
    fuzzyOffset = nextFuzzyOffset + 1;
    normalOffset += normalLine.length + 1;
  }
  return normalLines.join("\n").length;
}

export function applyEditToContent(content: string, oldText: string, newText: string): ApplyEditResult {
  const { content: contentNoBom, hasBom } = stripBom(content);
  const crlfCount = (contentNoBom.match(/\r\n/g) ?? []).length;
  const lfCount = (contentNoBom.match(/(?<!\r)\n/g) ?? []).length;
  const usesCrlf = crlfCount > lfCount;
  const normalizedContent = normalizeLineEndings(contentNoBom);
  const normalizedOldText = normalizeLineEndings(oldText);
  const normalizedNewText = normalizeLineEndings(newText);
  const searchResult = findTextForReplacement(normalizedContent, normalizedOldText, normalizedNewText);

  if (!searchResult.found) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (searchResult.occurrences > 1) {
    return { ok: false, reason: "AMBIGUOUS", occurrences: searchResult.occurrences };
  }

  let matchStart: number;
  let matchEnd: number;
  if (searchResult.usedFuzzyMatch) {
    const normalLines = normalizedContent.split("\n");
    const fuzzyLines = searchResult.workingContent.split("\n");
    const fuzzyMatchIndex = searchResult.workingContent.indexOf(searchResult.workingSearch);
    matchStart = mapFuzzyIndexToNormal(normalLines, fuzzyLines, fuzzyMatchIndex);
    matchEnd = mapFuzzyIndexToNormal(normalLines, fuzzyLines, fuzzyMatchIndex + searchResult.workingSearch.length);
    if (matchStart >= matchEnd) {
      return { ok: false, reason: "NOT_FOUND" };
    }
    const roundTrip = normalizeForFuzzyMatch(normalizedContent.substring(matchStart, matchEnd));
    if (roundTrip !== searchResult.workingSearch) {
      return { ok: false, reason: "NOT_FOUND" };
    }
  } else {
    matchStart = normalizedContent.indexOf(searchResult.workingSearch);
    matchEnd = matchStart + searchResult.workingSearch.length;
  }

  let modifiedContent = `${normalizedContent.substring(0, matchStart)}${searchResult.workingReplace}${normalizedContent.substring(matchEnd)}`;
  if (usesCrlf) {
    modifiedContent = modifiedContent.replace(/\n/g, "\r\n");
  }
  if (hasBom) {
    modifiedContent = `\uFEFF${modifiedContent}`;
  }
  return { ok: true, content: modifiedContent };
}
