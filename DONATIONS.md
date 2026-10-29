# Set up project support

Recommendation for Tomorrow Markets: start with a **PayPal Business support link**. Add a GoFundMe campaign if you want a visible, finite infrastructure target. Add Patreon when you want to maintain recurring memberships with regular supporter updates. One provider is enough to launch.

## Choosing a provider

| Provider | Best fit here | Current cost notes |
| --- | --- | --- |
| PayPal Business | A direct Support button for voluntary contributions | Normal account payment fees apply; check your account's current rates/currency before launch |
| GoFundMe | A public campaign with a clear server/domain/database target and progress updates | UK individual/business fundraisers: no platform setup/management fee; 2.9% + £0.25 processing per contribution; conversion/international charges can apply |
| Patreon | Monthly/annual memberships and ongoing supporter content/community | New creator pages on the standard plan: 10% platform fee, plus processing, conversion/payout fees and applicable taxes |

Provider details checked 28 October 2026. PayPal explicitly supports business contributions for both nonprofit and for-profit organisations. This project does not need to claim registered-charity status to use that business support route. Choose the account/organisation type that actually applies.

## PayPal: the shortest setup

1. Create or use your own PayPal Business account and complete the verification requested by PayPal. Use the creator/business identity that should receive the contributions.
2. Connect and verify the bank/payout details inside PayPal. Those details stay with PayPal.
3. Use PayPal's business donation/support-link setup. Set the project name, logo and preferred currency, and describe what contributions will fund.
4. Copy the resulting public HTTPS payment/support URL. Open it separately and verify the displayed recipient, currency and project name before publishing it.
5. Edit `src/config/app-config.js`:

```js
donations: {
  url: 'PASTE_YOUR_VERIFIED_HTTPS_LINK_HERE',
  provider: 'PayPal',
  recipient: 'Mark Brezina',
  channels: [
    { provider: 'GoFundMe', label: 'Contribute to the server fund', url: '' },
    { provider: 'Patreon', label: 'Become a monthly supporter', url: '' }
  ]
}
```

6. Publish through your normal GitHub Pages workflow. Open Support from the lobby/results screen and verify that the link reaches the intended provider page. Check the receipt/payout process using PayPal's own verification/testing guidance before promoting it.

The URL above is deliberately a placeholder; it will remain hidden until replaced with a valid HTTPS link. The provider processes the payment into the verified receiving account; the game only opens the payment page. No PayPal API, backend payment handler or bank details are needed in this static site. Creating a PayPal account without adding its payment URL does not connect donations to the app.

Suggested payment-page description:

> Support Tomorrow Markets. Your contribution helps fund dedicated hosting and a domain, database services and faster loading, and room for more players in trading lobbies. These are planned improvements to the project.

## GoFundMe or Patreon later

For GoFundMe, create an individual/business fundraiser, set the intended beneficiary and complete transfer verification, explain the infrastructure budget, and copy the public campaign URL into the GoFundMe channel. Use actual supplier estimates to choose the target; no arbitrary target has been added to the game. The Support dialog links to the fundraiser; it does not claim to know the live amount raised.

For Patreon, create the creator page, set up payout verification and the memberships you intend to maintain, then paste the public creator/membership URL into the Patreon channel. Blank channels remain hidden. You can instead make either provider the primary `url`/`provider`; the game does not require PayPal.

Account creation, identity verification, bank connection and provider publication have not been performed in this source update. The receiving payment URL is the remaining configuration needed to activate the prepared button.

## Official provider references

- [PayPal UK: raising financial support for a business](https://www.paypal.com/uk/cshelp/article/how-do-i-raise-financial-support-for-my-business-help241)
- [GoFundMe UK pricing](https://www.gofundme.com/en-gb/c/pricing)
- [Patreon pricing](https://www.patreon.com/en-GB/pricing)
- [Patreon's standard plan for new creator pages](https://support.patreon.com/hc/en-gb/articles/36426991446797-A-standard-platform-fee-for-new-creators-effective-after-4-August-2025)
