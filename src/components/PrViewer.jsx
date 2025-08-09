import { useMemo, useState } from "react";
import { createOctokit, parsePrUrl, languageFromFilename } from "../lib/github";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

export default function PrViewer() {
  const [prUrl, setPrUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);  // { filename, content, lang }
  const [headSha, setHeadSha] = useState("");

  // Feedback UI state
  const [line, setLine] = useState(1);
  const [body, setBody] = useState("");

  async function loadPr() {
    setError("");
    setFiles([]);
    setSelected(null);
    setHeadSha("");
    if (!prUrl) return;

    try {
      setLoading(true);
      const { owner, repo, number } = parsePrUrl(prUrl);
      const octokit = createOctokit();

      // Haal PR + head SHA
      const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
      const sha = pr.data.head.sha;
      setHeadSha(sha);

      // Haal bestandenlijst
      const filesRes = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: number,
        per_page: 100
      });

      const prFiles = filesRes.data.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        sha: f.sha,
      }));

      setFiles(prFiles);

      const firstText = prFiles.find(f =>
        !/\.(png|jpg|jpeg|gif|svg|pdf|mp4|mov)$/i.test(f.filename)
      );

      if (firstText) {
        await loadFileContent(octokit, owner, repo, number, firstText.filename, sha);
      }
    } catch (e) {
      setError(e.message || "Er ging iets mis bij het ophalen van de PR");
    } finally {
      setLoading(false);
    }
  }

  async function loadFileContent(octokit, owner, repo, number, path, sha) {
    setError("");
    setLoading(true);
    try {
      const res = await octokit.repos.getContent({ owner, repo, path, ref: sha });
      if (Array.isArray(res.data) || !res.data.content) {
        throw new Error("Kon bestandinhoud niet ophalen");
      }
      const decoded = atob(res.data.content.replace(/\n/g, ""));
      const lang = languageFromFilename(path);
      setSelected({ filename: path, content: decoded, lang });
      // reset line selectie
      const lines = decoded.split("\n").length;
      setLine(Math.min(line, lines) || 1);
    } catch (e) {
      setError(e.message || "Bestand ophalen mislukt");
    } finally {
      setLoading(false);
    }
  }

  async function postInlineComment() {
    setError("");
    if (!prUrl || !selected || !body.trim()) {
      setError("Kies een bestand en vul feedback in.");
      return;
    }

    const { owner, repo, number } = parsePrUrl(prUrl);
    const octokit = createOctokit();

    try {
      // Probeer inline op specifieke regel in de diff
      await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: number,
        body,
        commit_id: headSha,        // head commit van PR
        path: selected.filename,   // pad in repo
        line: Number(line),        // regelnummer (let op: moet in de diff zitten)
        side: "RIGHT",             // wijzigingszijde (meestal RIGHT)
      });

      setBody("");
      alert("Inline comment geplaatst!");
    } catch (e) {
      // Als de regel niet in de diff zit, krijgen we vaak 422.
      // Val dan terug op een algemene PR-comment met context.
      if (e.status === 422) {
        try {
          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: number,
            body:
              `**Feedback op ${selected.filename}:${line}**\n\n` +
              body +
              `\n\n*(Kon geen inline comment plaatsen omdat de regel niet in de PR-diff zit. Daarom als algemene opmerking.)*`,
          });
          setBody("");
          alert("Algemene PR-comment geplaatst (fallback).");
        } catch (e2) {
          setError(e2.message || "Ook fallback comment mislukt.");
        }
      } else {
        setError(e.message || "Inline comment plaatsen mislukt.");
      }
    }
  }

  const fileList = useMemo(() => files, [files]);
  const lineCount = selected ? selected.content.split("\n").length : 0;

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
        <button onClick={loadPr} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700">
          Ophalen
        </button>
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}
      {loading && <div className="text-gray-600 text-sm">Laden…</div>}

      {fileList.length > 0 && (
        <div className="flex gap-4">
          {/* Bestanden */}
          <aside className="w-72 border rounded p-3 h-[70vh] overflow-auto">
            <h3 className="font-semibold mb-2">Bestanden in PR</h3>
            <ul className="space-y-1">
              {fileList.map(f => (
                <li key={f.filename}>
                  <button
                    onClick={async () => {
                      const { owner, repo, number } = parsePrUrl(prUrl);
                      const octokit = createOctokit();
                      await loadFileContent(octokit, owner, repo, number, f.filename, headSha);
                    }}
                    className={`text-left w-full px-2 py-1 rounded hover:bg-gray-100 ${selected?.filename === f.filename ? "bg-gray-200" : ""}`}
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
                <div className="text-gray-500">Selecteer een bestand links om de code te bekijken.</div>
              )}
            </div>

            {/* Feedback zijpaneel */}
            <div className="border rounded p-3 h-[70vh] overflow-auto">
              <h3 className="font-semibold mb-3">Feedback plaatsen</h3>
              {selected ? (
                <>
                  <label className="text-sm text-gray-700">Regelnummer</label>
                  <input
                    type="number"
                    min="1"
                    max={lineCount || 1}
                    value={line}
                    onChange={(e) => setLine(e.target.value)}
                    className="border rounded px-2 py-1 w-28 mb-3 ml-2"
                  />
                  <div className="mb-2 text-xs text-gray-500">
                    Totaal regels: {lineCount}. Inline comments werken alleen op regels die in de PR-diff zitten.
                  </div>

                  <label className="text-sm text-gray-700">Feedback</label>
                  <textarea
                    rows={8}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="border rounded w-full px-2 py-2 mb-3"
                    placeholder="Schrijf hier je feedback voor deze regel…"
                  />

                  <button
                    onClick={postInlineComment}
                    className="bg-emerald-600 text-white px-4 py-2 rounded hover:bg-emerald-700"
                  >
                    Plaats inline comment
                  </button>
                </>
              ) : (
                <div className="text-gray-500">Selecteer eerst een bestand.</div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}