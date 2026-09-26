// Browser tests of the shared checklist: two (and more) "phones" as separate
// browser contexts against ticks_server.mjs (real handlers, local Postgres).
import postgres from "postgres";
import { DATABASE_URL, baseUrl, createChecks, launchBrowser, screenshotPath, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8935);
const db = postgres(DATABASE_URL, { onnotice: () => {} });
const { check, finish } = createChecks();
async function until(fn, timeout = 8000, step = 150) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

await db`delete from checklist_ticks`;
await db`update checklist_resets set reset_at = '-infinity'`;
await db`delete from members`;
await db`insert into members (user_id, role, display_name) values ('user-a', 'owner', 'Lars Sohl')`;
const luk = (await db`select label from checklist_items where list = 'luk' order by position`).map((r) => r.label);
const aaben = (await db`select label from checklist_items where list = 'aaben' order by position`).map((r) => r.label);

const browser = await launchBrowser();
const pageErrors = [];

async function phone(user, name) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: "block" });
  if (user) await context.addCookies([{ name: "eb_test_user", value: user, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(name + ": " + e));
  page.on("dialog", (d) => d.accept());
  page.ticksRequests = [];
  page.tokenRequests = 0;
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/ticks") page.ticksRequests.push({ at: Date.now(), method: r.method() });
    if (u.pathname === "/api/auth/token") page.tokenRequests++;
  });
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForSelector("#luk-list .task-item");
  if (user) await until(() => page.evaluate(() => ticksMode() === "shared"), 5000);
  return { context, page };
}

const state = (page, list) => page.evaluate((list) => Array.from(document.querySelectorAll("#" + list + "-list .task-item")).map((li) => ({
  label: li.dataset.label,
  checked: li.querySelector("input").checked,
  completed: li.classList.contains("completed"),
  by: li.querySelector(".tick-by").hidden ? null : li.querySelector(".tick-by").textContent,
})), list);
const item = async (page, list, label) => (await state(page, list)).find((x) => x.label === label);
const checkedLabels = async (page, list) => (await state(page, list)).filter((x) => x.checked).map((x) => x.label);
const tap = (page, list, label) => page.locator(`#${list}-list .task-item`, { hasText: label }).first().locator("label").click();
const switchTo = (page, tab) => page.locator(`button[aria-controls="${tab}"]`).click();
const TIME = "\\d{2}\\.\\d{2}";

const { page: A, context: ctxA } = await phone("user-a", "A");
const { page: B, context: ctxB } = await phone("user-b", "B");

// ---- live propagation, first names, "Dig" ----
await B.evaluate(() => document.querySelectorAll("#luk-list .task-item").forEach((li) => { li.__kept = true; }));
await tap(A, "luk", luk[0]);
let a0 = await item(A, "luk", luk[0]);
check("tap shows at once on the tapping phone, as 'Dig · tt.mm'", a0.checked && a0.completed && new RegExp("^Dig · " + TIME + "$").test(a0.by), a0);
let b0 = await until(async () => { const x = await item(B, "luk", luk[0]); return x.checked ? x : null; }, 7000);
check("other phone gets it within one poll, as 'Lars · tt.mm'", b0 && b0.completed && new RegExp("^Lars · " + TIME + "$").test(b0.by), b0);
check("remote update is in place (same rows, no re-render)", await B.evaluate(() => Array.from(document.querySelectorAll("#luk-list .task-item")).every((li) => li.__kept === true)));
check("checkbox is described by the who/when line", await B.evaluate((l) => {
  const li = Array.from(document.querySelectorAll("#luk-list .task-item")).find((x) => x.dataset.label === l);
  const id = li.querySelector("input").getAttribute("aria-describedby");
  return id && document.getElementById(id) === li.querySelector(".tick-by");
}, luk[0]));

await tap(B, "luk", luk[0]);
let aGone = await until(async () => { const x = await item(A, "luk", luk[0]); return !x.checked ? x : null; }, 7000);
check("untick propagates back; who/when line hidden", aGone && aGone.by === null && !aGone.completed, aGone);

// ---- token is reused while polling ----
const tokensBefore = A.tokenRequests;
await sleep(9000);
check("polling reuses the token (no token fetch in 9 s of polling)", A.tokenRequests === tokensBefore && A.ticksRequests.length >= 3, { tokens: A.tokenRequests - tokensBefore, polls: A.ticksRequests.length });

