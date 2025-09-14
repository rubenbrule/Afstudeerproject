import { useEffect, useMemo, useState } from "react";
import { Octokit } from "@octokit/rest";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Trash2 } from "lucide-react";


function parsePrUrl(url) {
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

async function runAiReview(prUrl, promptId) {
  const res = await fetch("/api/ai/review-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prUrl,
      // Alleen meesturen als er iets gekozen is
      ...(promptId ? { promptId: Number(promptId) } : {})
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || "AI review failed");
  }
  return res.json();
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

// Parseer een Git diff 'patch' naar een Set met 'nieuwe' (toegevoegde) regelnummers in het nieuwe bestand.
function parseAddedLinesFromPatch(patch = "") {
  const added = new Set();
  if (!patch) return added;

  let newLine = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const m = l.match(/\+(\d+)(?:,(\d+))?/);
      if (m) newLine = parseInt(m[1], 10) - 1; // we verhogen bij de volgende relevante regel
      continue;
    }
    if (l.startsWith(" ") || l.startsWith("+")) {
      newLine += 1;               // context of toevoeging telt mee in 'nieuwe' tellers
      if (l.startsWith("+")) {
        added.add(newLine);       // alleen '+' regels zijn commentable (RIGHT)
      }
    }
    // '-' (verwijderd) verhoogt alleen oldLine, niet newLine → negeren voor RIGHT
  }
  return added;
}


export default function PrViewer() {
  
  const [prUrl, setPrUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]); 
  const [headSha, setHeadSha] = useState("");

  const [selected, setSelected] = useState(null);
  const [line, setLine] = useState(1);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiFindings, setAiFindings] = useState([]); 
  const [edited, setEdited] = useState({}); 

  const fileList = useMemo(() => files, [files]);
  const lineCount = selected ? selected.content.split("\n").length : 0;

  const [prompts, setPrompts] = useState([]);
  const [selectedPromptId, setSelectedPromptId] = useState("");

  const [hoverLine, setHoverLine] = useState(null);
  const [relinkFinding, setRelinkFinding] = useState(null);

  // --- Nieuw: modal voor handmatige feedback ---
  const [newFbOpen, setNewFbOpen] = useState(false);
  const [newFbLine, setNewFbLine] = useState(null);
  const [newFbText, setNewFbText] = useState("");

  useEffect(() => {
  fetch('/api/prompts')
    .then(res => res.json())
    .then(setPrompts)
    .catch(() => setPrompts([]));
}, []);

  const findingsForSelected = useMemo(
    () => aiFindings.filter((f) => selected && f.file === selected.filename),
    [aiFindings, selected]
  );

  const addedLinesForSelected = useMemo(() => {
  if (!selected) return null;
  const f = files.find((x) => x.filename === selected.filename);
  if (!f?.patch) return null;
  return parseAddedLinesFromPatch(f.patch);
}, [files, selected]);

  const canPostSelected = !!selected && findingsForSelected.length > 0;

  function keyOf(f) {
    return `${f.file}:${f.start_line}-${f.end_line}:${f.rule}`;
  }

  function updateFinding(f, patch) {
    const k = keyOf(f);
    setEdited((prev) => ({ ...prev, [k]: { ...f, ...(prev[k] || {}), ...patch } }));
  }

  function handleLineClick(lineNumber) {
  if (!selected) return;
  // 1) Relink-modus actief? -> koppel de aangeklikte regel aan dat bestaande feedback-item
  if (relinkFinding) {
    updateFinding(relinkFinding, { start_line: lineNumber, end_line: lineNumber });
    setRelinkFinding(null);
    return;
  }
  // 2) Anders: normale flow voor "nieuwe feedback toevoegen" via modal
  setNewFbLine(lineNumber);
  setNewFbText("");
  setNewFbOpen(true);
}

function removeFinding(f) {
  const k = keyOf(f);
  // Verwijder het item uit de lijst
  setAiFindings((prev) => prev.filter((x) => keyOf(x) !== k));
  // Opruimen van eventuele bewerkingen op dit item
  setEdited((prev) => {
    const next = { ...prev };
    delete next[k];
    return next;
  });
}

// Snippet tonen met een paar regels context rondom de gekozen regel
const modalSnippet = useMemo(() => {
  if (!selected || !newFbOpen || !newFbLine) return { code: "", start: 1 };
  const lines = selected.content.split("\n");
  const start = Math.max(1, newFbLine - 2);
  const end   = Math.min(lines.length, newFbLine + 2);
  return { code: lines.slice(start - 1, end).join("\n"), start };
}, [selected, newFbOpen, newFbLine]);

