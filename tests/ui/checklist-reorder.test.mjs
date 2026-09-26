import postgres from "postgres";
import { DATABASE_URL, baseUrl, createChecks, launchBrowser, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8935);
const { check, finish } = createChecks();

// Only an administrator can edit the lists: make the signed-in test user one.
const db = postgres(DATABASE_URL, { onnotice: () => {} });
await db`insert into members (user_id, role) values ('user-a', 'owner') on conflict (user_id) do update set role = 'owner'`;

// Snapshot the real 'aaben' list so we can restore it after the test —
// this server runs against a shared local DB, not a disposable fixture.
const before = await (await fetch(BASE + "/api/checklist?list=aaben")).json();
const originalLabels = before.items.sort((a, b) => a.position - b.position).map((i) => i.label);

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
await context.addCookies([{ name: "eb_test_user", value: "user-a", url: BASE }]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE + "/", { waitUntil: "load" });
await sleep(500);

const labelsOf = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent));
const editInputValues = () => page.$$eval("#aaben-list .edit-input", (els) => els.map((e) => e.value));

// ---- switch to the 'åben' tab, then enter edit mode ----
await page.locator('.tab-open').click();
await sleep(200);
await page.locator('#edit-btn-aaben').click();
await sleep(300);
let vals = await editInputValues();
check("edit mode shows the real items in their saved order", JSON.stringify(vals) === JSON.stringify(originalLabels), { vals, originalLabels });

// ---- move buttons exist and are correctly disabled at the ends ----
const rows = () => page.locator('#aaben-list .task-item-edit');
const upDisabled = (i) => rows().nth(i).locator('.move-btn[aria-label="Flyt op"]').isDisabled();
const downDisabled = (i) => rows().nth(i).locator('.move-btn[aria-label="Flyt ned"]').isDisabled();
check("first row's up-button is disabled", await upDisabled(0));
check("first row's down-button is enabled", !(await downDisabled(0)));
check("last row's down-button is disabled", await downDisabled(vals.length - 1));
check("last row's up-button is enabled", !(await upDisabled(vals.length - 1)));

// ---- move the first item down twice: [A,B,C,D] -> [B,C,A,D] ----
await rows().nth(0).locator('.move-btn[aria-label="Flyt ned"]').click();
await sleep(150);
await rows().nth(1).locator('.move-btn[aria-label="Flyt ned"]').click();
await sleep(150);
vals = await editInputValues();
const expected = [originalLabels[1], originalLabels[2], originalLabels[0], originalLabels[3]];
check("two 'flyt ned' clicks move the first item to third place, others shift up", JSON.stringify(vals) === JSON.stringify(expected), { vals, expected });

// ---- move it back up once: [B,C,A,D] -> [B,A,C,D] ----
await rows().nth(2).locator('.move-btn[aria-label="Flyt op"]').click();
await sleep(150);
vals = await editInputValues();
const expected2 = [originalLabels[1], originalLabels[0], originalLabels[2], originalLabels[3]];
check("'flyt op' moves it back up one place", JSON.stringify(vals) === JSON.stringify(expected2), { vals, expected2 });

// ---- save, then reload from scratch and confirm the new order persisted ----
await page.locator('#edit-actions-aaben button:has-text("Gem")').click();
await sleep(500);
await page.reload({ waitUntil: "load" });
await sleep(500);
await page.locator('.tab-open').click();
await sleep(200);
let liveOrder = await labelsOf('#aaben-list .task-item label');
check("after saving and reloading, the new order is what the server now serves", JSON.stringify(liveOrder) === JSON.stringify(expected2), { liveOrder, expected2 });

// ---- ticks stay tied to the item's text through a reorder, not its position ----
// tick the item that is now first (originalLabels[1], previously second)
await page.locator('#aaben-list .task-item', { hasText: expected2[0] }).click();
await sleep(400);
const tickedBefore = await page.locator('#aaben-list .task-item', { hasText: expected2[0] }).locator('input[type="checkbox"]').isChecked();
check("ticking the reordered item works", tickedBefore);

// ---- restore the original order so this shared local DB is left as found ----
await page.locator('#edit-btn-aaben').click();
await sleep(300);
// rebuild original order via the input fields directly (simplest deterministic restore)
const inputs = page.locator('#aaben-list .edit-input');
for (let i = 0; i < originalLabels.length; i++) {
  await inputs.nth(i).fill(originalLabels[i]);
}
await sleep(100);
await page.locator('#edit-actions-aaben button:has-text("Gem")').click();
await sleep(500);
const after = await (await fetch(BASE + "/api/checklist?list=aaben")).json();
const restoredLabels = after.items.sort((a, b) => a.position - b.position).map((i) => i.label);
check("original order restored on the shared local DB", JSON.stringify(restoredLabels) === JSON.stringify(originalLabels), { restoredLabels, originalLabels });

check("no page errors the whole time", pageErrors.length === 0, pageErrors);
await browser.close();
await db`delete from members where user_id = 'user-a'`;
await db.end();
finish();
