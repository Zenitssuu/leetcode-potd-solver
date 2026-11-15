import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const FILE = path.join(DATA_DIR, "cookies.json");
export const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
fs.mkdirSync(DATA_DIR, { recursive: true });

const envSession = process.env.LEETCODE_SESSION ?? "";
const envCsrf = process.env.LEETCODE_CSRF ?? "";

// Start from env, then prefer the saved file unless the env value was changed since.
let auth = { session: envSession, csrf: envCsrf, fromEnv: envSession };
try {
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const envChanged = envSession && envSession !== saved.fromEnv;
  if (saved.session && saved.csrf && !envChanged) auth = saved;
} catch {
  /* no saved cookies yet */
}

function persist() {
  fs.writeFileSync(FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}
persist();

export const getAuth = () => auth;

export function setAuth({ session, csrf }) {
  let changed = false;
  if (session && session !== auth.session) { auth.session = session; changed = true; }
  if (csrf && csrf !== auth.csrf) { auth.csrf = csrf; changed = true; }
  if (changed) persist();
  return changed;
}

/** Pick up renewed cookies LeetCode sends back on any response. */
export function captureSetCookies(res) {
  const list = res.headers.getSetCookie?.() ?? [];
  const found = {};
  for (const c of list) {
    const m = c.match(/^(LEETCODE_SESSION|csrftoken)=([^;]*)/);
    if (m && m[2]) found[m[1] === "csrftoken" ? "csrf" : "session"] = m[2];
  }
  if (found.session || found.csrf) setAuth(found);
}

/** LEETCODE_SESSION is a JWT; return its expiry in ms (or null). */
export function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function loadPlaywright() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    throw new Error("playwright is not installed (run: npm i playwright && npx playwright install chromium)");
  }
}

/** Launch the persistent profile in real Chrome (falls back to bundled Chromium). */
async function launch(headless) {
  const chromium = await loadPlaywright();
  const opts = {
    headless,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
  const channel = process.env.BROWSER_CHANNEL ?? "chrome"; // set to "chromium" to force bundled
  if (channel === "chromium") return chromium.launchPersistentContext(PROFILE_DIR, opts);
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel });
  } catch (e) {
    console.warn(`Could not start "${channel}" (${e.message.split("\n")[0]}); using bundled Chromium.`);
    return chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

export async function saveCookiesFromContext(ctx) {
  const cookies = await ctx.cookies("https://leetcode.com");
  const session = cookies.find((c) => c.name === "LEETCODE_SESSION")?.value;
  const csrf = cookies.find((c) => c.name === "csrftoken")?.value;
  if (!session) throw new Error("Browser profile is not logged in to LeetCode");
  setAuth({ session, csrf });
  return { session, csrf };
}

/** Reopen the saved browser profile headless and re-read cookies. */
export async function refreshViaBrowser() {
  const ctx = await launch(true);
  try {
    const page = await ctx.newPage();
    await page.goto("https://leetcode.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000); // let the site refresh cookies
    return await saveCookiesFromContext(ctx);
  } finally {
    await ctx.close();
  }
}

export async function interactiveLogin() {
  const ctx = await launch(false);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://leetcode.com/accounts/login/");
    console.log("Log in to LeetCode in the opened browser window (5 min timeout)...");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const cookies = await ctx.cookies("https://leetcode.com");
      if (cookies.some((c) => c.name === "LEETCODE_SESSION" && c.value)) {
        await page.waitForTimeout(3000);
        await saveCookiesFromContext(ctx);
        console.log("Logged in. Cookies saved to", FILE);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Timed out waiting for login");
  } finally {
    await ctx.close();
  }
}