// ---- offline taps are queued, and the newest change wins ----
await ctxA.setOffline(true);
await tap(A, "luk", luk[1]);
await tap(A, "luk", luk[2]);
const offlineBanner = await A.evaluate(() => { const b = document.getElementById("offline-banner"); return b.hidden ? null : b.textContent; });
check("offline: right after the tap, the banner says the ticks will be shared later", offlineBanner === "Ingen forbindelse — dine flueben deles, når du er online igen.", offlineBanner);
check("offline taps show at once", (await checkedLabels(A, "luk")).join("|") === [luk[1], luk[2]].join("|"));
await sleep(300);
await tap(B, "luk", luk[2]);
await sleep(300);
await tap(B, "luk", luk[2]); // B unticks luk[2] after A's offline tick of it
await ctxA.setOffline(false);
const converged = await until(async () => {
  const a = (await checkedLabels(A, "luk")).join("|");
  const b = (await checkedLabels(B, "luk")).join("|");
  return a === luk[1] && b === luk[1] ? { a, b } : null;
}, 9000);
check("back online: queued tick shared, older offline tick loses to newer untick", !!converged, { a: await checkedLabels(A, "luk"), b: await checkedLabels(B, "luk") });
check("banner gone once synced", await until(() => A.evaluate(() => document.getElementById("offline-banner").hidden), 5000));
check("queue emptied after confirmation", await A.evaluate(() => Object.keys(tickStores.luk.pending).length === 0 && tickStores.luk.reset === null));

// ---- "Nulstil" clears the list for everyone ----
let confirmText = null;
A.once("dialog", (d) => { confirmText = d.message(); });
await A.locator("#reset-btn-luk").click();
check("shared reset asks first, naming everyone", confirmText === "Nulstil listen for alle? Fluebenene forsvinder også på de andres telefoner.", confirmText);
check("reset clears at once locally", (await checkedLabels(A, "luk")).length === 0);
check("reset reaches the other phone", await until(async () => (await checkedLabels(B, "luk")).length === 0, 7000));

// ---- a tick made offline before a reset doesn't come back ----
await ctxB.setOffline(true);
await tap(B, "luk", luk[3]);
await sleep(400);
await tap(A, "luk", luk[4]);
await sleep(300);
await A.locator("#reset-btn-luk").click();
await ctxB.setOffline(false);
const afterStale = await until(async () => {
  const a = await checkedLabels(A, "luk"), b = await checkedLabels(B, "luk");
  return a.length === 0 && b.length === 0 && (await B.evaluate(() => Object.keys(tickStores.luk.pending).length === 0)) ? true : null;
}, 9000);
check("an offline tick older than a reset is dropped on both phones", !!afterStale, { a: await checkedLabels(A, "luk"), b: await checkedLabels(B, "luk") });

// ---- reset with nothing ticked does nothing (no request, no dialog) ----
let dialogSeen = false;
const onDialog = () => { dialogSeen = true; };
A.on("dialog", onDialog);
const reqBefore = A.ticksRequests.length;
await A.evaluate(() => { resetCheckboxes("luk"); });
await sleep(400);
A.off("dialog", onDialog);
check("reset of an empty list: no dialog, no reset stored", !dialogSeen && (await A.evaluate(() => tickStores.luk.reset === null)), { dialogSeen });

// ---- polling pauses on the photo tab, resumes at once on return ----
await switchTo(A, "billeder");
await sleep(500);
const nBilleder = A.ticksRequests.length;
await sleep(9000);
check("no polling while the photos are showing", A.ticksRequests.length === nBilleder, { extra: A.ticksRequests.length - nBilleder });
const tBack = Date.now();
await switchTo(A, "luk");
check("switching back syncs at once", await until(() => A.ticksRequests.some((r) => r.at >= tBack), 1500));

// ---- slower after 10 quiet minutes, stopped after 30, back on touch ----
await A.evaluate(() => { lastTickActivity = Date.now() - 11 * 60 * 1000; scheduleTickPoll(); });
let n0 = A.ticksRequests.length;
await sleep(8000);
check("after 10 quiet minutes: no poll within 8 s (30 s interval)", A.ticksRequests.length === n0, { extra: A.ticksRequests.length - n0 });
await A.evaluate(() => { lastTickActivity = Date.now() - 31 * 60 * 1000; scheduleTickPoll(); });
check("after 30 quiet minutes: no timer at all", await A.evaluate(() => tickPollTimer === null));
const tTouch = Date.now();
await A.mouse.click(210, 60);
check("a touch after a quiet spell syncs at once", await until(() => A.ticksRequests.some((r) => r.at >= tTouch), 1500));
check("...and polling is back to every 4 s", await until(async () => A.ticksRequests.filter((r) => r.at >= tTouch).length >= 2, 6000));

// ---- hidden page doesn't poll; visible again syncs at once ----
await A.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
n0 = A.ticksRequests.length;
await sleep(6000);
check("hidden page: no polling", A.ticksRequests.length === n0, { extra: A.ticksRequests.length - n0 });
const tVis = Date.now();
await A.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
check("visible again: syncs at once", await until(() => A.ticksRequests.some((r) => r.at >= tVis), 1500));

