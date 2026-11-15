/**
 * LeetCode POTD auto-solver server (Node 18+).
 *
 * Flow: fetch POTD -> editorial code -> community-solution code -> submit
 * candidates (capped) -> email the reason if nothing is accepted.
 *
 * NOTE: uses LeetCode's unofficial GraphQL/REST endpoints, which can change
 * without notice. Automated access may violate LeetCode's Terms of Service.
 * Use at your own risk, on your own account.
 */
import "dotenv/config";
import express from "express";
import cron from "node-cron";
import nodemailer from "nodemailer";
import { getAuth, captureSetCookies, jwtExpiry, refreshViaBrowser } from "./auth.js";

const BASE = "https://leetcode.com";

// ---- config (see .env.example) ----
const env = (k, d) => process.env[k] ?? d;
const need = (k) => {
  if (!process.env[k]) throw new Error(`Missing env var ${k}`);
  return process.env[k];
};

const LANG = env("LANG_SLUG", "python3"); // python3 | cpp | java
const MAX_ATTEMPTS = Number(env("MAX_ATTEMPTS", "3"));
const CRON_HOUR = Number(env("CRON_HOUR_UTC", "0")); // POTD flips at 00:00 UTC
const CRON_MIN = Number(env("CRON_MINUTE_UTC", "15"));
const NOTIFY_ON_SUCCESS = env("NOTIFY_ON_SUCCESS", "true") === "true";
const RUN_TOKEN = env("RUN_TOKEN", "");
const PORT = Number(env("PORT", "8080"));

const SMTP_USER = need("SMTP_USER");
const EMAIL_TO = env("EMAIL_TO", SMTP_USER);
const mailer = nodemailer.createTransport({
  host: env("SMTP_HOST", "smtp.gmail.com"),
  port: Number(env("SMTP_PORT", "465")),
  secure: Number(env("SMTP_PORT", "465")) === 465,
  auth: { user: SMTP_USER, pass: need("SMTP_PASS") }, // Gmail: App Password
});

