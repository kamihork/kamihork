// Generates stats-card.svg and top-langs-card.svg using the official
// github-readme-stats renderers (from the kamihork/github-readme-stats fork),
// fed with locally-snapshotted numbers.
//
// Why not use github-readme-stats directly? The user's main activity lives in
// an organization's private repos, which the API only exposes as
// restrictedContributionsCount — and forgets entirely if they leave the org.
// So contribution counts are snapshotted into stats-data.json and merged
// monotonically (per-year max): recorded numbers never decrease.
//
// Usage: STATS_PAT=<token> [GRS_DIR=path/to/github-readme-stats] node scripts/update-stats.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOGIN = "kamihork";
const TOKEN = process.env.STATS_PAT;
if (!TOKEN) {
  console.error("STATS_PAT is not set");
  process.exit(1);
}

const GRS_DIR = resolve(process.env.GRS_DIR ?? "../github-readme-stats");
const { renderStatsCard } = await import(
  pathToFileURL(join(GRS_DIR, "src/cards/stats.js"))
);
const { renderTopLanguages } = await import(
  pathToFileURL(join(GRS_DIR, "src/cards/top-languages.js"))
);
const { calculateRank } = await import(
  pathToFileURL(join(GRS_DIR, "src/calculateRank.js"))
);

const DATA_FILE = "stats-data.json";

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

// ---- fetch: profile, all-time visible counters, stars, languages ----
const { user } = await gql(
  `query($login: String!) {
    user(login: $login) {
      name
      createdAt
      followers { totalCount }
      pullRequests(first: 1) { totalCount }
      openIssues: issues(states: OPEN) { totalCount }
      closedIssues: issues(states: CLOSED) { totalCount }
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
      reviews: contributionsCollection { totalPullRequestReviewContributions }
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
        nodes {
          stargazers { totalCount }
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`,
  { login: LOGIN },
);

const firstYear = new Date(user.createdAt).getUTCFullYear();
const currentYear = new Date().getUTCFullYear();

// ---- fetch: contributions per calendar year (restricted = private/org) ----
const years = {};
for (let y = firstYear; y <= currentYear; y++) {
  const data = await gql(
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
  const c = data.user.contributionsCollection;
  years[y] =
    c.totalCommitContributions +
    c.totalIssueContributions +
    c.totalPullRequestContributions +
    c.totalPullRequestReviewContributions +
    c.restrictedContributionsCount;
}

const totalStars = user.repositories.nodes.reduce(
  (a, r) => a + r.stargazers.totalCount,
  0,
);

const langs = {};
for (const repo of user.repositories.nodes) {
  for (const e of repo.languages.edges) {
    const l = (langs[e.node.name] ??= {
      name: e.node.name,
      color: e.node.color ?? "#858585",
      size: 0,
    });
    l.size += e.size;
  }
}

// ---- merge with snapshot (monotonic: recorded numbers never decrease) ----
let saved = { years: {}, allTime: {} };
if (existsSync(DATA_FILE)) saved = JSON.parse(readFileSync(DATA_FILE, "utf8"));
saved.allTime ??= {};
for (const [y, n] of Object.entries(years)) {
  saved.years[y] = Math.max(saved.years[y] ?? 0, n);
}
const mono = (key, val) =>
  (saved.allTime[key] = Math.max(saved.allTime[key] ?? 0, val));
mono("stars", totalStars);
mono("prs", user.pullRequests.totalCount);
mono("issues", user.openIssues.totalCount + user.closedIssues.totalCount);
mono("contributedTo", user.repositoriesContributedTo.totalCount);
mono("followers", user.followers.totalCount);
mono("reviews", user.reviews.totalPullRequestReviewContributions);
saved.updatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(DATA_FILE, JSON.stringify(saved, null, 2) + "\n");

// All-time contributions, org/private work included (the snapshot's whole point).
const totalContributions = Object.values(saved.years).reduce((a, b) => a + b, 0);

// ---- render official cards ----
const rank = calculateRank({
  all_commits: true,
  commits: totalContributions,
  prs: saved.allTime.prs,
  issues: saved.allTime.issues,
  reviews: saved.allTime.reviews,
  repos: 0,
  stars: saved.allTime.stars,
  followers: saved.allTime.followers,
});

// hide zero-value rows so the card doesn't show a column of zeros
const hide = [];
if (saved.allTime.prs === 0) hide.push("prs");
if (saved.allTime.issues === 0) hide.push("issues");
if (saved.allTime.stars === 0) hide.push("stars");

const stats = {
  name: user.name || LOGIN,
  totalStars: saved.allTime.stars,
  totalCommits: totalContributions,
  totalPRs: saved.allTime.prs,
  totalIssues: saved.allTime.issues,
  totalReviews: saved.allTime.reviews,
  contributedTo: saved.allTime.contributedTo,
  rank,
};

// light + dark variants, swapped in the README via <picture>
for (const [suffix, theme] of [
  ["", "default"],
  ["-dark", "github_dark"],
]) {
  writeFileSync(
    `stats-card${suffix}.svg`,
    renderStatsCard(stats, {
      show_icons: true,
      hide_border: true,
      bg_color: "00000000",
      include_all_commits: true,
      custom_title: `${user.name || LOGIN}'s GitHub Stats`,
      hide,
      theme,
    }),
  );
  writeFileSync(
    `top-langs-card${suffix}.svg`,
    renderTopLanguages(langs, {
      layout: "compact",
      hide_border: true,
      bg_color: "00000000",
      theme,
    }),
  );
}

console.log(
  `ok: contributions(all-time, incl. org)=${totalContributions}, rank=${rank.level}, langs=${Object.keys(langs).length}`,
);
