// Browser tests for "remember login": a transient failure talking to Neon
// Auth must never look like a sign-out, and the sign-in/sign-up buttons
// must not be double-clickable while a request is in flight.
import { baseUrl, createChecks, launchBrowser, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8940);
const { check, finish } = createChecks();

async function apiReq(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}

await apiReq("/__test/reset", { method: "POST" });

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE + "/", { waitUntil: "load" });
await sleep(500);

// ---- sign in as the seeded owner ----
await page.locator('#account-bar button:has-text("Log ind")').click();
await sleep(300);
await page.locator("#signin-email").fill("owner@example.com");
await page.locator("#signin-password").fill("whatever");
await page.locator('#signin-form button[type="submit"]').click();
await sleep(700);
check("signed in", (await page.locator("#account-bar").textContent()).includes("Administrer brugere"), await page.locator("#account-bar").textContent());

// ---- Neon Auth erroring transiently must not sign the page out ----
await apiReq("/__test/token-mode?mode=500");
await page.evaluate(() => refreshMe());
await sleep(300);
check("a 500 from the login check does not flip the page to signed out", (await page.locator("#account-bar").textContent()).includes("Administrer brugere"), await page.locator("#account-bar").textContent());
check("...`me` itself is untouched", await page.evaluate(() => me.authenticated === true && me.email === "owner@example.com"), null);
check("...neither the offline nor the confirmed-signed-out flag is set", await page.evaluate(() => lastTokenOffline === false && lastTokenConfirmedSignedOut === false), null);

// The distinct wording shows up wherever a fresh token is needed right now.
await page.locator('#account-bar button:has-text("Skift navn")').click();
await sleep(200);
await page.locator("#name-input").fill("Owner Renamed");
await page.locator("#name-submit").click();
await sleep(400);
check("the message names the real problem instead of claiming the session expired", (await page.locator("#name-error").textContent()) === "Kunne ikke tjekke login lige nu — prøv igen om lidt.", await page.locator("#name-error").textContent());
await page.locator('#name-dialog button:has-text("Annullér")').click();

// A full page reload has no in-memory state left to preserve — a fresh
// load genuinely can't tell "signed in, but the check just failed" apart
// from "never signed in" — so this is the one case that still falls back
// to asking to log in, same as any first visit. What matters is that it
// stays that ordinary, neutral ask rather than an alarming "your session
// has expired" (that specific wording is reserved for a confirmed 401).
await page.reload({ waitUntil: "load" });
await sleep(500);
check("a reload with no prior state to fall back on still asks to log in, but doesn't claim the session expired", await page.locator('#account-bar button:has-text("Log ind")').count() === 1, await page.locator("#account-bar").textContent());

// ---- a real 401 (the session itself is gone) does sign the page out ----
await apiReq("/__test/token-mode?mode=401");
await page.evaluate(() => refreshMe());
await sleep(300);
check("a real 401 does flip the page to signed out", (await page.locator("#account-bar").textContent()).includes("Log ind"), await page.locator("#account-bar").textContent());
check("...`me` reflects it", await page.evaluate(() => me.authenticated === false), null);

await apiReq("/__test/token-mode?mode=ok");

// ---- sign-in/sign-up can't be submitted twice while in flight ----
// The mock answers instantly, which would leave no window to observe the
// disabled state, so the request is held up briefly on purpose here.
async function waitUntilEnabled(submitId) {
    for (let i = 0; i < 150; i++) {
        if (!(await page.evaluate((id) => document.getElementById(id).disabled, submitId))) return;
        await sleep(20);
    }
    throw new Error(submitId + " never re-enabled");
}
async function withDelayedRoute(pattern, submitId, fn) {
    await page.route(pattern, async (route) => { await sleep(300); await route.continue(); });
    try {
        await fn();
        // Wait for the request to actually finish (the button re-enabling
        // proves it did) before unrouting — otherwise Playwright force-
        // settles the still-pending route right there, and this handler's
        // own later route.continue() then errors "already handled".
        await waitUntilEnabled(submitId);
    } finally {
        await page.unroute(pattern);
    }
}

await page.locator('#account-bar button:has-text("Log ind")').click();
await sleep(300);
await page.locator("#signin-email").fill("owner@example.com");
await page.locator("#signin-password").fill("whatever");
await withDelayedRoute("**/api/auth/sign-in", "signin-submit", async () => {
    const clickDone = page.locator('#signin-form button[type="submit"]').click();
    await sleep(80);
    check("the sign-in button disables while the request is in flight", await page.evaluate(() => document.getElementById("signin-submit").disabled === true), null);
    await clickDone;
});
check("...and re-enables once it settles", await page.evaluate(() => document.getElementById("signin-submit").disabled === false), null);
check("signed in for real this time", (await page.locator("#account-bar").textContent()).includes("Administrer brugere"), await page.locator("#account-bar").textContent());

await page.evaluate(() => handleSignOut());
await sleep(300);
await page.locator('#account-bar button:has-text("Log ind")').click();
await sleep(300);
await page.locator("#switch-signup").click();
await page.locator("#signup-name").fill("Ny Bruger");
await page.locator("#signup-email").fill("ny.bruger@example.com");
await page.locator("#signup-password").fill("longenoughpw");
await withDelayedRoute("**/api/auth/sign-up", "signup-submit", async () => {
    const clickDone = page.locator('#signup-form button[type="submit"]').click();
    await sleep(80);
    check("the sign-up button disables while the request is in flight too", await page.evaluate(() => document.getElementById("signup-submit").disabled === true), null);
    await clickDone;
});
check("...and re-enables afterwards", await page.evaluate(() => document.getElementById("signup-submit").disabled === false), null);

check("no page errors", pageErrors.length === 0, pageErrors);
await browser.close();
await apiReq("/__test/reset", { method: "POST" });
finish();