const FENCE_ALIASES = {
  python3: ["python", "python3", "py"],
  cpp: ["cpp", "c++"],
  java: ["java"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- HTTP helpers ----
// Read cookies fresh on every request so refreshed ones are picked up immediately.
const headers = () => {
  const { session, csrf } = getAuth();
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    Cookie: `LEETCODE_SESSION=${session}; csrftoken=${csrf}`,
    "x-csrftoken": csrf,
    Origin: BASE,
    Referer: BASE,
    "Content-Type": "application/json",
  };
};

async function http(url, { method = "GET", body, referer } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers(), ...(referer ? { Referer: referer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  captureSetCookies(res); // persist any renewed cookie
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method} ${url}`);
  return res.json();
}

const Q_STATUS = `query { userStatus { isSignedIn username } }`;

/** Verify the session works; if not, refresh from the saved browser profile. */
async function ensureAuth() {
  const signedIn = async () => {
    try {
      return (await gql(Q_STATUS)).userStatus?.isSignedIn === true;
    } catch {
      return false;
    }
  };
  if (await signedIn()) return;
  log("Session invalid, trying browser-profile refresh...");
  try {
    await refreshViaBrowser();
  } catch (e) {
    throw new Error(`Session expired and auto-refresh failed (${e.message}). Run: npm run login`);
  }
  if (!(await signedIn())) {
    throw new Error("Session expired and refreshed cookies are still not valid. Run: npm run login");
  }
  log("Session refreshed OK.");
}

async function gql(query, variables = {}) {
  const data = await http(`${BASE}/graphql`, { method: "POST", body: { query, variables } });
  if (data.errors?.length) throw new Error(`GraphQL error: ${data.errors[0].message}`);
  return data.data;
}

// ---- queries ----
const Q_DAILY = `query { activeDailyCodingChallengeQuestion {
  date link question { questionId questionFrontendId title titleSlug status } } }`;

const Q_QUESTION = `query q($s:String!){ question(titleSlug:$s){
  questionId codeSnippets{ langSlug code } } }`;

const Q_EDITORIAL = `query e($s:String!){ question(titleSlug:$s){
  solution{ id canSeeDetail paidOnly content } } }`;

const Q_COMMUNITY_LIST = `query l($slug:String!,$orderBy:ArticleOrderByEnum,$userInput:String,
  $tags:[String!],$skip:Int,$first:Int){
  ugcArticleSolutionArticles(questionSlug:$slug,orderBy:$orderBy,userInput:$userInput,
    tagSlugs:$tags,skip:$skip,first:$first){
    edges{ node{ uuid title topicId } } } }`;

const Q_COMMUNITY_ARTICLE = `query a($id:ID){
  ugcArticleSolutionArticle(articleId:$id){ content } }`;

// ---- code extraction ----
function extractCode(markdown, lang) {
  const wanted = FENCE_ALIASES[lang] ?? [lang];
  const out = [];
  const re = /```([\w+#-]*)[^\n]*\n([\s\S]*?)```/g;
  for (const [, fenceLang, body] of (markdown ?? "").matchAll(re)) {
    if (wanted.includes(fenceLang.toLowerCase()) && body.includes("class Solution")) {
      out.push(body.replace(/^\n+|\n+$/g, ""));
    }
  }
  return out;
}

async function editorialCandidates(slug, notes) {
  let sol;
  try {
    sol = (await gql(Q_EDITORIAL, { s: slug })).question.solution;
  } catch (e) {
    notes.push(`Editorial fetch failed: ${e.message}`);
    return [];
  }
  if (!sol) {
    notes.push("No editorial exists for this problem.");
    return [];
  }
  if (sol.paidOnly && !sol.canSeeDetail) {
    notes.push("Editorial is premium-only and this account can't view it.");
    return [];
  }
  const codes = extractCode(sol.content, LANG);
  if (!codes.length) notes.push(`Editorial has no full-class '${LANG}' code block.`);
  return codes;
}

async function communityCandidates(slug, notes, limit = 5) {
  let edges;
  try {
    const d = await gql(Q_COMMUNITY_LIST, {
      slug, orderBy: "HOT", userInput: "", tags: [LANG], skip: 0, first: limit,
    });
    edges = d.ugcArticleSolutionArticles.edges;
  } catch (e) {
    notes.push(`Community solutions fetch failed: ${e.message}`);
    return [];
  }
  if (!edges?.length) {
    notes.push(`No community solutions found for '${LANG}'.`);
    return [];
  }
  const codes = [];
  for (const { node } of edges) {
    try {
      const art = (await gql(Q_COMMUNITY_ARTICLE, { id: node.uuid })).ugcArticleSolutionArticle;
      const found = extractCode(art?.content, LANG);
      if (found.length) codes.push(found[0]); // first matching block per post
    } catch (e) {
      log(`article ${node.uuid} failed: ${e.message}`);
    }
    await sleep(rand(1000, 2000));
  }
  if (!codes.length) notes.push("Community posts had no usable full-class code block.");
  return codes;
}

// ---- your own previous accepted submission ----
const Q_SUBMISSIONS = `query s($offset:Int!,$limit:Int!,$questionSlug:String!){
  questionSubmissionList(offset:$offset,limit:$limit,questionSlug:$questionSlug){
    submissions{ id statusDisplay lang langName timestamp } } }`;

const Q_SUBMISSION_DETAIL = `query d($submissionId:Int!){
  submissionDetails(submissionId:$submissionId){ code lang{ name } statusCode } }`;

async function previousAcceptedCode(slug, notes) {
  try {
    const list = (await gql(Q_SUBMISSIONS, { offset: 0, limit: 20, questionSlug: slug }))
      .questionSubmissionList.submissions;
    const accepted = (list ?? []).filter((s) => s.statusDisplay === "Accepted");
    if (!accepted.length) {
      notes.push("Marked solved, but no Accepted submission found in your last 20 for this problem.");
      return null;
    }
    // prefer the configured language, otherwise the newest accepted one
    const pick = accepted.find((s) => s.lang === LANG) ?? accepted[0];
    const d = (await gql(Q_SUBMISSION_DETAIL, { submissionId: Number(pick.id) })).submissionDetails;
    if (!d?.code) {
      notes.push("Could not read code of your previous accepted submission.");
      return null;
    }
    return { code: d.code, lang: d.lang?.name ?? pick.lang };
  } catch (e) {
    notes.push(`Could not fetch your previous submission: ${e.message}`);
    return null;
  }
}

// ---- submit ----
async function submit(slug, qid, code, lang = LANG) {
  const referer = `${BASE}/problems/${slug}/`;
  const { submission_id } = await http(`${BASE}/problems/${slug}/submit/`, {
    method: "POST",
    referer,
    body: { lang, question_id: String(qid), typed_code: code },
  });
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const res = await http(`${BASE}/submissions/detail/${submission_id}/check/`, { referer });
    if (res.state === "SUCCESS") return res.status_msg ?? "Unknown";
  }
  return "Timed out waiting for judge";
}

// ---- email ----
async function sendEmail(subject, text) {
  await mailer.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject, text });
  log("Email sent:", subject);
}

// ---- main job ----
let running = false;

async function solvePotd() {
  if (running) return { status: "busy" };
  running = true;
  const notes = [];
  try {
    await ensureAuth();
    const daily = (await gql(Q_DAILY)).activeDailyCodingChallengeQuestion;
    const q = daily.question;
    const slug = q.titleSlug;
    const title = `${q.questionFrontendId}. ${q.title}`;
    log(`POTD ${daily.date}: ${title}`);

    const qid = (await gql(Q_QUESTION, { s: slug })).question.questionId;

    let attempts = 0;
    const verdicts = [];

    // Already solved before: resubmit your own accepted code instead of skipping.
    if (q.status === "ac") {
      const prev = await previousAcceptedCode(slug, notes);
      if (prev) {
        attempts++;
        const verdict = await submit(slug, qid, prev.code, prev.lang);
        verdicts.push(`resubmit of your previous code (${prev.lang}): ${verdict}`);
        log(`Resubmission (${prev.lang}): ${verdict}`);
        if (verdict === "Accepted") {
          if (NOTIFY_ON_SUCCESS) {
            await sendEmail(
              `[LeetCode] POTD resubmitted: ${title}`,
              `Your previous accepted ${prev.lang} code was resubmitted and Accepted.\n${BASE}/problems/${slug}/`
            );
          }
          return { status: "resubmitted", problem: title, lang: prev.lang };
        }
        notes.push(`Resubmitting your previous code got "${verdict}"; falling back to editorial/community.`);
        await sleep(rand(5000, 10000));
      }
    }
    const sources = [
      ["editorial", editorialCandidates],
      ["community", communityCandidates],
    ];

    for (const [sourceName, getter] of sources) {
      if (attempts >= MAX_ATTEMPTS) break;
      for (const code of await getter(slug, notes)) {
        if (attempts >= MAX_ATTEMPTS) {
          notes.push(`Hit MAX_ATTEMPTS=${MAX_ATTEMPTS}.`);
          break;
        }
        attempts++;
        const verdict = await submit(slug, qid, code);
        verdicts.push(`${sourceName}: ${verdict}`);
        log(`Submission (${sourceName}): ${verdict}`);
        if (verdict === "Accepted") {
          if (NOTIFY_ON_SUCCESS) {
            await sendEmail(
              `[LeetCode] POTD solved: ${title}`,
              `Accepted via ${sourceName} solution.\n${BASE}/problems/${slug}/`
            );
          }
          return { status: "solved", problem: title, source: sourceName };
        }
        await sleep(rand(5000, 10000));
      }
    }

    const reason = notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- (no extra notes)";
    const tried = verdicts.length ? verdicts.map((v) => `- ${v}`).join("\n") : "- nothing was submitted";
    await sendEmail(
      `[LeetCode] POTD NOT solved: ${title}`,
      `Date: ${daily.date}\nProblem: ${BASE}/problems/${slug}/\n\n` +
        `Why it wasn't solved:\n${reason}\n\nSubmissions tried:\n${tried}\n`
    );
    return { status: "unsolved", problem: title, notes, verdicts };
  } catch (e) {
    console.error(e);
    try {
      await sendEmail(
        "[LeetCode] POTD job crashed",
        `${e.message}\n\nNotes so far:\n${notes.join("\n")}\n\n` +
          "If this is a 403/401, your cookies likely expired."
      );
    } catch (mailErr) {
      console.error("Could not send crash email", mailErr);
    }
    return { status: "error", error: e.message };
  } finally {
    running = false;
  }
}

// ---- server ----
const app = express();

app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post("/run", async (req, res) => {
  if (RUN_TOKEN && req.get("X-Run-Token") !== RUN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json(await solvePotd());
});

cron.schedule(
  `${CRON_MIN} ${CRON_HOUR} * * *`,
  async () => {
    await sleep(rand(0, 120000)); // small jitter
    await solvePotd();
  },
  { timezone: "UTC" }
);

// Daily check: refresh early if the session is close to expiring, warn if that didn't help.
async function watchExpiry() {
  try {
    const daysLeft = () => {
      const exp = jwtExpiry(getAuth().session);
      return exp ? (exp - Date.now()) / 86400000 : null;
    };
    let days = daysLeft();
    if (days === null) return;
    if (days < 5) {
      try {
        await refreshViaBrowser();
      } catch (e) {
        log("Proactive refresh failed:", e.message);
      }
      days = daysLeft();
    }
    if (days !== null && days < 3) {
      await sendEmail(
        "[LeetCode] Session expiring soon",
        `Your LeetCode session expires in about ${Math.max(days, 0).toFixed(1)} day(s) and auto-refresh didn't extend it.\n` +
          "Run `npm run login` on the server to log in again."
      );
    }
  } catch (e) {
    log("watchExpiry error:", e.message);
  }
}
cron.schedule("0 12 * * *", watchExpiry, { timezone: "UTC" });

app.listen(PORT, () => {
  log(`Server on :${PORT}, scheduled daily at ${String(CRON_HOUR).padStart(2, "0")}:${String(CRON_MIN).padStart(2, "0")} UTC`);
});