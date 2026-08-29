import { useState, type ReactNode } from "react";
import {
  parseUnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type DiffLineType,
  type ParsedDiffFile,
} from "./diff-parser.js";
import "./CodeDiffViewer.css";

export type { DiffHunk, DiffLine, DiffLineType, ParsedDiffFile };

export interface CodeDiffViewerProps {
  readonly diffText: string;
  readonly emptyMessage?: string;
  readonly className?: string;
}

export function CodeDiffViewer({
  diffText,
  emptyMessage = "No code changes.",
  className,
}: CodeDiffViewerProps): ReactNode {
  const files = parseUnifiedDiff(diffText);
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());

  if (files.length === 0) {
    return <p className="mn-muted">{emptyMessage}</p>;
  }

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const containerClasses = ["mn-code-diff"];
  if (className !== undefined) containerClasses.push(className);

  return (
    <div className={containerClasses.join(" ")}>
      <div className="mn-code-diff__summary">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="mn-code-diff__stat--add">+{totalAdditions}</span>
        <span className="mn-code-diff__stat--del">−{totalDeletions}</span>
      </div>
      {files.map((file) => {
        const isCollapsed = collapsedFiles.has(file.newPath);
        return (
          <div key={file.newPath} className="mn-code-diff__file">
            <div
              className="mn-code-diff__file-header"
              onClick={() => {
                toggleFile(file.newPath);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  toggleFile(file.newPath);
                }
              }}
            >
              <span className="mn-code-diff__file-path">{file.newPath}</span>
              <div className="mn-code-diff__file-stats">
                <span className="mn-code-diff__stat--add">+{file.additions}</span>
                <span className="mn-code-diff__stat--del">−{file.deletions}</span>
              </div>
            </div>
            {!isCollapsed && (
              <div className="mn-code-diff__hunks">
                {file.hunks.map((hunk, hIdx) => (
                  <div key={`${file.newPath}-hunk-${String(hIdx)}`}>
                    <div className="mn-code-diff__hunk-header">{hunk.header}</div>
                    {hunk.lines.map((line, lIdx) => (
                      <div
                        key={`${file.newPath}-hunk-${String(hIdx)}-line-${String(lIdx)}`}
                        className={`mn-code-diff__line mn-code-diff__line--${line.type}`}
                      >
                        <span className="mn-code-diff__gutter">
                          {line.type === "del"
                            ? line.oldLineNumber
                            : line.type === "add"
                              ? line.newLineNumber
                              : line.newLineNumber}
                        </span>
                        <span className="mn-code-diff__marker">
                          {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                        </span>
                        <span className="mn-code-diff__content">{line.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
