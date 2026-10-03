// Browser tests for sorting a checklist in edit mode by dragging a row's
// grip (with a mouse, a finger, or the arrow keys), against ticks-server.mjs:
// the real /api/checklist on the local Postgres.
import postgres from "postgres";
import { DATABASE_URL, baseUrl, createChecks, launchBrowser, screenshotPath, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8935);
const { check, finish } = createChecks();

// Only an administrator can edit the lists: make the signed-in test user one.
const db = postgres(DATABASE_URL, { onnotice: () => {} });
await db`insert into members (user_id, role) values ('user-a', 'owner') on conflict (user_id) do update set role = 'owner'`;
const savedLabels = async () => (await db`select label from checklist_items where list = 'luk' order by position`).map((r) => r.label);
const ORIGINAL = await savedLabels();
const N = ORIGINAL.length;
if (N < 8) throw new Error(`the 'luk' list needs at least 8 items for these tests, it has ${N}`);

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true, serviceWorkers: "block" });
await context.addCookies([{ name: "eb_test_user", value: "user-a", url: BASE }]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const cdp = await context.newCDPSession(page);

const rows = () => page.locator("#luk-list .task-item-edit");
const values = () => page.$$eval("#luk-list .edit-input", (els) => els.map((e) => e.value));
const draft = () => page.evaluate(() => editDraft.luk.slice());
// The page and the draft it saves from must agree after every move.
async function order() {
  const [shown, kept] = await Promise.all([values(), draft()]);
  return JSON.stringify(shown) === JSON.stringify(kept) ? shown : { shown, kept };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const moved = (list, from, to) => { const l = list.slice(); l.splice(to, 0, l.splice(from, 1)[0]); return l; };
const settled = () => page.evaluate(() => Array.from(document.querySelectorAll("#luk-list .task-item-edit"))
  .every((li) => !li.style.translate && !li.classList.contains("dragging") && !li.classList.contains("settling")));

// From the top of one row to the next (layout, unaffected by the tilt).
let PITCH;
async function gripCenter(i) {
  const grip = rows().nth(i).locator(".drag-handle");
  await grip.scrollIntoViewIfNeeded();
  const b = await grip.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function mouseDrag(from, rowsDown) {
  const p = await gripCenter(from);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + rowsDown * PITCH, { steps: 12 });
  await page.mouse.up();
  await sleep(300); // the drop glide
}
async function touchDrag(from, rowsDown) {
  const p = await gripCenter(from);
  const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: p.x, y }] });
  await touch("touchStart", p.y);
  for (let s = 1; s <= 12; s++) await touch("touchMove", p.y + (rowsDown * PITCH * s) / 12);
  await touch("touchEnd");
  await sleep(300);
}
async function until(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
}

