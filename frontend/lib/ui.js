/* lib/ui.js — small reusable UI helpers */

export function showToast(message, tone = 'success', duration = 3500) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'opacity 200ms, transform 200ms';
    setTimeout(() => el.remove(), 250);
  }, duration);
}

export function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

export function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

/* Wraps an async submit handler with disable/spinner UX */
export function attachAsyncSubmit(formEl, handler) {
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = formEl.querySelector('button[type="submit"]');
    const original = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    try {
      await handler(e);
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Something went wrong', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  });
}
