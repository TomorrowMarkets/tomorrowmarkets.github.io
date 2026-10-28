// Public configuration. Never put API keys, bank details or PayPal secrets here.
export const APP_CONFIG = Object.freeze({
  donations: {
    // Paste YOUR account's HTTPS payment/fundraising link, e.g. PayPal.Me,
    // a PayPal hosted button, GoFundMe, Ko-fi, or a Stripe Payment Link.
    url: '',
    provider: 'PayPal',
    recipient: 'Mark Brezina'
  },
  // Resolves relative to the site's index.html, including GitHub Pages subpaths.
  dataManifest: './data/manifest.json'
});
