export async function runAiReview(prUrl, promptId) {
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

export async function postGhReview({ prUrl, headSha, comments, summary }) {
  const res = await fetch('/api/gh/review', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prUrl, headSha, comments, summary })
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Post review failed');
  return res.json();
}