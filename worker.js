/**
 * Stockify Image Proxy (subcode-first)
 * Supports:
 *   ?subcode=694062   (preferred)
 *   ?ean=3616479540274
 *   ?name=Salon%20Bas%20Lanka
 *   ?site=bringo.ma   (default)
 *   ?debug=1          (returns candidates)
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const site = url.searchParams.get("site") || "bringo.ma";
    const subcode = (url.searchParams.get("subcode") || "").trim();
    const ean = (url.searchParams.get("ean") || "").trim();
    const name = (url.searchParams.get("name") || "").trim();
    const debug = url.searchParams.has("debug");

    if (!subcode && !ean && !name) {
      return j({ error: "Provide subcode, ean or name." }, 400);
    }

    const tried = [];

    // 1) Try Subcode (Numéro du produit)
    if (subcode) {
      const r = await findByToken(site, subcode, html =>
        containsProductNumber(html, subcode)
      );
      tried.push(r.tried);
      if (r.ok) return j(r.payload(debug), 200);
    }

    // 2) Try EAN/Barcode
    if (ean && /^\d{12,14}$/.test(ean)) {
      const r = await findByToken(site, ean, html =>
        html.includes(ean)
      );
      tried.push(r.tried);
      if (r.ok) return j(r.payload(debug), 200);
    }

    // 3) Fallback: Name + fuzzy title check
    if (name) {
      const r = await findByName(site, name);
      tried.push(r.tried);
      if (r.ok) return j(r.payload(debug), 200);
    }

    return j({ imageUrl: null, productUrl: null, matchedBy: null, score: 0, tried }, 404);
  }
};

// ---------- Helpers ----------

async function findByToken(site, token, accept) {
  const q = `site:${site} ${token}`;
  const results = await ddgLinks(q);
  const tried = [];

  for (const candidate of results) {
    try {
      const res = await fetch(candidate, { headers: ua() });
      const html = await res.text();
      tried.push({ candidate, reason: "token", ok: res.ok });

      if (accept(html)) {
        const imageUrl = extractImage(candidate, html);
        if (imageUrl) {
          return okPayload({
            imageUrl,
            productUrl: candidate,
            matchedBy: "subcode/ean",
            score: 1.0,
            tried
          });
        }
      }
    } catch {}
  }
  return { ok: false, tried };
}

async function findByName(site, rawName) {
  const qName = cleanName(rawName);
  const q = `site:${site} ${qName}`;
  const results = await ddgLinks(q);
  const tried = [];

  let best = null;

  for (const candidate of results) {
    try {
      const res = await fetch(candidate, { headers: ua() });
      const html = await res.text();
      const title = extractTitle(html);
      const score = similarity(tokens(qName), tokens(title));
      tried.push({ candidate, title, score });

      if (score >= 0.6) {
        const imageUrl = extractImage(candidate, html);
        if (imageUrl) {
          best = { imageUrl, candidate, score };
          break;
        }
      }
    } catch {}
  }

  if (best) {
    return okPayload({
      imageUrl: best.imageUrl,
      productUrl: best.candidate,
      matchedBy: "name",
      score: best.score,
      tried
    });
  }
  return { ok: false, tried };
}

function okPayload({ imageUrl, productUrl, matchedBy, score, tried }) {
  return {
    ok: true,
    tried,
    payload(debug) {
      const body = { imageUrl, productUrl, matchedBy, score };
      if (debug) body.tried = tried;
      return body;
    }
  };
}

function containsProductNumber(html, num) {
  // Handles accents and various separators around the label
  const re = new RegExp(
    String.raw`(Num(?:é|e)ro\s+du\s+produit\s*:?\s*)?${escapeReg(num)}`,
    "i"
  );
  return re.test(html);
}

function extractImage(candidate, html) {
  // Prefer OpenGraph
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  let imageUrl = m && m[1];

  // Fallback: a likely product image
  if (!imageUrl) {
    m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*class=["'][^"']*(product|main|image|photo|picture)[^"']*["']/i);
    imageUrl = m && m[1];
  }
  if (!imageUrl) return null;

  // Fix relative
  if (imageUrl.startsWith("/")) {
    imageUrl = new URL(candidate).origin + imageUrl;
  }
  return imageUrl;
}

async function ddgLinks(query) {
  const u = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(u, { headers: ua() });
  const html = await res.text();

  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/gi)]
    .map(m => m[1])
    .map(url => (url.startsWith("//") ? "https:" + url : url))
    .map(url => {
      try {
        const u = new URL(url);
        if (u.hostname.includes("duckduckgo.com") && u.pathname.startsWith("/l/")) {
          const raw = u.searchParams.get("uddg");
          if (raw) return decodeURIComponent(raw);
        }
      } catch {}
      return url;
    })
    .filter(u2 => {
      try { return new URL(u2).hostname.includes("bringo.ma"); } catch { return false; }
    });

  // Return first 8 candidates to keep it fast
  return links.slice(0, 8);
}

function cleanName(n) {
  return String(n)
    .replace(/\bGD\d{3,}\b/gi, " ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s) {
  return cleanName(s).toLowerCase().split(/\s+/).filter(Boolean);
}
function similarity(a, b) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const den = Math.max(1, Math.sqrt(A.size * B.size));
  return inter / den; // 0..1
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1]) return og[1];
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? t[1] : "";
}

function ua() {
  return { "User-Agent": "Mozilla/5.0 (compatible; Stockify/1.1)" };
}
function j(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=604800"
    }
  });
}
function escapeReg(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
