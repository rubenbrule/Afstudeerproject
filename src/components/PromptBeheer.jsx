import { useEffect, useMemo, useState } from 'react'

export default function PromptBeheer() {
  const [prompts, setPrompts] = useState([])
  const [selectedPrompt, setSelectedPrompt] = useState(null)
  const [newPrompt, setNewPrompt] = useState({ title: '', content: '' })
  const [createUploading, setCreateUploading] = useState(false);
  const [createFiles, setCreateFiles] = useState([]);
  const [saveNotice, setSaveNotice] = useState(false);

  // ✨ Nieuw: sorteerkeuze + popup state
  const [sortBy, setSortBy] = useState('default') // 'default' | 'az' | 'za'
  const [newPromptOpen, setNewPromptOpen] = useState(false)

  // Ophalen prompts
  useEffect(() => {
    fetch('/api/prompts')
      .then(res => res.json())
      .then(setPrompts)
  }, [])

  // ✨ Nieuw: gesorteerde weergave
  const sortedPrompts = useMemo(() => {
    const arr = [...prompts]
    if (sortBy === 'az') {
      arr.sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', 'nl', { sensitivity: 'base' })
      )
    } else if (sortBy === 'za') {
      arr.sort((a, b) =>
        (b.title || '').localeCompare(a.title || '', 'nl', { sensitivity: 'base' })
      )
    }
    // default: volgorde uit API (meestal created_at DESC)
    return arr
  }, [prompts, sortBy])

  // Prompt bewerken
  function handleEditChange(e) {
    setSelectedPrompt({ ...selectedPrompt, [e.target.name]: e.target.value })
  }

  // Opslaan bewerking
  // async function handleUpdatePrompt() {
  //   await fetch(`/api/prompts/${selectedPrompt.id}`, {
  //     method: 'PUT',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(selectedPrompt),
  //   })
  //   // prompts opnieuw ophalen
  //   const updated = await fetch('/api/prompts')
  //   const updatedList = await updated.json()
  //   setPrompts(updatedList)
  // }
  async function handleUpdatePrompt() {
  if (!selectedPrompt?.id) return;

  try {
    // DB bijwerken
    await fetch(`/api/prompts/${selectedPrompt.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: selectedPrompt.title,
        content: selectedPrompt.content,
      }),
    });

    // Lijst verversen
    const updated = await fetch('/api/prompts');
    const updatedList = await updated.json();
    setPrompts(updatedList);

    // 🔔 Succes-melding tonen
    setSaveNotice(true);

    // ↩️ Terug naar “beginscherm” (niets geselecteerd)
    setSelectedPrompt(null);
    // alleen als je deze state ook gebruikt in je lijst:
    if (typeof setSelectedPromptId === 'function') {
      setSelectedPromptId(null);
    }

    // Melding na 2.5s automatisch weg
    setTimeout(() => setSaveNotice(false), 2500);
  } catch (err) {
    console.error(err);
    alert('Opslaan mislukt. Probeer het nog eens.');
  }
}

  // Prompt verwijderen
  async function handleDeletePrompt(id) {
    await fetch(`/api/prompts/${id}`, { method: 'DELETE' })
    // prompts opnieuw ophalen
    const updated = await fetch('/api/prompts')
    const updatedList = await updated.json()
    setPrompts(updatedList)
    setSelectedPrompt(null)
  }

  // Nieuwe prompt aanmaken (blijft staan; niet gebruikt door het rechter formulier)
  async function handleAddPrompt(e) {
    e.preventDefault()
    try {
      const response = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPrompt),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error("Fout bij toevoegen:", errorText)
        alert("Fout bij toevoegen van prompt")
        return
      }

      console.log("✅ Prompt toegevoegd:", newPrompt)

      // reset veld
      setNewPrompt({ title: '', content: '' })

      // prompts opnieuw ophalen
      const updated = await fetch('/api/prompts')
      const updatedList = await updated.json()
      setPrompts(updatedList)

      alert("Prompt succesvol toegevoegd")
    } catch (err) {
      console.error("Netwerkfout:", err)
      alert("Fout bij versturen van prompt")
    }
  }

  // ✨ Esc-toets voor popup (optioneel, non-breaking)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') setNewPromptOpen(false)
    }
    if (newPromptOpen) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [newPromptOpen])

  return (
    <div className="flex gap-4">
      {/* Promptlijst */}
      <div className="w-1/3 border-r pr-4">
        {/* ✨ Header met titel, + knop en sorteer */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-lg">Prompts</h2>

          <div className="flex items-center gap-2">
            {/* ronde + knop (opent popup) */}
            

            {/* sorteer-menu */}
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <span className="hidden sm:inline">Sorteer:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="default">Standaard</option>
                <option value="az">A–Z</option>
                <option value="za">Z–A</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setNewPromptOpen(true)}
              aria-label="Nieuwe prompt"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#d96b30] text-white shadow-sm transition hover:bg-[#c25f2b] focus:outline-none focus:ring-2 focus:ring-[#d96b30]"            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" className="h-5 w-5">
                <path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
              </svg>
            </button>
          </div>
        </div>

        {/* <ul className="space-y-2">
          {sortedPrompts.map((prompt) => {
            const isSelected = selectedPrompt?.id === prompt.id
            return (
              <li key={prompt.id}>
                <button
                  onClick={() => setSelectedPrompt(prompt)}
                  className={[
                    'w-full text-left p-2 rounded transition-colors',
                    isSelected
                      ? 'bg-gray-200 border border-[#d96b30]'
                      : 'bg-gray-100 hover:bg-gray-200'
                  ].join(' ')}
                >
                  {prompt.title}
                </button>
              </li>
            )
          })}
        </ul> */}
        <ul className="grid gap-2">
  {sortedPrompts.map((prompt) => {
    const isSelected = selectedPrompt?.id === prompt.id
    const accent = '#d96b30'

    // simpele detectie op basis van jouw DB-kolom 'file_ids' (TEXT, csv)
    const fileCount = (() => {
  const raw = prompt.file_ids;
  if (!raw) return 0;

  // 1) Als het al een array is
  if (Array.isArray(raw)) {
    return new Set(raw.filter(Boolean)).size;
  }

  // 2) Als het een string is
  if (typeof raw === 'string') {
    // Probeer JSON te parsen (bv. '["file_abc"]')
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter(Boolean)).size;
      }
    } catch (_) {
      // geen JSON; ga door naar fallback
    }

    // 3) Fallback: haal alléén echte file-ids uit de string
    const ids = raw.match(/file_[a-zA-Z0-9]+/g) || [];
    return new Set(ids).size;
  }

  return 0;
})();

const hasFiles = fileCount > 0;

    // korte preview (val terug op content als er geen description is)
    const preview = (prompt.description ?? prompt.content ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)

    return (
      <li key={prompt.id}>
        <button
  type="button"
  onClick={() => setSelectedPrompt(prompt)}
  className={[
    'group relative w-full text-left',
    // was: rounded-2xl …
    'rounded-lg overflow-hidden border bg-white p-3 shadow-sm transition',
    'ring-1 ring-gray-200 hover:ring-gray-300 hover:shadow-md',
    'focus:outline-none focus-visible:ring-2',
    isSelected
      ? `bg-[${accent}]/5 ring-[${accent}]`
      : 'bg-white'
  ].join(' ')}
>
          {/* accentbalk links bij selectie */}
          {isSelected && (
  <span
    aria-hidden="true"
    className="absolute left-0 top-0 h-full w-1.5 rounded-l-lg"
    style={{ backgroundColor: accent }}
  />
)}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate font-medium text-gray-900">
                  {prompt.title}
                </h3>

                {hasFiles && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                    {/* paperclip */}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      className="h-3.5 w-3.5"
                    >
                      <path d="M21 15V7a5 5 0 0 0-10 0v10a3 3 0 0 0 6 0V9" />
                    </svg>
                    {fileCount}
                  </span>
                )}
              </div>

              {preview && (
                <p className="mt-0.5 line-clamp-1 text-sm text-gray-500">
                  {preview}{(prompt.description ?? prompt.content ?? '').length > 120 ? '…' : ''}
                </p>
              )}
            </div>

            {/* chevron rechts */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={[
                'h-5 w-5 shrink-0 transition-transform',
                isSelected ? 'translate-x-0.5' : 'group-hover:translate-x-0.5',
              ].join(' ')}
            >
              <path d="M7.25 4.5l5.5 5.5-5.5 5.5" />
            </svg>
          </div>
        </button>
      </li>
    )
  })}

  {sortedPrompts.length === 0 && (
    <li className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
      Nog geen prompts — klik op <span className="font-medium">+</span> om je eerste prompt aan te maken.
    </li>
  )}
</ul>
      </div>

      {/* Prompt detailpaneel */}
      <div className="w-2/3">
        {selectedPrompt ? (
          <div>
            <h2 className="font-semibold text-lg mb-2">Bewerken</h2>
            <input
              name="title"
              value={selectedPrompt.title}
              onChange={handleEditChange}
              className="w-full p-2 border mb-2"
            />
            <textarea
              name="content"
              value={selectedPrompt.content}
              onChange={handleEditChange}
              rows="6"
              className="w-full p-2 border mb-2"
            />
            <div className="flex gap-2">
              <button
  type="button"
  onClick={handleUpdatePrompt}
  aria-label="Opslaan"
  title="Opslaan"
  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-green-600 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-500"
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <path d="M5 13l4 4L19 7" />
  </svg>
</button>
              <button
  type="button"
  onClick={() => handleDeletePrompt(selectedPrompt.id)}
  aria-label="Verwijderen"
  title="Verwijderen"
  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-red-600 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500"
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    {/* Trash icon (outline) */}
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
</button>
            </div>
          </div>
        ) : (
          <p>Selecteer een prompt om te bewerken.</p>
        )}
      </div>

      {/* ✨ Extra: Popup met hetzelfde formulier (optioneel naast het rechter formulier) */}
      {newPromptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setNewPromptOpen(false)}
          />
          {/* Paneel */}
          <div className="relative bg-white w-[min(900px,95vw)] max-h-[85vh] rounded-xl shadow p-4 overflow-auto">
            <div className="flex items-center justify-between border-b pb-3 mb-3">
              <h3 className="font-semibold text-lg">Nieuwe prompt</h3>
              <button
                type="button"
                onClick={() => setNewPromptOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Sluiten"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

            {/* Zelfde formulier als rechts */}
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newPrompt.title || !newPrompt.content) return;

                try {
                  setCreateUploading(true);
                  const fd = new FormData();
                  fd.append('title', newPrompt.title);
                  fd.append('content', newPrompt.content);
                  for (const f of createFiles) fd.append('files', f); // moet 'files' heten

                  const r = await fetch('/api/prompts/create-with-files', {
                    method: 'POST',
                    body: fd,
                  });
                  const j = await r.json();
                  if (!r.ok || j.error) throw new Error(j.error || 'Mislukt');

                  // UI reset + lijst refreshen
                  setNewPrompt({ title: '', content: '' });
                  setCreateFiles([]);
                  await fetch('/api/prompts').then(r => r.json()).then(setPrompts);

                  // popup sluiten
                  setNewPromptOpen(false);

                  alert('Prompt aangemaakt' + (createFiles.length ? ' + bestanden geüpload' : ''));
                } catch (err) {
                  console.error(err);
                  alert(`Fout bij aanmaken: ${err.message || err}`);
                } finally {
                  setCreateUploading(false);
                }
              }}
              className="space-y-4"
            >
              <div className="grid gap-3">
                <input
                  name="title"
                  value={newPrompt.title}
                  onChange={(e) => setNewPrompt({ ...newPrompt, title: e.target.value })}
                  placeholder="Titel"
                  className="w-full p-2 border rounded"
                  required
                  autoFocus
                />
                <textarea
                  name="content"
                  value={newPrompt.content}
                  onChange={(e) => setNewPrompt({ ...newPrompt, content: e.target.value })}
                  placeholder="Prompt tekst"
                  rows={5}
                  className="w-full p-2 border rounded"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Bestanden (optioneel)</label>
                <input
                  type="file"
                  multiple
                  onChange={(e) => setCreateFiles(Array.from(e.target.files || []))}
                  className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-gray-50"
                />
                {createFiles.length > 0 && (
                  <ul className="text-xs text-gray-600 list-disc pl-5 space-y-0.5">
                    {createFiles.map((f, i) => (
                      <li key={i}>{f.name} <span className="text-gray-400">({Math.round(f.size / 1024)} kB)</span></li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded border"
                  onClick={() => setNewPromptOpen(false)}
                  disabled={createUploading}
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:opacity-50"
                  disabled={createUploading}
                >
                  {createUploading ? 'Toevoegen…' : 'Toevoegen'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {saveNotice && (
  <div className="fixed right-4 top-4 z-50 rounded-lg bg-green-600 px-4 py-2 text-white shadow-lg">
    Prompt succesvol opgeslagen
  </div>
)}
    </div>
    
  )
}