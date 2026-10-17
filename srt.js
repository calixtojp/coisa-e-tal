// Parser de SRT -> [{ start, end, text }] (tempos em segundos).
function parseSrt(raw) {
  const toSeconds = (t) => {
    const [h, m, rest] = t.trim().replace(",", ".").split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(rest);
  };

  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.trim().split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i === -1) return null;
      const [start, end] = lines[i].split("-->").map((s) => toSeconds(s.trim().split(/\s+/)[0]));
      const text = lines.slice(i + 1).join("\n").trim();
      return Number.isFinite(start) && Number.isFinite(end) ? { start, end, text } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}