// ---- another tab on the same phone follows at once (storage event) ----
const A2 = await ctxA.newPage();
A2.on("pageerror", (e) => pageErrors.push("A2: " + e));
await A2.goto(BASE + "/", { waitUntil: "load" });
await A2.waitForSelector("#luk-list .task-item");
await until(() => A2.evaluate(() => ticksMode() === "shared"), 5000);
await A2.evaluate(() => { lastTickActivity = Date.now() - 31 * 60 * 1000; scheduleTickPoll(); }); // no polling in tab 2
await tap(A, "luk", luk[5]);
check("second tab shows the tap within a second, without polling", await until(async () => (await item(A2, "luk", luk[5])).checked, 1000));
await A2.close();

// ---- confetti only for your own tap that completes the list ----
await switchTo(A, "aaben");
await switchTo(B, "aaben");
for (const l of aaben.slice(0, 3)) await tap(A, "aaben", l);
await until(async () => (await checkedLabels(B, "aaben")).length === 3, 7000);
await A.evaluate(() => { window.__confetti = 0; new MutationObserver((m) => m.forEach((x) => { window.__confetti += x.addedNodes.length; })).observe(document.getElementById("confetti-layer"), { childList: true }); });
await tap(B, "aaben", aaben[3]);
const bConfetti = await B.evaluate(() => document.getElementById("confetti-layer").children.length);
await until(async () => (await checkedLabels(A, "aaben")).length === 4, 7000);
await sleep(500);
check("confetti for the phone whose tap completed the list", bConfetti > 0, { bConfetti });
check("no confetti for a list completed from another phone", (await A.evaluate(() => window.__confetti)) === 0, await A.evaluate(() => window.__confetti));

// ---- owner edits the list: ticks follow the item text ----
await switchTo(A, "luk");
await tap(A, "luk", luk[6]);
await tap(A, "luk", luk[7]);
await until(() => A.evaluate(() => Object.keys(tickStores.luk.pending).length === 0), 5000);
await A.locator("#edit-btn-luk").click();
await A.locator("#luk-list .task-item-edit").nth(7).locator(".remove-item-btn").click();
await A.locator("#edit-actions-luk .btn-primary").click();
await until(async () => (await state(A, "luk")).length === luk.length - 1, 5000);
const afterEdit = await checkedLabels(A, "luk");
check("after the owner's edit: kept item keeps its tick, removed item is gone", afterEdit.includes(luk[6]) && !afterEdit.includes(luk[7]) && afterEdit.includes(luk[5]), afterEdit);
const dbAfterEdit = (await db`select label from checklist_ticks where list = 'luk'`).map((r) => r.label);
check("server dropped the removed item's tick", !dbAfterEdit.includes(luk[7]) && dbAfterEdit.includes(luk[6]), dbAfterEdit);
await db`delete from checklist_items where list = 'luk'`;
for (let i = 0; i < luk.length; i++) await db`insert into checklist_items (list, label, position) values ('luk', ${luk[i]}, ${i + 1})`;

// Fresh "Åbn op" list for the sign-in scenarios below (the confetti test ticked all of it).
await db`delete from checklist_ticks where list = 'aaben'`;
await until(async () => (await checkedLabels(A, "aaben")).length === 0, 7000);

// ---- signed out: local ticks only, hint to sign in, nothing sent ----
const { page: C, context: ctxC } = await phone(null, "C");
check("signed out: sign-in hint on the lists", await C.evaluate(() => Array.from(document.querySelectorAll(".share-hint")).every((h) => !h.hidden) && document.querySelector(".share-hint").textContent === "Log ind for at se og dele fluebenene med de andre i huset."));
check("signed out: shared ticks are not shown", (await checkedLabels(C, "luk")).length === 0);
await tap(C, "luk", luk[8]);
const c8 = await item(C, "luk", luk[8]);
check("signed out: tap works, no who/when line", c8.checked && c8.by === null, c8);
await sleep(1500);
check("signed out: nothing sent to /api/ticks", C.ticksRequests.length === 0, C.ticksRequests);
await C.reload({ waitUntil: "load" });
await C.waitForSelector("#luk-list .task-item");
await sleep(500);
check("signed out: tick survives a reload", (await item(C, "luk", luk[8])).checked);
check("hint's 'Log ind' opens the sign-in dialog", await (async () => { await C.locator("#luk .share-hint .inline-link").click(); return C.evaluate(() => document.getElementById("auth-dialog").open); })());
await C.evaluate(() => document.getElementById("auth-dialog").close());

