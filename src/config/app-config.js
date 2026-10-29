// Public configuration. Never put API keys, bank details or PayPal secrets here.
export const APP_CONFIG = Object.freeze({
  donations: {
    // Recommended: create a support/donation link in YOUR PayPal Business
    // account, verify the receiving account, then paste that HTTPS link.
    url: '',
    provider: 'PayPal',
    recipient: 'Mark Brezina',
    // Optional alternatives. Blank URLs are hidden. The first active link
    // above is primary; these can be added later without changing the UI.
    channels: [
      {provider:'GoFundMe',label:'Contribute to the server fund',url:''},
      {provider:'Patreon',label:'Become a monthly supporter',url:''}
    ]
  },
  // Resolves relative to the site's index.html, including GitHub Pages subpaths.
  dataManifest: './data/manifest.json'
});