function addManualFeedback() {
  if (!selected || !newFbLine || !newFbText.trim()) return;
  const newItem = {
    file: selected.filename,
    start_line: newFbLine,
    end_line: newFbLine,
    rule: "Handmatig",
    severity: "suggestion",
    message: newFbText.trim(),
    suggestion: "",
  };
  setAiFindings(prev => [...prev, newItem]);
  setNewFbOpen(false);
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

      const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
      const sha = pr.data.head.sha;
      setHeadSha(sha);

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
      const { headSha: sha, findings } = await runAiReview(prUrl, selectedPromptId || undefined);
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

  const comments = aiFindings
    .map((f) => {
      const cur = edited[keyOf(f)] ?? f; // ← ALTJD de edited variant
      const suggestion = (cur.suggestion ?? "").trim();
      if (!suggestion) return null;      // sla lege suggesties over
      return {
        path: cur.file,
        line: Number(cur.start_line),    // ← jouw aangepaste regelnummer
        body: suggestion,                // ← alleen de onderste textbox
      };
    })
    .filter(Boolean);

  // kleine debug is handig:
  console.log("POST comments:", comments);

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
      {/* {(loading || aiLoading) && (
        <div className="text-gray-600 text-sm">Bezig…</div>
      )} */}

      
      

      {fileList.length > 0 && (
        <div className="flex gap-4">
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
                    lineProps={(lineNumber) => {
                      const isAdded = addedLinesForSelected?.has(lineNumber);
                      return {
                        onClick: isAdded ? () => handleLineClick(lineNumber) : undefined,
                        className: `transition-colors ${isAdded ? "" : "opacity-50"}`,
                        style: { cursor: isAdded ? "pointer" : "not-allowed", display: "block" },
                        title: isAdded ? "Klik om feedback toe te voegen" : "Niet rechtstreeks commentable (niet in diff)",
                      };
                    }}
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

            
            <div className="border rounded p-3 h-[70vh] flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">AI-findings (dit bestand)</h3>
                <button
                  onClick={onAiReview}
                  className="bg-violet-600 text-white px-3 py-1 rounded hover:bg-violet-700 text-sm"
                >
                  AI review
                </button>
              </div>

              {(loading || aiLoading) && (
  <div className="text-xs text-gray-500 mb-2">Bezig…</div>
)}

<div className="flex items-center gap-2 mb-3">
  <label className="text-sm text-gray-700">Prompt:</label>
  <select
    value={selectedPromptId}
    onChange={(e) => setSelectedPromptId(e.target.value)}
    className="border rounded px-2 py-1"
  >
    <option value="">Standaard prompt</option>
    {prompts.map((p) => (
      <option key={p.id} value={p.id}>
        {p.title}
      </option>
    ))}
  </select>
</div>

{/* scrollbare content */}
<div className="flex-1 overflow-auto">
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
        <div className="flex items-start justify-between mb-1">
      <div className="text-xs text-gray-500">
        Regel {cur.start_line}
    {cur.end_line !== cur.start_line ? `–${cur.end_line}` : ""} • {cur.severity} • {cur.rule}
  </div>

  <button
    type="button"
    onClick={() => removeFinding(f)}
    className="text-gray-500 hover:text-red-600 ml-2"
    title="Verwijderen"
    aria-label="Verwijderen"
  >
    <Trash2 className="w-4 h-4" />
  </button>
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

{/* vaste footer onderaan panel */}
<div className="pt-2 mt-2 border-t">
  <button
    onClick={onPostReview}
    disabled={!canPostSelected}
    className={`w-full px-4 py-2 rounded text-white transition
      ${canPostSelected ? "bg-emerald-600 hover:bg-emerald-700" : "bg-gray-300 cursor-not-allowed"}
    `}
    title={canPostSelected ? "Post review naar GitHub" : "Geen feedback voor dit bestand"}
  >
    Post review
  </button>
</div>
            </div>
          </main>
        </div>
      )}
      {newFbOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40"
      onClick={() => setNewFbOpen(false)}
    />
    <div className="relative bg-white w-[min(900px,95vw)] max-h-[85vh] rounded-xl shadow p-4 overflow-auto">
      <h3 className="font-semibold text-lg mb-3">
        Nieuwe feedback — {selected?.filename} • regel {newFbLine}
      </h3>

      <div className="border rounded mb-3 overflow-hidden">
        <SyntaxHighlighter
          language={selected?.lang || undefined}
          style={vscDarkPlus}
          showLineNumbers
          wrapLines
          startingLineNumber={modalSnippet.start}
          lineNumberStyle={{ opacity: 0.6 }}
          lineProps={(ln) =>
            ln === newFbLine
              ? { style: { background: "rgba(255,225,0,0.18)" } }
              : {}
          }
        >
          {modalSnippet.code}
        </SyntaxHighlighter>
      </div>

      <label className="block text-sm font-medium mb-1">Feedback</label>
      <textarea
        className="w-full border rounded px-2 py-1"
        rows={4}
        placeholder="Feedback voor deze regel..."
        value={newFbText}
        onChange={(e) => setNewFbText(e.target.value)}
      />

      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          className="px-4 py-2 rounded border hover:bg-gray-50"
          onClick={() => setNewFbOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="px-4 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          disabled={!newFbText.trim()}
          onClick={addManualFeedback}
        >
          Add
        </button>
      </div>
    </div>
  </div>
)}
    </div>
  );
}