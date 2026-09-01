import React from 'react';
import { ScrollViewStyleReset } from 'expo-router/html';

// Custom web HTML shell (used by `expo export --platform web` and the dev
// server). Adds the PWA manifest + crisp home-screen icons so saving the
// site to a phone home screen installs it like an app with a sharp icon.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />
        <title>Jester&apos;s Hand</title>

        {/* PWA install + home-screen icons */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#0D0900" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Jester's Hand" />

        <ScrollViewStyleReset />
        {/* Lock mobile-web rubber-band overscroll: the app root handles its
            own scrolling, so the page itself must never bounce or pull-to-
            refresh out from under it. */}
        <style
          dangerouslySetInnerHTML={{
            __html:
              'html,body{overscroll-behavior:none;overflow:hidden;height:100%;touch-action:pan-x pan-y;}' +
              '#root{height:100%;overflow:hidden;}',
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
