// Browser tests for "Min huskeseddel", everyone's own note at the bottom of
// "Luk ned": written, ticked off, copied for an sms, kept per person on the
// server and on the phone (offline too). Against ticks-server.mjs: the real
// /api/note on the local Postgres.
import postgres from "postgres";
import { DATABASE_URL, baseUrl, createChecks, launchBrowser, screenshotPath, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8935);
const { check, finish } = createChecks();
const db = postgres(DATABASE_URL, { onnotice: () => {} });
await db`delete from notes`;
await db`delete from members where user_id in ('user-a', 'user-b', 'user-c')`;
await db`insert into members (user_id, role) values ('user-c', 'blocked')`;

const pageErrors = [];
const browser = await launchBrowser();
async function phone(user, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  if (user) await context.addCookies([{ name: "eb_test_user", value: user, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(user + ": " + e));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/", { waitUntil: "load" });
  return { context, page };
}
async function until(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What the server has for someone, items as [text, done].
const saved = async (user) => {
  const row = (await db`select items from notes where user_id = ${user}`)[0];
  return row ? row.items.map((it) => [it.text, it.done]) : null;
};

try {
  // ---- signed out: an invitation to sign in, nothing to write in ----
  const out = await phone(null, { serviceWorkers: "block" });
  await out.page.locator("#note-signed-out").waitFor({ state: "visible" });
  check("signed out, the note asks you to sign in",
    await out.page.locator("#note").isVisible() && !(await out.page.locator("#note-body").isVisible())
    && (await out.page.locator("#note-signed-out").textContent()).includes("for at skrive din egen huskeseddel"));
  await out.page.locator("#note-signed-out button").click();
  check("...and its 'Log ind' opens the sign-in", await out.page.locator("#auth-dialog").evaluate((d) => d.open));
  await out.context.close();

  // ---- signed in: write, tick, keep ----
  const a = await phone("user-a"); // service worker allowed: the offline steps need it
  await a.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const pa = a.page;
  const rows = () => pa.locator("#note-list .task-item");
  const items = () => pa.$$eval("#note-list .task-item", (els) => els.map((li) => [li.querySelector("label").textContent, li.querySelector("input").checked]));
  const status = () => pa.locator("#note-status").textContent();
  const input = pa.locator("#note-input");

  await pa.locator("#note-body").waitFor({ state: "visible" });
  check("signed in, the note sits at the bottom of 'Luk ned', under the list",
    await pa.locator("#luk #note").isVisible() && await pa.locator("#note-title").textContent() === "Min huskeseddel"
    && await pa.locator("#note").evaluate((n) => !!(document.getElementById("luk-list").compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)));
  check("...says it's private", (await pa.locator("#note-body .note-sub").textContent()) === "Kun du kan se den.");
  check("an empty note has a hint and nothing to copy or clear",
    await pa.locator("#note-empty").isVisible() && await pa.locator("#note-actions").isHidden() && await pa.locator("#note-clear").isHidden());

  await input.fill("Kaffe");
  await input.press("Enter");
  await input.fill("  Toilet   papir ");
  await pa.locator('.note-add button:has-text("Tilføj")').click();
  await input.fill("   ");
  await input.press("Enter");
  check("Enter or 'Tilføj' adds a point; spaces are tidied, a blank one isn't added",
    same(await items(), [["Kaffe", false], ["Toilet papir", false]]), await items());
  check("...the field empties and keeps the cursor for the next one",
    await input.inputValue() === "" && await pa.evaluate(() => document.activeElement.id) === "note-input");
  check("...and the hint gives way to copy and clear",
    await pa.locator("#note-empty").isHidden() && await pa.locator("#note-actions").isVisible() && await pa.locator("#note-clear").isVisible());

  await rows().nth(0).click();
  const kaffe = rows().nth(0);
  check("tapping a point ticks it", await kaffe.locator("input").isChecked() && (await kaffe.getAttribute("class")).includes("completed"));
  await sleep(500); // the line is drawn through over 0.4 s
  const strike = await kaffe.locator("label").evaluate((l) => {
    const line = getComputedStyle(l, "::after");
    return { right: line.right, height: line.height, width: l.getBoundingClientRect().width };
  });
  check("...with a line through it, like the list above", strike.right === "0px" && strike.height === "2px", strike);
  await rows().nth(0).locator("label").click();
  check("tapping again unticks it", !(await kaffe.locator("input").isChecked()) && !(await kaffe.getAttribute("class")).includes("completed"));
  await rows().nth(0).locator("input").click();
  check("the box itself ticks it too", await kaffe.locator("input").isChecked());

  check("the note is saved to the account",
    await until(async () => same(await saved("user-a"), [["Kaffe", true], ["Toilet papir", false]])), await saved("user-a"));
  await pa.reload({ waitUntil: "load" });
  await rows().nth(1).waitFor();
  check("...and is there again after a reload, ticks and all", same(await items(), [["Kaffe", true], ["Toilet papir", false]]), await items());

  // ---- on to an sms ----
  const text = "Huskeseddel fra Enebakken:\n✓ Kaffe\n• Toilet papir";
  await pa.locator("#note-copy").click();
  const copied = await pa.evaluate(() => navigator.clipboard.readText());
  check("'Kopiér teksten' puts the note on the clipboard as sms-ready text", copied === text, copied);
  check("...and says so", await pa.locator("#note-copy").textContent() === "Kopieret ✓" && await status() === "Sæt teksten ind i en sms.");
  check("'Send som sms' opens a new sms with the same text in it",
    await pa.locator("#note-sms").getAttribute("href") === "sms:?&body=" + encodeURIComponent(text));

  // ---- removing, with a way back ----
  await input.fill("Mælk");
  await input.press("Enter");
  await rows().nth(1).locator(".note-remove").click();
  check("× removes a point", same(await items(), [["Kaffe", true], ["Mælk", false]]), await items());
  check("...and offers to undo it", (await status()).startsWith('"Toilet papir" er slettet.') && await pa.locator('#note-status button:has-text("Fortryd")').isVisible());
  await pa.locator('#note-status button:has-text("Fortryd")').click();
  check("'Fortryd' puts it back where it was", same(await items(), [["Kaffe", true], ["Toilet papir", false], ["Mælk", false]]), await items());
  check("...also on the server",
    await until(async () => same(await saved("user-a"), [["Kaffe", true], ["Toilet papir", false], ["Mælk", false]])), await saved("user-a"));

  await rows().nth(2).locator(".note-remove").click();
  await rows().nth(0).click();
  check("after another change, undo is no longer offered (it would undo that too)",
    (await status()) === "" && same(await items(), [["Kaffe", false], ["Toilet papir", false]]), { status: await status(), items: await items() });

  await pa.locator("#note-clear").click();
  check("'Ryd sedlen' empties the note", (await items()).length === 0 && await pa.locator("#note-empty").isVisible() && (await status()).startsWith("Sedlen er ryddet."));
  await pa.locator('#note-status button:has-text("Fortryd")').click();
  check("...and 'Fortryd' brings it all back", same(await items(), [["Kaffe", false], ["Toilet papir", false]]), await items());
  await until(async () => same(await saved("user-a"), [["Kaffe", false], ["Toilet papir", false]]));

  // A fetch of the note that was under way while a point was added, and
  // answers only after that point has been saved, must not wipe it out.
  await pa.route("**/api/note", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const stale = await route.fetch(); // the server's note as it is now...
    await sleep(1500);                 // ...handed over after the save below
    await route.fulfill({ response: stale });
  });
  const pulling = pa.evaluate(() => syncNote());
  await sleep(150);
  await input.fill("Lige nu");
  await input.press("Enter");
  await until(async () => (await saved("user-a")).some(([t]) => t === "Lige nu"));
  await pulling;
  await pa.unroute("**/api/note");
  check("a point added while the note was being fetched survives the late answer",
    same(await items(), [["Kaffe", false], ["Toilet papir", false], ["Lige nu", false]]), await items());
  await rows().nth(2).locator(".note-remove").click();
  await until(async () => same(await saved("user-a"), [["Kaffe", false], ["Toilet papir", false]]));

  // ---- no connection at the house ----
  await pa.evaluate(() => navigator.serviceWorker.ready);
  await a.context.setOffline(true);
  await input.fill("Batterier");
  await input.press("Enter");
  await sleep(1200);
  check("offline, a new point shows at once and is kept on the phone",
    same(await items(), [["Kaffe", false], ["Toilet papir", false], ["Batterier", false]])
    && await pa.evaluate(() => JSON.parse(localStorage.getItem("enebakken:note:user-a")).dirty === true)
    && same(await saved("user-a"), [["Kaffe", false], ["Toilet papir", false]]), { items: await items(), server: await saved("user-a") });
  await a.context.setOffline(false);
  check("back online, it reaches the server by itself",
    await until(async () => same(await saved("user-a"), [["Kaffe", false], ["Toilet papir", false], ["Batterier", false]])), await saved("user-a"));

  await a.context.setOffline(true);
  await pa.reload({ waitUntil: "load" });
  await rows().nth(2).waitFor({ timeout: 8000 }).catch(() => {});
  check("opened with no connection at all, the note is still there", same(await items(), [["Kaffe", false], ["Toilet papir", false], ["Batterier", false]]), await items());
  await input.fill("Tændstikker");
  await input.press("Enter");
  await rows().nth(1).click();
  await sleep(800);
  await a.context.setOffline(false);
  check("...can be written in, and catches up once online",
    await until(async () => same(await saved("user-a"), [["Kaffe", false], ["Toilet papir", true], ["Batterier", false], ["Tændstikker", false]]), 10000),
    await saved("user-a"));

  // ---- everyone has their own ----
  const b = await phone("user-b", { serviceWorkers: "block" });
  await b.page.locator("#note-body").waitFor({ state: "visible" });
  check("someone else signed in sees their own note, not yours", (await b.page.locator("#note-list .task-item").count()) === 0);
  await b.page.locator("#note-input").fill("Annas punkt");
  await b.page.locator("#note-input").press("Enter");
  check("...and writes in it without touching yours",
    await until(async () => same(await saved("user-b"), [["Annas punkt", false]]))
    && (await saved("user-a")).every(([t]) => t !== "Annas punkt"));
  await b.context.close();

  const c = await phone("user-c", { serviceWorkers: "block" });
  await c.page.locator("#note-blocked").waitFor({ state: "visible" });
  check("a blocked account is told why there's no note", await c.page.locator("#note-body").isHidden());
  await c.context.close();

  // ---- the note's boxes don't count towards the list being done ----
  const listItems = pa.locator("#luk-list .task-item");
  const n = await listItems.count();
  for (let i = 0; i < n; i++) await listItems.nth(i).click();
  check("ticking the whole list still sets off the confetti, unticked note points or not",
    await pa.evaluate(() => document.getElementById("confetti-layer").children.length > 0));

  await pa.locator("#note").scrollIntoViewIfNeeded();
  await pa.screenshot({ path: screenshotPath("note.png") });

  // ---- signing out leaves nothing personal behind ----
  await pa.locator('#account-bar button:has-text("Log ud")').click();
  await pa.locator("#note-signed-out").waitFor({ state: "visible" });
  check("signed out, the note is gone from the page", await pa.locator("#note-body").isHidden());
  check("...and from the phone",
    await pa.evaluate(() => localStorage.getItem("enebakken:note:user-a") === null && localStorage.getItem("enebakken:note-last") === null));
  check("...but kept on the account", (await saved("user-a")).length === 4);

  check("no page errors", pageErrors.length === 0, pageErrors);
} finally {
  await browser.close();
  await db`delete from notes`;
  await db`delete from checklist_ticks`;
  await db`delete from members where user_id in ('user-a', 'user-b', 'user-c')`;
  await db.end();
}
finish();
