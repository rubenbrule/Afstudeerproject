import { Octokit } from "@octokit/rest";

export function createOctokit() {
  const token = import.meta.env.VITE_GH_TOKEN;
  if (!token) throw new Error("VITE_GH_TOKEN ontbreekt in .env.local");
  return new Octokit({ auth: token });
}

/** Parse: https://github.com/<owner>/<repo>/pull/<number> */
export function parsePrUrl(url) {
  try {
    const u = new URL(url);
    const [owner, repo, , number] = u.pathname.split("/").slice(1);
    if (!owner || !repo || !number) throw new Error("Geen geldige PR-URL");
    return { owner, repo, number: Number(number) };
  } catch {
    throw new Error("Ongeldige PR-URL");
  }
}

/** Bepaal Prism-taal uit bestandsnaam */
export function languageFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return ""; // fallback: auto
}