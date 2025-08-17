export async function runAiReview(prUrl) {
  const res = await fetch('/api/ai/review-pr', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prUrl })
  });
  if (!res.ok) throw new Error((await res.json()).error || 'AI review failed');
  return res.json(); // { headSha, findings }
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