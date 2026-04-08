// Shared diff helpers for the dashboard.
// Browser-friendly ES module with no DOM dependencies so node:test can import
// the same logic for regression coverage.

const DIFF_TOKEN_CELL_LIMIT = 1_500_000;

export function tokenizeDiffText(text) {
  return text == null ? [] : String(text).match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu) || [];
}

function mergeSegments(segments) {
  const merged = [];
  for (const seg of segments) {
    if (!seg?.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else merged.push({ type: seg.type, text: seg.text });
  }
  return merged;
}

function diffTokenArraysAffix(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return mergeSegments([
    { type: "common", text: a.slice(0, pre).join("") },
    { type: "removed", text: a.slice(pre, endA).join("") },
    { type: "added", text: b.slice(pre, endB).join("") },
    { type: "common", text: a.slice(endA).join("") },
  ]);
}

function diffTokenArraysLcs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  const segs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      segs.push({ type: "common", text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      segs.push({ type: "removed", text: a[i - 1] });
      i -= 1;
    } else {
      segs.push({ type: "added", text: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    segs.push({ type: "removed", text: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    segs.push({ type: "added", text: b[j - 1] });
    j -= 1;
  }
  segs.reverse();
  return mergeSegments(segs);
}

// Token-level diff for single-line values and for line-pair refinement inside
// multi-line hunks. Unlike the previous affix-only strategy it can surface
// multiple independent edit regions within one string. For very large token
// pairs we fall back to the cheaper affix diff to keep the UI responsive.
export function tokenDiffAsSegments(oldStr, newStr) {
  const a = tokenizeDiffText(oldStr);
  const b = tokenizeDiffText(newStr);
  if (a.length === 0 && b.length === 0) return [];
  return a.length * b.length > DIFF_TOKEN_CELL_LIMIT
    ? diffTokenArraysAffix(a, b)
    : diffTokenArraysLcs(a, b);
}

// Line-level LCS diff. Returns a segment list where each segment is
// {type: 'common'|'removed'|'added', text}. Common and removed segments
// carry content from the old side, common and added carry content from the
// new side. Adjacent same-type segments are merged so consecutive unchanged
// lines collapse into one "common" block (joined internally by \n).
//
// Why LCS and not affix: affix matching has no notion of "skip over this
// bit in the middle that happens to be the same as another bit in the
// middle". For a description where intro is rewritten AND one list item is
// renamed at the end, affix would flag everything between those two edits
// as changed — even if 90% of the list items in between are identical. LCS
// is O(n*m) in lines but for descriptions with <50 lines that's <2500 DP
// cells, trivially fast in practice.
export function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  // Traceback from (n, m). Segments are emitted in reverse order (we
  // reverse at the end). The tiebreak `dp[i-1][j] > dp[i][j-1]` (strict
  // greater, not >=) is chosen so that in the FINAL (post-reverse) list a
  // replaced line shows up as removed-before-added rather than
  // added-before-removed. That order matters downstream in
  // refineLineSegments() which scans for adjacent [removed, added] pairs
  // to run intra-pair token-level diff — without this tiebreak the pattern
  // would be [added, removed] and the refinement would miss every
  // modification.
  const segs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      segs.push({ type: "common", text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      segs.push({ type: "removed", text: a[i - 1] });
      i -= 1;
    } else {
      segs.push({ type: "added", text: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    segs.push({ type: "removed", text: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    segs.push({ type: "added", text: b[j - 1] });
    j -= 1;
  }
  segs.reverse();
  const merged = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) last.text += `\n${seg.text}`;
    else merged.push({ type: seg.type, text: seg.text });
  }
  // Append a trailing \n to every segment except the last so that line
  // boundaries are baked into segment text. Two reasons:
  //   1. The render step can then concatenate segments without inserting
  //      its own \n separator — which was incorrect for refined intra-line
  //      fragments where two adjacent segments belong to the SAME line
  //      (e.g. common "*) Automatyczna klimatyzacja" + added " 4 strefowa")
  //      and must not have a newline shoved between them.
  //   2. The refinement step below runs tokenDiff on each removed/added
  //      pair. With trailing \n in both inputs, the common suffix naturally
  //      includes the newline, so the refined output carries the line
  //      boundary through as a common segment containing "\n".
  for (let k = 0; k < merged.length - 1; k += 1) {
    merged[k].text += "\n";
  }
  // Second pass: refine [removed, added] pairs. Line-level LCS is correct
  // about WHICH lines changed, but for a single-line modification (e.g.
  // `*) Automatyczna klimatyzacja` → `*) Automatyczna klimatyzacja 4
  // strefowa`) it marks the entire line red/green even though only the
  // changed tokens differ. Running token-level LCS on each removed/added
  // pair surfaces the intra-line changes while keeping the multi-region
  // correctness from the outer line-level diff.
  return refineLineSegments(merged);
}

export function refineLineSegments(lineSegments) {
  const out = [];
  let i = 0;
  while (i < lineSegments.length) {
    const seg = lineSegments[i];
    const next = lineSegments[i + 1];
    if (seg.type === "removed" && next && next.type === "added") {
      out.push(...tokenDiffAsSegments(seg.text, next.text));
      i += 2;
    } else {
      out.push(seg);
      i += 1;
    }
  }
  return mergeSegments(out);
}

function pushLinePiece(line, piece) {
  if (!piece?.text) return;
  const last = line[line.length - 1];
  if (last && last.type === piece.type) last.text += piece.text;
  else line.push({ type: piece.type, text: piece.text });
}

function segmentsToLines(segments) {
  const lines = [[]];
  for (const seg of segments) {
    const parts = String(seg?.text || "").split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i]) pushLinePiece(lines[lines.length - 1], { type: seg.type, text: parts[i] });
      if (i < parts.length - 1) lines.push([]);
    }
  }
  return lines;
}

// Large multi-line fields (description_text) are too noisy when both columns
// render the full common body around a tiny edit. Keep only changed lines plus
// a small amount of surrounding context and collapse the rest into ellipses.
export function compactMultiLineSegments(segments, options = {}) {
  const contextLines = options.contextLines ?? 1;
  const minLines = options.minLines ?? 8;
  const lines = segmentsToLines(segments);
  const changedLineIndexes = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].some((piece) => piece.type !== "common")) changedLineIndexes.push(i);
  }

  const fullEntries = lines.map((pieces) => ({ kind: "line", pieces }));
  if (changedLineIndexes.length === 0 || lines.length < minLines) {
    return { compacted: false, entries: fullEntries, totalLines: lines.length };
  }

  const keep = new Set();
  for (const index of changedLineIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    for (let i = start; i <= end; i += 1) keep.add(i);
  }

  if (keep.size === lines.length) {
    return { compacted: false, entries: fullEntries, totalLines: lines.length };
  }

  const keptIndexes = [...keep].sort((a, b) => a - b);
  const entries = [];
  let cursor = 0;
  for (const index of keptIndexes) {
    if (index > cursor) {
      entries.push({ kind: "omitted", omittedLineCount: index - cursor });
    }
    entries.push({ kind: "line", pieces: lines[index] });
    cursor = index + 1;
  }
  if (cursor < lines.length) {
    entries.push({ kind: "omitted", omittedLineCount: lines.length - cursor });
  }

  return { compacted: true, entries, totalLines: lines.length };
}
