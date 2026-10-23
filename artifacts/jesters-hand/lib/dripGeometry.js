// Shared, deterministic blood-drip geometry. Used by components/BloodDrip.tsx
// (live SVG) and scripts/drips/composite.mjs (baked into frame PNGs).
function rng(seed) {
  let s = (seed * 9301 + 49297) % 233280 || 1;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}
/** Returns { body, drops:[{x,w,L}] , band } for a W x H box. */
function buildDrip(W, H, seed = 1, count) {
  const r = rng(seed);
  const band = Math.max(2, H * 0.14);
  const n = count || Math.max(3, Math.round(W / (H * 0.9)));
  const drops = [];
  for (let i = 0; i < n; i++) {
    const slot = W / n;
    const w = Math.max(3, Math.min(slot * 0.5, H * (0.16 + r() * 0.1)));
    const x = slot * (i + 0.5) + (r() - 0.5) * slot * 0.35;
    // irregular, controlled lengths: one long, others short/medium
    const L = band + (H - band - w * 0.5) * (0.25 + r() * 0.75) * (i % 3 === 1 ? 1 : 0.62);
    drops.push({ x, w, L: Math.max(band + w, L) });
  }
  let d = `M0,0 L${W},0 L${W},${band * 0.4} `;
  let cx = W;
  for (let i = drops.length - 1; i >= 0; i--) {
    const { x, w, L } = drops[i];
    const right = x + w / 2, left = x - w / 2, rr = w * 0.42;
    d += `Q${(cx + right) / 2},${band * 1.25} ${right + w * 0.4},${band} `;
    d += `C${right},${band} ${x + w * 0.22},${band + (L - band) * 0.4} ${x + rr * 0.72},${L - rr * 1.1} `;
    d += `A${rr},${rr} 0 1 1 ${x - rr * 0.72},${L - rr * 1.1} `;
    d += `C${x - w * 0.22},${band + (L - band) * 0.4} ${left},${band} ${left - w * 0.4},${band} `;
    cx = left - w * 0.4;
  }
  d += `Q${cx / 2},${band * 0.6} 0,${band * 0.5} Z`;
  return { body: d, drops, band };
}
/** Full standalone SVG string (for rasterizing with magick). */
function dripSvg(W, H, seed, count) {
  const { body, drops, band } = buildDrip(W, H, seed, count);
  const hl = drops.map(({ x, w, L }) => {
    const rr = w * 0.42;
    return `<ellipse cx="${x - rr * 0.32}" cy="${L - rr * 1.25}" rx="${rr * 0.22}" ry="${rr * 0.34}" fill="#ffd9d0" opacity="0.38"/>` +
      `<path d="M${x - w * 0.12},${band * 1.2} L${x - w * 0.1},${L - rr * 2.1}" stroke="#ff9c8c" stroke-opacity="0.16" stroke-width="${w * 0.1}" stroke-linecap="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a0408"/><stop offset="0.35" stop-color="#6a0a12"/><stop offset="1" stop-color="#4a050b"/></linearGradient>
</defs>
<path d="${body}" transform="translate(${W * 0.006},${H * 0.03})" fill="#000" opacity="0.5"/>
<path d="${body}" fill="url(#v)" stroke="#1e0204" stroke-width="${Math.max(1, H * 0.012)}"/>
<path d="${body}" fill="none" stroke="#a3141f" stroke-opacity="0.35" stroke-width="${Math.max(0.6, H * 0.006)}" transform="translate(${-H * 0.004},${-H * 0.004})"/>
${hl}
</svg>`;
}
module.exports = { buildDrip, dripSvg };
