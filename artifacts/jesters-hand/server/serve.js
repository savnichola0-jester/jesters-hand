/**
 * Standalone production server for Expo static builds.
 *
 * Serves the output of build.js (static-build/) with two special routes:
 * - GET / or /manifest with expo-platform header → platform manifest JSON
 * - GET / without expo-platform → landing page HTML
 * Everything else falls through to static file serving from ./static-build/.
 *
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_ROOT = path.resolve(__dirname, '..', 'static-build');
const WEB_ROOT = path.join(STATIC_ROOT, 'web');
const TEMPLATE_PATH = path.resolve(__dirname, 'templates', 'landing-page.html');
const NATIVE_QR_PATH = path.resolve(__dirname, 'assets', 'jesters-hand-native-install-qr.png');
const EXPO_ANDROID_BUILD_URL =
  'https://expo.dev/accounts/00-00/projects/jesters-hand-native/builds/7e459da9-7f41-4d4d-ad71-40930aa2402b';
const basePath = (process.env.BASE_PATH || '/').replace(/\/+$/, '');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
};

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, '..', 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
    return appJson.expo?.name || 'App Landing Page';
  } catch {
    return 'App Landing Page';
  }
}

function serveManifest(platform, res) {
  const manifestPath = path.join(STATIC_ROOT, platform, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  const manifest = fs.readFileSync(manifestPath, 'utf-8');
  res.writeHead(200, {
    'content-type': 'application/json',
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
    'cache-control': 'no-cache',
  });
  res.end(manifest);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(html);
}

function resolveFile(root, urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(root, safePath);
  if (!filePath.startsWith(root)) return null;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory())
    return null;
  return filePath;
}

function cacheHeaderFor(filePath) {
  // Hashed bundle/asset files under _expo/static never change content for a
  // given name — cache them hard. Everything else (index.html, sw.js, icons,
  // manifest) must revalidate every load so members pick up new releases
  // immediately instead of running a stale cached app.
  if (filePath.includes(`${path.sep}_expo${path.sep}static${path.sep}`)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function sendFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': cacheHeaderFor(filePath),
  });
  res.end(content);
}

function serveStaticFile(urlPath, res) {
  // Native (Expo Go) bundles + assets live directly under static-build;
  // the browser app lives under static-build/web. Try both, then fall
  // back to the web app's index.html so client-side routes deep-link.
  const filePath =
    resolveFile(STATIC_ROOT, urlPath) || resolveFile(WEB_ROOT, urlPath);
  if (filePath) return sendFile(filePath, res);

  const webIndex = path.join(WEB_ROOT, 'index.html');
  if (path.extname(urlPath) === '' && fs.existsSync(webIndex)) {
    return sendFile(webIndex, res);
  }

  res.writeHead(404);
  res.end('Not Found');
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
const appName = getAppName();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/';
  }

  if (pathname === '/' || pathname === '/manifest') {
    const platform = req.headers['expo-platform'];
    if (platform === 'ios' || platform === 'android') {
      return serveManifest(platform, res);
    }
  }

  // Stable, engravable native-install route. Keep the public URL permanent;
  // only this redirect target needs to change after a future native build.
  if (pathname === '/install' || pathname === '/expo-go') {
    res.writeHead(302, {
      location: EXPO_ANDROID_BUILD_URL,
      'cache-control': 'no-cache',
    });
    return res.end();
  }

  if (pathname === '/native-install-qr.png') {
    if (fs.existsSync(NATIVE_QR_PATH)) return sendFile(NATIVE_QR_PATH, res);
    res.writeHead(404);
    return res.end('QR code not found');
  }

  // Browsers hitting the root get the actual web app.
  if (pathname === '/') {
    const webIndex = path.join(WEB_ROOT, 'index.html');
    if (fs.existsSync(webIndex)) {
      return sendFile(webIndex, res);
    }
    // No web build present — fall back to the old landing page.
    return serveLandingPage(req, res, landingPageTemplate, appName);
  }

  serveStaticFile(pathname, res);
});

const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port, '0.0.0.0', () => {
  console.log(`Serving static Expo build on port ${port}`);
});
