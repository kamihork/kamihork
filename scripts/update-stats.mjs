// Generates stats-card.svg from GitHub GraphQL data.
//
// Contribution counts are snapshotted into stats-data.json and merged
// monotonically (per-year max), so numbers recorded while a member of an
// organization survive leaving it — the GitHub API alone would forget them.
//
// Usage: STATS_PAT=<token> node scripts/update-stats.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const LOGIN = "kamihork";
const TOKEN = process.env.STATS_PAT;
if (!TOKEN) {
  console.error("STATS_PAT is not set");
  process.exit(1);
}

const DATA_FILE = "stats-data.json";
const CARD_FILE = "stats-card.svg";

// ---- palette (matches profile-card.svg) ----
const INK = "#3B3833";
const PAPER_TOP = "#FBF3E2";
const PAPER_BOTTOM = "#EADCC0";

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": LOGIN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

// ---- fetch: account creation year ----
const { user: userInfo } = await gql(
  `query($login: String!) { user(login: $login) { createdAt } }`,
  { login: LOGIN },
);
const firstYear = new Date(userInfo.createdAt).getUTCFullYear();
const currentYear = new Date().getUTCFullYear();

// ---- fetch: contributions per calendar year (restricted = private/org) ----
const years = {};
for (let y = firstYear; y <= currentYear; y++) {
  const { user } = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
        }
      }
    }`,
    { login: LOGIN, from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` },
  );
  const c = user.contributionsCollection;
  years[y] =
    c.totalCommitContributions +
    c.totalIssueContributions +
    c.totalPullRequestContributions +
    c.totalPullRequestReviewContributions +
    c.restrictedContributionsCount;
}

// ---- fetch: top languages across owned repos ----
const { user: langUser } = await gql(
  `query($login: String!) {
    user(login: $login) {
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
        nodes {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name } }
          }
        }
      }
    }
  }`,
  { login: LOGIN },
);
const langBytes = {};
for (const repo of langUser.repositories.nodes) {
  for (const e of repo.languages.edges) {
    langBytes[e.node.name] = (langBytes[e.node.name] ?? 0) + e.size;
  }
}
const totalBytes = Object.values(langBytes).reduce((a, b) => a + b, 0) || 1;
const topLangs = Object.entries(langBytes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([name, size]) => ({ name, pct: (size / totalBytes) * 100 }));

// ---- merge with snapshot (monotonic per year) ----
let saved = { years: {} };
if (existsSync(DATA_FILE)) saved = JSON.parse(readFileSync(DATA_FILE, "utf8"));
for (const [y, n] of Object.entries(years)) {
  saved.years[y] = Math.max(saved.years[y] ?? 0, n);
}
saved.topLangs = topLangs;
saved.updatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(DATA_FILE, JSON.stringify(saved, null, 2) + "\n");

// ---- render SVG ----
const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Reuse the handwriting font embedded in profile-card.svg so both cards match.
let fontFace = "";
if (existsSync("profile-card.svg")) {
  const m = readFileSync("profile-card.svg", "utf8").match(
    /@font-face\{[^}]*\}/,
  );
  if (m) fontFace = m[0];
}
const HAND = "'Caveat',cursive";
const MONO = "ui-monospace,Menlo,monospace";

const W = 960;
const H = 420;
let yearList = Object.keys(saved.years).sort();
// trim leading years with no activity
while (yearList.length > 1 && saved.years[yearList[0]] === 0) yearList.shift();
const thisYearTotal = saved.years[currentYear] ?? 0;
const allTimeTotal = Object.values(saved.years).reduce((a, b) => a + b, 0);