// ---- ticks saved by the previous version carry over ----
await C.evaluate((l) => {
  localStorage.removeItem("enebakken:ticks:aaben");
  localStorage.setItem("enebakken:checked:aaben", JSON.stringify({ at: Date.now() - 60000, labels: [l] }));
}, aaben[1]);
await C.reload({ waitUntil: "load" });
await C.waitForSelector("#aaben-list .task-item", { state: "attached" });
await sleep(500);
check("old-format ticks are migrated and shown", (await item(C, "aaben", aaben[1])).checked);
check("old key removed after migration", await C.evaluate(() => localStorage.getItem("enebakken:checked:aaben") === null));

// ---- a day-old list is a finished visit ----
await C.evaluate((l) => {
  localStorage.setItem("enebakken:ticks:luk", JSON.stringify({ owner: null, server: {}, pending: { [l]: { checked: true, t: Date.now() - 25 * 3600 * 1000 } }, reset: null }));
}, luk[9]);
await C.reload({ waitUntil: "load" });
await C.waitForSelector("#luk-list .task-item");
await sleep(500);
check("ticks untouched for 25 hours are not shown", !(await item(C, "luk", luk[9])).checked);

// ---- signing in shares what was ticked while signed out ----
await ctxC.addCookies([{ name: "eb_test_user", value: "user-c", url: BASE }]);
await C.evaluate(() => refreshMe());
const carl = await until(async () => { const x = await item(A, "aaben", aaben[1]); return x.checked ? x : null; }, 8000);
check("ticks made before signing in are shared under the new account", carl && new RegExp("^Carl · " + TIME + "$").test(carl.by), carl);
check("...and shown as 'Dig' on that phone", new RegExp("^Dig · " + TIME + "$").test((await item(C, "aaben", aaben[1])).by || ""));
check("signed in: hint hidden", await C.evaluate(() => Array.from(document.querySelectorAll(".share-hint")).every((h) => h.hidden)));

// ---- a blocked account drops to local mode ----
await db`insert into members (user_id, role) values ('user-b', 'blocked')`;
const blocked = await until(() => B.evaluate(() => me.role === "blocked" && ticksMode() === "local"), 20000, 300);
check("blocked mid-session: the next sync notices and turns sharing off", !!blocked);
const bState = await state(B, "aaben");
check("blocked: shared ticks and names are removed from the page", bState.every((x) => !x.checked && x.by === null), bState);
check("blocked: no sign-in hint (they are signed in)", await B.evaluate(() => Array.from(document.querySelectorAll(".share-hint")).every((h) => h.hidden)));
const nBlocked = B.ticksRequests.length;
await sleep(6000);
check("blocked: polling stopped", B.ticksRequests.length === nBlocked, { extra: B.ticksRequests.length - nBlocked });

// ---- signing out clears everything shared from the phone ----
await A.locator('#account-bar button:has-text("Log ud")').click();
await until(() => A.evaluate(() => ticksMode() === "local"), 5000);
const aOut = [...(await state(A, "luk")), ...(await state(A, "aaben"))];
check("signed out: no shared ticks or names left on the page", aOut.every((x) => !x.checked && x.by === null), aOut.filter((x) => x.checked || x.by));
check("signed out: nothing shared left in storage", await A.evaluate(() => ["luk", "aaben"].every((l) => { const s = JSON.parse(localStorage.getItem("enebakken:ticks:" + l)); return s.owner === null && Object.keys(s.server).length === 0; })));
check("signed out: token forgotten", await A.evaluate(() => cachedToken === null));

// ---- the upload hint now sits below the photos ----
await switchTo(C, "billeder");
await C.locator('#account-bar button:has-text("Log ud")').click();
await until(() => C.evaluate(() => !document.getElementById("upload-hint").hidden), 5000);
const order = await C.evaluate(() => {
  const hint = document.getElementById("upload-hint");
  const grid = document.getElementById("photo-grid");
  const more = document.getElementById("photo-more-btn");
  return {
    afterMore: !!(more.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING),
    last: hint.parentElement.lastElementChild === hint,
    below: hint.getBoundingClientRect().top >= grid.getBoundingClientRect().bottom,
    text: hint.textContent,
  };
});
check("'Log ind for at dele billeder.' is at the bottom, below the photos", order.afterMore && order.last && order.below && order.text === "Log ind for at dele billeder.", order);
await C.screenshot({ path: screenshotPath("shared-ticks-billeder.png") });

check("no page errors", pageErrors.length === 0, pageErrors);
await browser.close();
await db`delete from checklist_ticks`;
await db`update checklist_resets set reset_at = '-infinity'`;
await db`delete from members`;
await db.end();
finish();
