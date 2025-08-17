// src/components/PrViewer.jsx
import { useEffect, useMemo, useState } from "react";
import { Octokit } from "@octokit/rest";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

/**
 * Zelfstandige helpers – geen extra imports nodig
 */
function parsePrUrl(url) {
  try {
    const u = new URL(url);
    // /owner/repo/pull/123
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

function languageFromFilename(name = "") {
  const lower = name.toLowerCase();
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

function createOctokit() {
  const token = import.meta.env.VITE_GH_TOKEN;
  if (!token) {
    console.warn(
      "VITE_GH_TOKEN ontbreekt. Publieke repos kunnen deels werken (rate limit), maar inline comments posten vereist auth."
    );
  }
  return new Octokit(token ? { auth: token } : {});
}

/**
 * REST helpers naar je backend (Stap 4)
 */
async function runAiReview(prUrl) {
  const res = await fetch("/api/ai/review-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || "AI review failed");
  }
  return res.json(); // { headSha, findings }
}

async function postGhReview({ prUrl, headSha, comments, summary }) {
  const res = await fetch("/api/gh/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl, headSha, comments, summary }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || "Post review failed");
  }
  return res.json();
}

/**
 * Het component
 */
export default function PrViewer() {
  // PR ophalen
  const [prUrl, setPrUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]); // [{ filename, additions, deletions, status, sha, patch }]
  const [headSha, setHeadSha] = useState("");

  // Bestandsweergave
  const [selected, setSelected] = useState(null); // { filename, content, lang }
  const [line, setLine] = useState(1);

  // AI
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiFindings, setAiFindings] = useState([]); // alle bestanden
  const [edited, setEdited] = useState({}); // key -> Finding (bewerkt)

  // UI helpers
  const fileList = useMemo(() => files, [files]);
  const lineCount = selected ? selected.content.split("\n").length : 0;

  const findingsForSelected = useMemo(
    () => aiFindings.filter((f) => selected && f.file === selected.filename),
    [aiFindings, selected]
  );

  function keyOf(f) {
    return `${f.file}:${f.start_line}-${f.end_line}:${f.rule}`;
  }

  function updateFinding(f, patch) {
    const k = keyOf(f);
    setEdited((prev) => ({ ...prev, [k]: { ...f, ...(prev[k] || {}), ...patch } }));
  }

  async function loadPr() {
    setError("");
    setFiles([]);
    setSelected(null);
    setHeadSha("");
    setAiFindings([]);
    setEdited({});
    if (!prUrl) return;

    try {
      setLoading(true);
      const { owner, repo, number } = parsePrUrl(prUrl);
      const octokit = createOctokit();

      // PR + head sha
      const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
      const sha = pr.data.head.sha;
      setHeadSha(sha);

      // Bestandenlijst incl. patches (unified diff)
      const filesRes = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });

      const prFiles = filesRes.data.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        sha: f.sha,
        patch: f.patch || "",
      }));

      setFiles(prFiles);

      // Laad eerste tekstbestand
      const firstText = prFiles.find(
        (f) => !/\.(png|jpg|jpeg|gif|svg|pdf|mp4|mov|zip|lock)$/i.test(f.filename)
      );
      if (firstText) {
        await loadFileContent(owner, repo, sha, firstText.filename);
      }
    } catch (e) {
      setError(e.message || "PR ophalen mislukt");
    } finally {
      setLoading(false);
    }
  }

  async function loadFileContent(owner, repo, ref, path) {
    setError("");
    setLoading(true);
    try {
      const octokit = createOctokit();
      const res = await octokit.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(res.data) || !res.data.content) {
        throw new Error("Kon bestandinhoud niet ophalen");
      }
      const decoded = atob(res.data.content.replace(/\n/g, ""));
      const lang = languageFromFilename(path);
      setSelected({ filename: path, content: decoded, lang });

      // reset lijnselectie
      const lines = decoded.split("\n").length;
      setLine(Math.min(line, lines) || 1);
    } catch (e) {
      setError(e.message || "Bestand ophalen mislukt");
    } finally {
      setLoading(false);
    }
  }

  async function onAiReview() {
    if (!prUrl) return;
    setAiError("");
    setAiFindings([]);
    setEdited({});
    try {
      setAiLoading(true);
      const { headSha: sha, findings } = await runAiReview(prUrl);
      setHeadSha(sha);
      setAiFindings(findings || []);
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  }

  async function onPostReview() {
    if (!prUrl || !headSha) {
      alert("Laad eerst een PR en voer een AI-review uit.");
      return;
    }
    // Neem alle findings (alle files), met edits toegepast
    const chosen = aiFindings.map((f) => edited[keyOf(f)] ?? f);

    // Map naar GitHub review comments
    const comments = chosen.map((f) => ({
      path: f.file,
      line: f.start_line, // let op: inline comment kan alleen op regels in de diff
      body:
        `[${(f.severity || "info").toUpperCase()}] ${f.rule}: ${f.message}` +
        (f.suggestion ? `\n\nSuggestie: ${f.suggestion}` : ""),
    }));

    try {
      await postGhReview({
        prUrl,
        headSha,
        comments,
        summary: "AI-feedback per regel (gecontroleerd en waar nodig aangepast door docent).",
      });
      alert("Review geplaatst!");
    } catch (e) {
      alert(`Mislukt: ${e.message}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* PR invoer */}
      <div className="flex gap-2">
        <input
          type="url"
          className="border rounded px-3 py-2 w-full"
          placeholder="Plak PR-URL, bv. https://github.com/owner/repo/pull/123"
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
        />
        <button
          onClick={loadPr}
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
        >
          Ophalen
        </button>
      </div>

      {(error || aiError) && (
        <div className="text-red-600 text-sm">
          {error || aiError}
        </div>
      )}
      {(loading || aiLoading) && (
        <div className="text-gray-600 text-sm">Bezig…</div>
      )}

      {/* Actieknoppen */}
      <div className="flex gap-2">
        <button
          onClick={onAiReview}
          className="bg-violet-600 text-white px-3 py-2 rounded hover:bg-violet-700"
        >
          AI review
        </button>
        <button
          onClick={onPostReview}
          className="bg-emerald-600 text-white px-3 py-2 rounded hover:bg-emerald-700"
        >
          Post review
        </button>
      </div>

      {fileList.length > 0 && (
        <div className="flex gap-4">
          {/* Bestanden */}
          <aside className="w-72 border rounded p-3 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-2">Bestanden in PR</h3>
            <ul className="space-y-1">
              {fileList.map((f) => (
                <li key={f.filename}>
                  <button
                    onClick={async () => {
                      try {
                        const { owner, repo, number } = parsePrUrl(prUrl);
                        await loadFileContent(owner, repo, headSha, f.filename);
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                    className={`text-left w-full px-2 py-1 rounded hover:bg-gray-100 ${
                      selected?.filename === f.filename ? "bg-gray-200" : ""
                    }`}
                    title={`+${f.additions} / -${f.deletions}`}
                  >
                    {f.filename}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* Code + feedback */}
          <main className="flex-1 grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
            <div className="border rounded p-3 h-[70vh] overflow-auto">
              {selected ? (
                <>
                  <div className="mb-2 text-sm text-gray-600">
                    <strong>Bestand:</strong> {selected.filename}
                  </div>
                  <SyntaxHighlighter
                    language={selected.lang || undefined}
                    style={vscDarkPlus}
                    wrapLines
                    showLineNumbers
                    lineNumberStyle={{ opacity: 0.6 }}
                  >
                    {selected.content}
                  </SyntaxHighlighter>
                </>
              ) : (
                <div className="text-gray-500">
                  Selecteer een bestand links om de code te bekijken.
                </div>
              )}
            </div>

            {/* Feedback zijpaneel */}
            <div className="border rounded p-3 h-[70vh] overflow-auto">
              <h3 className="font-semibold mb-3">AI-findings (dit bestand)</h3>
              {selected && findingsForSelected.length === 0 && (
                <div className="text-sm text-gray-500">
                  Nog geen AI-feedback of geen issues in dit bestand.
                </div>
              )}

              {findingsForSelected.map((f) => {
                const k = keyOf(f);
                const cur = edited[k] ?? f;
                return (
                  <div key={k} className="border rounded p-2 mb-3">
                    <div className="text-xs text-gray-500 mb-1">
                      Regel {cur.start_line}
                      {cur.end_line !== cur.start_line ? `–${cur.end_line}` : ""} •{" "}
                      {cur.severity} • {cur.rule}
                    </div>
                    <textarea
                      className="w-full border rounded px-2 py-1 mb-2"
                      rows={3}
                      value={cur.message}
                      onChange={(e) => updateFinding(f, { message: e.target.value })}
                    />
                    <textarea
                      className="w-full border rounded px-2 py-1"
                      rows={2}
                      placeholder="Suggestie…"
                      value={cur.suggestion || ""}
                      onChange={(e) => updateFinding(f, { suggestion: e.target.value })}
                    />
                  </div>
                );
              })}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}