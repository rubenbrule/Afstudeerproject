import { useEffect, useState } from 'react'

export default function PromptBeheer() {
  const [prompts, setPrompts] = useState([])
  const [selectedPrompt, setSelectedPrompt] = useState(null)
  const [newPrompt, setNewPrompt] = useState({ title: '', content: '' })

  // Ophalen prompts
  useEffect(() => {
    fetch('/api/prompts')
      .then(res => res.json())
      .then(setPrompts)
  }, [])

  // Prompt bewerken
  function handleEditChange(e) {
    setSelectedPrompt({ ...selectedPrompt, [e.target.name]: e.target.value })
  }

  // Opslaan bewerking
  async function handleUpdatePrompt() {
    await fetch(`/api/prompts/${selectedPrompt.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selectedPrompt),
    })
    // prompts opnieuw ophalen
  const updated = await fetch('/api/prompts')
  const updatedList = await updated.json()
  setPrompts(updatedList)
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

  // Nieuwe prompt aanmaken
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
    console.error("❌ Fout bij toevoegen:", errorText)
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

  alert("✅ Prompt succesvol toegevoegd")
} catch (err) {
  console.error("❌ Netwerkfout:", err)
  alert("Fout bij versturen van prompt")
}
  }

  return (
    <div className="flex gap-4">
      {/* Promptlijst */}
      <div className="w-1/3 border-r pr-4">
        <h2 className="font-semibold text-lg mb-2">📄 Prompts</h2>
        <ul className="space-y-2">
          {prompts.map((prompt) => (
            <li key={prompt.id}>
              <button
                onClick={() => setSelectedPrompt(prompt)}
                className="w-full text-left p-2 bg-gray-100 rounded hover:bg-gray-200"
              >
                {prompt.title}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Prompt detailpaneel */}
      <div className="w-2/3">
      <h2 className="font-semibold text-lg mb-2">➕ Nieuwe prompt</h2>

<form onSubmit={handleAddPrompt} className="space-y-2">
  <input
    name="title"
    value={newPrompt.title}
    onChange={(e) => setNewPrompt({ ...newPrompt, title: e.target.value })}
    placeholder="Titel"
    className="w-full p-2 border"
    required
  />
  <textarea
    name="content"
    value={newPrompt.content}
    onChange={(e) => setNewPrompt({ ...newPrompt, content: e.target.value })}
    placeholder="Prompt tekst"
    rows="4"
    className="w-full p-2 border"
    required
  />
  <button
    type="submit"
    className="bg-green-500 text-white px-4 py-2 rounded"
  >
    Toevoegen
  </button>
</form>

<hr className="my-6" />

        {selectedPrompt ? (
          <div>
            <h2 className="font-semibold text-lg mb-2">✏️ Bewerken</h2>
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
                onClick={handleUpdatePrompt}
                className="bg-blue-500 text-white px-4 py-2 rounded"
              >
                Opslaan
              </button>
              <button
                onClick={() => handleDeletePrompt(selectedPrompt.id)}
                className="bg-red-500 text-white px-4 py-2 rounded"
              >
                Verwijderen
              </button>
            </div>
          </div>
        ) : (
          <p>Selecteer een prompt om te bewerken.</p>
        )}
      </div>
    </div>
  )
}