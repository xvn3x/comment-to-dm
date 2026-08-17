export function privacyPolicyHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>Privacy Policy — Comment to DM</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17151f; background: #f6f5fa; }
    * { box-sizing: border-box; }
    body { margin: 0; line-height: 1.65; }
    main { width: min(820px, calc(100% - 32px)); margin: 48px auto; padding: 48px; background: #fff; border: 1px solid #e7e3f0; border-radius: 24px; box-shadow: 0 18px 60px rgba(42, 29, 75, .08); }
    h1, h2 { line-height: 1.2; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 7vw, 3.4rem); letter-spacing: -.04em; }
    h2 { margin-top: 36px; font-size: 1.2rem; }
    p, li { color: #514c5d; }
    .eyebrow { margin: 0 0 10px; color: #7047eb; font-size: .78rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    .updated { margin: 0 0 30px; color: #7d768b; }
    .notice { padding: 18px 20px; background: #f2efff; border-radius: 14px; color: #3b285f; }
    a { color: #6741d9; }
    footer { margin-top: 42px; padding-top: 22px; border-top: 1px solid #ece9f2; color: #7d768b; font-size: .9rem; }
    @media (max-width: 600px) { main { margin: 0; width: 100%; min-height: 100vh; padding: 32px 22px; border: 0; border-radius: 0; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Comment to DM</p>
    <h1>Privacy Policy</h1>
    <p class="updated">Effective date: August 18, 2026</p>

    <p class="notice"><strong>Comment to DM is self-hosted.</strong> Each installation is operated independently. The open-source project author does not receive or have access to the Instagram data processed by an installation.</p>

    <h2>1. Who controls the data</h2>
    <p>The person or organization operating this installation is the data controller. Privacy requests should be sent to that operator using the contact information associated with its Meta application.</p>

    <h2>2. Data processed</h2>
    <p>The application may process:</p>
    <ul>
      <li>the connected professional Instagram account ID and username;</li>
      <li>an Instagram OAuth access token, stored encrypted;</li>
      <li>comment, media and sender identifiers, and the commenter's public username;</li>
      <li>incoming Direct message and Story identifiers needed to prevent duplicate processing;</li>
      <li>quick-reply interaction identifiers and follower status when a rule requires a voluntary subscription check;</li>
      <li>whether and how many times a configured material link was opened;</li>
      <li>automation rules, delivery status and timestamps.</li>
    </ul>
    <p>Comment and incoming message text is evaluated in memory to match a rule and is not stored in the event journal. Link tracking stores the random automation event identifier, configured destination URL, delivery and first-opening times, and click count; it does not use cookies or third-party analytics. The application never asks for or stores an Instagram password.</p>

    <h2>3. How data is used</h2>
    <p>Data is used only to authenticate the connected account, receive Instagram webhook events, match comments and incoming messages against rules, optionally verify a subscription after the user taps a button, send configured public replies and private messages, measure configured material-link delivery and opening, cancel an enabled reminder after its material link is opened, prevent duplicate processing, display delivery history, and maintain security.</p>

    <h2>4. Storage and sharing</h2>
    <p>Data is stored in the database selected by the installation operator. Access tokens and Meta application secrets are encrypted at rest by the application. Data is sent to Meta only as needed to use the Instagram API and may be processed by the hosting and database providers selected by the operator. The application does not sell personal data or use it for advertising.</p>

    <h2>5. Retention</h2>
    <p>Delivery events are automatically removed after 30 days. OAuth state values expire after ten minutes. Account credentials remain until they expire, the account is disconnected, or a valid deletion request is processed.</p>

    <h2>6. Deletion and account disconnection</h2>
    <p>The operator can disconnect Instagram from the Comment to DM dashboard. Instagram users can also remove the application's access in Instagram settings. A valid Meta data-deletion request removes queued jobs, delivery events, automation rules, the stored access token and connected-account details from this installation.</p>

    <h2>7. Security</h2>
    <p>The application uses HTTPS, encrypted secret storage, signed sessions, webhook signature verification and limited administrative access. No internet-connected system can be guaranteed completely secure, so operators must also protect their hosting account, database and administrator password.</p>

    <h2>8. Children's privacy</h2>
    <p>The application is not directed to children and is intended for operators of professional Instagram accounts.</p>

    <h2>9. Changes</h2>
    <p>This policy may be updated when the application's data practices change. The effective date at the top of this page identifies the current version.</p>

    <footer>Comment to DM · Self-hosted Instagram automation</footer>
  </main>
</body>
</html>`;
}
