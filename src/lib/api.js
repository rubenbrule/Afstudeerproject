// Client helper die de frontend naar de backend laat posten om een AI code review te draaien op een PR
export async function runAiReview(prUrl, promptId) {
  const res = await fetch("/api/ai/review-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prUrl,
      // Alleen meesturen als er iets gekozen is
      ...(promptId ? { promptId: Number(promptId) } : {}),
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || "AI review failed");
  }
  return res.json();
}

// Client-helper om een samengestelde review (AI + handmatig) terug te posten naar Github
export async function postGhReview({ prUrl, headSha, comments, summary }) {
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
