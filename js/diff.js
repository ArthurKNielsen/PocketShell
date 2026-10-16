// Line diff (LCS) with unified output.
export function diffLines(a, b) {
  const split = (t) => { if (!t) return []; const l = t.split('\n'); if (t.endsWith('\n')) l.pop(); return l; };
  const A = split(a), B = split(b);
  // trim common prefix/suffix to keep the DP table small
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push([' ', A[i]]);
  const n = a2.length, m = b2.length;
  if (n * m > 25_000_000) {
    for (const l of a2) ops.push(['-', l]);
    for (const l of b2) ops.push(['+', l]);
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { ops.push([' ', a2[i]]); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['+', b2[j]]); j++; }
      else { ops.push(['-', a2[i]]); i++; }
    }
  }
  for (let i = A.length - suf; i < A.length; i++) ops.push([' ', A[i]]);
  return ops;
}

export function unifiedDiff(a, b, nameA = 'a', nameB = 'b', color = true, context = 3) {
  const ops = diffLines(a, b);
  const col = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  let out = col('1', `--- ${nameA}`) + '\n' + col('1', `+++ ${nameB}`) + '\n';
  // group into hunks
  const changed = ops.map((o, i) => (o[0] !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return '';
  let hunks = [];
  let start = Math.max(0, changed[0] - context), end = Math.min(ops.length, changed[0] + context + 1);
  for (const i of changed.slice(1)) {
    if (i - context <= end) end = Math.min(ops.length, i + context + 1);
    else { hunks.push([start, end]); start = Math.max(0, i - context); end = Math.min(ops.length, i + context + 1); }
  }
  hunks.push([start, end]);
  for (const [s, e] of hunks) {
    let la = 1, lb = 1;
    for (let i = 0; i < s; i++) { if (ops[i][0] !== '+') la++; if (ops[i][0] !== '-') lb++; }
    const slice = ops.slice(s, e);
    const ca = slice.filter((o) => o[0] !== '+').length, cb = slice.filter((o) => o[0] !== '-').length;
    out += col('36', `@@ -${la},${ca} +${lb},${cb} @@`) + '\n';
    for (const [op, line] of slice) {
      if (op === '+') out += col('32', '+' + line) + '\n';
      else if (op === '-') out += col('31', '-' + line) + '\n';
      else out += ' ' + line + '\n';
    }
  }
  return out;
}
