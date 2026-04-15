import { Octokit } from "@octokit/rest";

// Maakt een Github API client (Octokit) aan met de persoonlijke token uit .env
export function createOctokit() {
  const token = import.meta.env.VITE_GH_TOKEN;
  if (!token) {
    console.warn("VITE_GH_TOKEN ontbreekt.");
  }
  return new Octokit(token ? { auth: token } : {});
}

// Zet een GitHub PR om naar losse onderdelen (owner, repo, number)
export function parsePrUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    const number = Number(parts[3]);
    if (!owner || !repo || !number) throw new Error("Ongeldige PR-URL");
    return { owner, repo, number };
  } catch {
    throw new Error("Ongeldige PR-URL");
  }
}

// Bepaalt welke taal gebruikt moet worden voor code-highlighting (voor react-syntax-highlighter / Prism)
export function languageFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return undefined;
}

export function parseAddedLinesFromPatch(patch = "") {
  const added = new Set();
  if (!patch) return added;

  let newLine = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      const m = l.match(/\+(\d+)(?:,(\d+))?/);
      if (m) newLine = parseInt(m[1], 10) - 1;
      continue;
    }
    if (l.startsWith(" ") || l.startsWith("+")) {
      newLine += 1;
      if (l.startsWith("+")) {
        added.add(newLine);
      }
    }
  }
  return added;
}
