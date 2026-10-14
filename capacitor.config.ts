import type { CapacitorConfig } from '@capacitor/cli';

// The app has a live Node/Socket.io backend (chat, games, coins — all
// real-time, server-driven), so this is NOT a static-bundle Capacitor app.
// `server.url` makes the native app a thin WebView shell that always loads
// the real, live site — same as opening it in a browser, just packaged as
// an installable .apk/.ipa with its own icon and no browser chrome. `public`
// (webDir) is only a required fallback Capacitor needs for its own tooling;
// it's never actually what loads on a device once server.url is set.
//
// IMPORTANT: when MiniPlatform moves off Render (e.g. to the DigitalOcean
// droplet, once that migration happens), update this URL to match — this is
// the ONE place a future hosting change needs to be reflected for the
// mobile app builds.
const config: CapacitorConfig = {
  appId: 'com.miniplatform.app',
  appName: 'MiniPlatform',
  webDir: 'public',
  server: {
    url: 'https://miniplatform.onrender.com',
    cleartext: false,
  },
};

export default config;