// yearly bars: baseline-anchored, rounded data-end (top), 2px+ gaps
const chart = { x: 64, yTop: 268, yBase: 356, w: 440 };
const maxYear = Math.max(...Object.values(saved.years), 1);
const slot = chart.w / yearList.length;
const barW = Math.min(44, slot - 10);
let bars = "";
for (let i = 0; i < yearList.length; i++) {
  const y = yearList[i];
  const v = saved.years[y];
  const h = Math.max(3, (v / maxYear) * (chart.yBase - chart.yTop));
  const bx = chart.x + i * slot + (slot - barW) / 2;
  const by = chart.yBase - h;
  const r = Math.min(4, h);
  bars += `<path d="M${bx},${chart.yBase} L${bx},${by + r} Q${bx},${by} ${bx + r},${by} L${bx + barW - r},${by} Q${bx + barW},${by} ${bx + barW},${by + r} L${bx + barW},${chart.yBase} Z" fill="${INK}" fill-opacity="${y == currentYear ? 1 : 0.55}"/>`;
  bars += `<text x="${bx + barW / 2}" y="${chart.yBase + 20}" font-family="${MONO}" font-size="13" fill="${INK}" fill-opacity="0.6" text-anchor="middle">${y}</text>`;
  // selective value labels: current year and the all-time peak only
  if (y == currentYear || v === maxYear) {
    bars += `<text x="${bx + barW / 2}" y="${by - 8}" font-family="${MONO}" font-size="13" fill="${INK}" text-anchor="middle">${fmt(v)}</text>`;
  }
}

// top languages: thin horizontal bars, direct-labeled
const lg = { x: 580, y: 150, w: 240, rowH: 44 };
let langRows = "";
saved.topLangs.forEach((l, i) => {
  const ry = lg.y + i * lg.rowH;
  const bw = Math.max(4, (l.pct / saved.topLangs[0].pct) * lg.w);
  langRows += `<text x="${lg.x}" y="${ry}" font-family="${MONO}" font-size="16" fill="${INK}">${esc(l.name)}</text>`;
  langRows += `<text x="${lg.x + 316}" y="${ry}" font-family="${MONO}" font-size="14" fill="${INK}" fill-opacity="0.6" text-anchor="end">${l.pct.toFixed(1)}%</text>`;
  langRows += `<rect x="${lg.x}" y="${ry + 10}" width="${bw}" height="8" rx="4" fill="${INK}" fill-opacity="0.75"/>`;
});

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub activity: ${fmt(thisYearTotal)} contributions in ${currentYear}, ${fmt(allTimeTotal)} all-time">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${PAPER_TOP}"/>
      <stop offset="1" stop-color="${PAPER_BOTTOM}"/>
    </linearGradient>
  </defs>
  <style>${fontFace}</style>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="url(#paper)" stroke="${INK}" stroke-opacity="0.25" stroke-width="2"/>

  <text x="64" y="84" font-family="${HAND}" font-size="44" fill="${INK}">GitHub Activity</text>

  <text x="64" y="182" font-family="${HAND}" font-size="96" font-weight="700" fill="${INK}">${fmt(thisYearTotal)}</text>
  <text x="64" y="216" font-family="${MONO}" font-size="17" fill="${INK}" fill-opacity="0.7">contributions in ${currentYear} · incl. private &amp; org work</text>
  <text x="64" y="242" font-family="${MONO}" font-size="15" fill="${INK}" fill-opacity="0.6">${fmt(allTimeTotal)} total since ${yearList[0]}</text>

  <text x="${lg.x}" y="100" font-family="${HAND}" font-size="32" fill="${INK}">Top Languages</text>
  ${langRows}

  ${bars}

  <text x="${W - 40}" y="${H - 24}" font-family="${MONO}" font-size="12" fill="${INK}" fill-opacity="0.5" text-anchor="end">updated ${saved.updatedAt} · refreshed daily</text>
</svg>
`;
writeFileSync(CARD_FILE, svg);
console.log(
  `ok: ${currentYear}=${fmt(thisYearTotal)}, all-time=${fmt(allTimeTotal)}, langs=${topLangs.map((l) => l.name).join(",")}`,
);
