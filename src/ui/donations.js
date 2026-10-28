export function donationLink(config) {
  try {
    const url = new URL(config.url);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function mountDonations(config, root = document) {
  const dialog = root.querySelector('#support-dialog');
  if (!dialog) return;
  const href = donationLink(config);
  const link = dialog.querySelector('[data-donation-link]');
  const status = dialog.querySelector('[data-donation-status]');
  const recipient = dialog.querySelector('[data-donation-recipient]');
  if (recipient) recipient.textContent = config.recipient || 'The project creator';
  if (href) {
    link.href = href;
    link.textContent = `Continue to ${config.provider || 'donate'}`;
    link.hidden = false;
    status.textContent = 'Your contribution is paid to the creator’s account through the payment page below.';
  } else {
    link.hidden = true;
    link.removeAttribute('href');
    status.textContent = 'The donation link is coming soon. Thank you for supporting Tomorrow Markets.';
  }
  let previousFocus = null;
  root.querySelectorAll('[data-support]').forEach((button) => button.addEventListener('click', () => {
    previousFocus = root.activeElement;
    if (!dialog.open) dialog.showModal();
  }));
  dialog.querySelector('[data-support-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => previousFocus?.focus());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  } });
}