try {
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.locator("#edit-btn-luk").waitFor({ state: "visible" });
  await page.locator("#edit-btn-luk").click();
  await rows().nth(N - 1).waitFor();
  PITCH = await page.evaluate(() => { const r = document.querySelectorAll("#luk-list .task-item-edit"); return r[1].offsetTop - r[0].offsetTop; });
  let expected = ORIGINAL.slice();

  check("edit mode shows the items in their saved order", same(await order(), expected), await order());
  check("the ▲/▼ buttons are gone; every row has a grip instead",
    await page.locator("#luk-list .move-btn").count() === 0 && await page.locator("#luk-list .drag-handle").count() === N);
  const grip0 = rows().nth(0).locator(".drag-handle");
  check("the grip is a button named for its row, described with how to use it",
    await grip0.getAttribute("aria-label") === "Flyt punkt 1"
    && await page.locator("#" + await grip0.getAttribute("aria-describedby")).textContent() === "Træk for at flytte punktet, eller brug pil op og pil ned.");
  const lastRowBorder = await rows().nth(N - 1).evaluate((li) => getComputedStyle(li).borderBottomWidth);
  const rowHeights = await rows().evaluateAll((els) => els.map((li) => li.offsetHeight));
  check("every row is the same height, the last one too, so rows trade places exactly",
    new Set(rowHeights).size === 1 && rowHeights[0] === PITCH && lastRowBorder === "1px", { rowHeights, PITCH, lastRowBorder });
  const gripHeight = await grip0.evaluate((g) => g.offsetHeight);
  check("the grip is as tall as its row (a finger-sized target)", gripHeight >= PITCH - 2, { gripHeight, PITCH });
  // Each row is grip + text field + ×; the field has to give way on a narrow phone.
  const fits = () => rows().evaluateAll((els) => els.every((li) => {
    const x = li.querySelector(".remove-item-btn");
    return x.offsetLeft + x.offsetWidth <= li.offsetLeft + li.clientWidth;
  }));
  await page.setViewportSize({ width: 320, height: 900 });
  check("on a narrow phone (320 px) every row's × stays inside the card", await fits()
    && await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.setViewportSize({ width: 420, height: 900 });

  // ---- mouse: drag the first row down past two others ----
  let p = await gripCenter(0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + 2.3 * PITCH, { steps: 12 });
  const during = await page.evaluate(() => Array.from(document.querySelectorAll("#luk-list .task-item-edit"))
    .slice(0, 4).map((li) => ({ lifted: li.classList.contains("dragging"), translate: li.style.translate })));
  await page.screenshot({ path: screenshotPath("reorder-mid-drag.png") });
  const followed = parseFloat(during[0].translate.split(" ")[1]);
  check("while dragging, the row is lifted and follows the mouse",
    during[0].lifted && Math.abs(followed - 2.3 * PITCH) <= 1, { during, wanted: 2.3 * PITCH });
  check("...and the two rows it passed have slid up out of its way, the next one not",
    same(during.slice(1).map((r) => r.translate), [`0px ${-PITCH}px`, `0px ${-PITCH}px`, ""]), during);
  check("...without selecting any text on the page", await page.evaluate(() => String(getSelection())) === "");
  await page.mouse.up();
  const dropped = await rows().nth(2).evaluate((li) => getComputedStyle(li).opacity);
  expected = moved(expected, 0, 2);
  check("dropped, it lands third and the two it passed move up", same(await order(), expected), { got: await order(), expected });
  check("...and stays in sight: it doesn't fade in again as if it were new", dropped === "1", dropped);
  await sleep(300);
  check("...and it settles: no row is left lifted or offset", await settled());

  await mouseDrag(3, 0.3);
  check("let go without passing a neighbour's middle, nothing moves", same(await order(), expected), await order());

  p = await gripCenter(4);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y - 10 * PITCH, { steps: 12 });
  const held = await rows().nth(4).evaluate((li) => li.style.translate);
  await page.mouse.up();
  await sleep(300);
  expected = moved(expected, 4, 0);
  check("dragged far beyond the top, a row stays at the top edge of the list", held === `0px ${-4 * PITCH}px`, { held, wanted: -4 * PITCH });
  check("...and lands first", same(await order(), expected), { got: await order(), expected });

  // Picked up straight after a drop, a row moves the one still gliding into
  // place like any other, also once that glide would have ended.
  await page.evaluate(() => window.scrollTo(0, document.getElementById("luk-list").getBoundingClientRect().top + window.scrollY - 60));
  p = await gripCenter(0);
  const q = await gripCenter(2); // both on screen now: measuring one mustn't scroll the other away
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + 1.4 * PITCH, { steps: 4 });
  await page.mouse.up();
  // Low on the grip: the dropped row is still gliding up out of the way.
  await page.mouse.move(q.x, q.y + 0.3 * PITCH);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y - 1.1 * PITCH, { steps: 4 });
  await sleep(400);
  const pushed = await rows().nth(1).evaluate((li) => li.style.translate);
  await page.mouse.up();
  await sleep(300);
  expected = moved(moved(expected, 0, 1), 2, 1);
  check("a row dropped a moment ago is pushed aside by the next drag, and stays aside",
    pushed === `0px ${PITCH}px` && same(await order(), expected) && await settled(), { pushed, got: await order(), expected });

  // A drag is a pointer gesture: it mustn't take the text cursor along.
  const field = rows().nth(2).locator(".edit-input");
  await field.focus();
  await field.evaluate((el) => el.setSelectionRange(3, 3));
  const typing = expected[2];
  await mouseDrag(2, 1.4);
  expected = moved(expected, 2, 3);
  const cursor = await page.evaluate(() => ({ value: document.activeElement.value, at: document.activeElement.selectionStart }));
  check("dragging the row being typed in leaves the text cursor in its field, where it was",
    same(await order(), expected) && cursor.value === typing && cursor.at === 3, { cursor, typing });

  // ---- Escape puts a row back ----
  p = await gripCenter(0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + 3.4 * PITCH, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await sleep(300);
  check("Escape during a drag puts the row back, and letting go after does nothing", same(await order(), expected), await order());
  check("...with every row back in its place", await settled());

  // ---- touch: drag with a finger on the grip ----
  await page.evaluate(() => window.scrollTo(0, document.getElementById("luk-list").getBoundingClientRect().top + window.scrollY - 120));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await touchDrag(1, 3.4);
  expected = moved(expected, 1, 4);
  check("a finger on the grip drags the row too", same(await order(), expected), { got: await order(), expected });
  check("...and doesn't scroll the page instead", await page.evaluate(() => window.scrollY) === scrollBefore);

  // ---- keyboard: the arrow keys on a focused grip ----
  await rows().nth(5).locator(".drag-handle").focus();
  await page.keyboard.press("ArrowUp");
  const keyed = await rows().nth(4).evaluate((li) => getComputedStyle(li).opacity);
  expected = moved(expected, 5, 4);
  check("ArrowUp on a grip moves its row up one place, in plain sight", same(await order(), expected) && keyed === "1", { got: await order(), expected, keyed });
  const focus = () => page.evaluate(() => {
    const el = document.activeElement;
    const li = el.closest(".task-item-edit");
    return { grip: el.classList.contains("drag-handle"), label: el.getAttribute("aria-label"), row: li && li.querySelector(".edit-input").value, index: li ? Array.from(li.parentNode.children).indexOf(li) : -1 };
  });
  let f = await focus();
  check("...the grip keeps the focus, so the next press moves it on", f.grip && f.index === 4 && f.row === expected[4], f);
  check("...renumbered for screen readers", f.label === "Flyt punkt 5" && await rows().nth(4).locator(".edit-input").getAttribute("aria-label") === "Punkt 5", f);
  check("...and the move is announced", await page.locator("#reorder-status").textContent() === `"${expected[4]}" er nu nr. 5 af ${N}.`, await page.locator("#reorder-status").textContent());
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expected = moved(expected, 4, 6);
  f = await focus();
  check("ArrowDown twice moves it two places down", same(await order(), expected) && f.index === 6 && f.row === expected[6], { got: await order(), f });
  await rows().nth(0).locator(".drag-handle").focus();
  await page.keyboard.press("ArrowUp");
  check("ArrowUp on the first row does nothing", same(await order(), expected));

  // ---- auto-scroll: on a short screen, sort past what's visible ----
  await page.setViewportSize({ width: 420, height: 560 });
  p = await gripCenter(N - 1);
  let scrollStart = await page.evaluate(() => window.scrollY);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, 6, { steps: 10 });
  const reachedTop = await until(() => page.evaluate(() => rowDrag && rowDrag.to === 0));
  const scrolledUp = await page.evaluate(() => window.scrollY);
  await page.mouse.up();
  await sleep(300);
  expected = moved(expected, N - 1, 0);
  check("held at the top edge of the screen, the page scrolls up until the row reaches the top", reachedTop && scrolledUp < scrollStart, { reachedTop, scrollStart, scrolledUp });
  check("...and the last row drops in first place", same(await order(), expected), { got: await order(), expected });

  await page.evaluate(() => window.scrollTo(0, document.getElementById("luk-list").getBoundingClientRect().top + window.scrollY - 40));
  p = await gripCenter(0);
  scrollStart = await page.evaluate(() => window.scrollY);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, 560 - 6, { steps: 10 });
  const reachedBottom = await until(() => page.evaluate((n) => rowDrag && rowDrag.to === n - 1, N));
  const scrolledDown = await page.evaluate(() => window.scrollY);
  await page.mouse.up();
  await sleep(300);
  expected = moved(expected, 0, N - 1);
  check("held at the bottom edge, it scrolls down until the row reaches the bottom", reachedBottom && scrolledDown > scrollStart, { reachedBottom, scrollStart, scrolledDown });
  check("...and the first row drops in last place", same(await order(), expected), { got: await order(), expected });
  await page.setViewportSize({ width: 420, height: 900 });

  // ---- typing and removing after moves hit the row on screen ----
  const target = expected[1];
  await rows().nth(1).locator(".edit-input").fill(target + " (rettet)");
  expected[1] = target + " (rettet)";
  check("typing in a moved row changes that row, not the one first in its old place", same(await draft(), expected), { kept: await draft(), expected });
  const gone = expected[2];
  await rows().nth(2).locator(".remove-item-btn").click();
  expected.splice(2, 1);
  check("× on a moved row removes that row", same(await order(), expected) && !(await values()).includes(gone), { got: await order(), expected });

  // ---- saved, the new order is what everybody gets ----
  await page.locator('#edit-actions-luk button:has-text("Gem")').click();
  await until(async () => same(await savedLabels(), expected));
  check("Gem saves the order shown", same(await savedLabels(), expected), { saved: await savedLabels(), expected });
  await page.reload({ waitUntil: "load" });
  await page.locator("#luk-list .task-item").nth(N - 2).waitFor();
  check("...and after a reload the list shows in that order", same(await page.$$eval("#luk-list .task-item label", (els) => els.map((e) => e.textContent)), expected));

  // A tick belongs to the item's text, whatever its place.
  const item = page.locator("#luk-list .task-item").nth(0);
  await item.click();
  check("ticking a moved item works", await until(() => item.locator('input[type="checkbox"]').isChecked()));
  await item.click();
  await until(async () => !(await item.locator('input[type="checkbox"]').isChecked()));

  check("no page errors the whole time", pageErrors.length === 0, pageErrors);
} finally {
  await browser.close();
  // Leave the list as it was found.
  await db.begin(async (tx) => {
    await tx`delete from checklist_items where list = 'luk'`;
    for (let i = 0; i < N; i++) await tx`insert into checklist_items (list, label, position) values ('luk', ${ORIGINAL[i]}, ${i + 1})`;
  });
  await db`delete from checklist_ticks where list = 'luk'`;
  await db`delete from members where user_id = 'user-a'`;
}
check("the list is left as it was found", same(await savedLabels(), ORIGINAL), await savedLabels());
await db.end();
finish();
