export function donationLink(config) {
  try {
    const url = new URL(config.url);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function donationOptions(config) {
  const seen = new Set();
  return [config,...(Array.isArray(config.channels)?config.channels:[])].flatMap(channel=>{
    const url=donationLink(channel);
    if(!url||seen.has(url))return [];
    seen.add(url);
    return [{url,provider:String(channel.provider||'Support').slice(0,50),label:String(channel.label||'').slice(0,80)}];
  });
}

export function mountDonations(config, root = document) {
  const dialog = root.querySelector('#support-dialog');
  if (!dialog) return;
  const options = donationOptions(config);
  const href = options[0]?.url;
  const link = dialog.querySelector('[data-donation-link]');
  const status = dialog.querySelector('[data-donation-status]');
  const recipient = dialog.querySelector('[data-donation-recipient]');
  if (recipient) recipient.textContent = config.recipient || 'The project creator';
  if (href) {
    link.href = href;
    link.textContent = options[0].label || `Continue to ${options[0].provider}`;
    link.hidden = false;
    status.textContent = 'Your contribution is paid to the creator’s account through the payment page below.';
  } else {
    link.hidden = true;
    link.removeAttribute('href');
    status.textContent = 'The donation link is coming soon. Thank you for supporting Tomorrow Markets.';
  }
  dialog.querySelector('[data-donation-extra]')?.remove();
  if(options.length>1){
    const extra=root.createElement('div');extra.dataset.donationExtra='';extra.className='support-dialog-actions';
    for(const option of options.slice(1)){
      const item=root.createElement('a');item.href=option.url;item.target='_blank';item.rel='noopener noreferrer';
      item.className='btn btn-ghost';item.textContent=option.label||`Support on ${option.provider}`;extra.append(item);
    }
    link.parentNode.append(extra);
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
