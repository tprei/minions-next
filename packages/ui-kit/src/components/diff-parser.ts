export type DiffLineType = "add" | "del" | "ctx";

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
}

export interface ParsedDiffFile {
  readonly oldPath: string;
  readonly newPath: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

export function parseUnifiedDiff(raw: string): readonly ParsedDiffFile[] {
  if (raw.trim().length === 0) return [];
  const lines = raw.split("\n");
  const files: ParsedDiffFile[] = [];
  let currentFile: {
    oldPath: string;
    newPath: string;
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
  } | null = null;
  let currentHunk: {
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
  } | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentHunk !== null && currentFile !== null) {
        currentFile.hunks.push(
          Object.freeze({ ...currentHunk, lines: Object.freeze(currentHunk.lines) }),
        );
        currentHunk = null;
      }
      if (currentFile !== null) {
        files.push(Object.freeze({ ...currentFile, hunks: Object.freeze(currentFile.hunks) }));
      }
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      currentFile = {
        oldPath: match?.[1] ?? "unknown",
        newPath: match?.[2] ?? "unknown",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (line.startsWith("--- a/")) {
      if (currentFile !== null) currentFile.oldPath = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ b/")) {
      if (currentFile !== null) currentFile.newPath = line.slice(6);
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (currentHunk !== null && currentFile !== null) {
        currentFile.hunks.push(
          Object.freeze({ ...currentHunk, lines: Object.freeze(currentHunk.lines) }),
        );
      }
      const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line);
      const oldStart = hunkMatch ? Number(hunkMatch[1]) : 1;
      const oldCount = hunkMatch?.[2] !== undefined ? Number(hunkMatch[2]) : 1;
      const newStart = hunkMatch ? Number(hunkMatch[3]) : 1;
      const newCount = hunkMatch?.[4] !== undefined ? Number(hunkMatch[4]) : 1;
      oldLine = oldStart;
      newLine = newStart;
      currentHunk = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      continue;
    }

    if (currentHunk !== null && currentFile !== null) {
      if (line.startsWith("+")) {
        currentFile.additions += 1;
        currentHunk.lines.push({
          type: "add",
          text: line.slice(1),
          newLineNumber: newLine,
        });
        newLine += 1;
      } else if (line.startsWith("-")) {
        currentFile.deletions += 1;
        currentHunk.lines.push({
          type: "del",
          text: line.slice(1),
          oldLineNumber: oldLine,
        });
        oldLine += 1;
      } else if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({
          type: "ctx",
          text: line.startsWith(" ") ? line.slice(1) : line,
          oldLineNumber: oldLine,
          newLineNumber: newLine,
        });
        oldLine += 1;
        newLine += 1;
      }
    }
  }

  if (currentHunk !== null && currentFile !== null) {
    currentFile.hunks.push(
      Object.freeze({ ...currentHunk, lines: Object.freeze(currentHunk.lines) }),
    );
  }
  if (currentFile !== null) {
    files.push(Object.freeze({ ...currentFile, hunks: Object.freeze(currentFile.hunks) }));
  }

  return Object.freeze(files);
}
