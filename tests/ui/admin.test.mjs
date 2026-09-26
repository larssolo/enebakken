import { baseUrl, createChecks, launchBrowser, screenshotPath, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8936);
const pageErrors = [];
const { check, finish } = createChecks();

await fetch(BASE + "/__test/reset", { method: "POST" });

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
await context.addCookies([{ name: "eb_test_user", value: "u-alice", url: BASE }]);
const page = await context.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE + "/", { waitUntil: "load" });
await page.evaluate(() => { me = { authenticated: true, userId: 'u-alice', email: 'alice@example.com', name: 'Alice Owner', role: 'owner' }; renderAccountBar(); });
await page.locator('#account-bar button:has-text("Administrer brugere")').click();
await sleep(400);

// Exactly one dialog listener at a time, registered right before the click
// that triggers it - a blanket page-wide auto-accept would fire alongside
// any later .once() listener on the same dialog, which Playwright rejects.
let lastConfirmText = null;
function expectDialog(action) {
  return new Promise((resolve) => {
    page.once("dialog", (d) => { lastConfirmText = d.message(); (action === "accept" ? d.accept() : d.dismiss()); resolve(); });
  });
}
async function clickThrough(locator, action = "accept") {
  const wait = expectDialog(action);
  await locator.click();
  await wait;
  await sleep(300);
}

const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#members-list .manage-row')).map((li) => ({
  name: li.querySelector('.manage-row-name').textContent,
  meta: li.querySelector('.manage-row-meta').textContent,
  buttons: Array.from(li.querySelectorAll('.manage-remove-btn')).map((b) => ({ text: b.textContent, promote: b.classList.contains('is-promote'), neutral: b.classList.contains('is-neutral') })),
  deleteBtn: li.querySelector('.manage-delete-btn') ? li.querySelector('.manage-delete-btn').getAttribute('aria-label') : null,
})));
const rowFor = (list, name) => list.find((r) => r.name === name);
const btn = (name, text) => page.locator('#members-list .manage-row', { hasText: name }).locator('button:has-text("' + text + '")');

let list = await rows();
check("owner row: labelled 'Administrator', no buttons (sole administrator)", rowFor(list, 'Alice Owner').meta.includes('Administrator') && rowFor(list, 'Alice Owner').buttons.length === 0, rowFor(list, 'Alice Owner'));
check("blocked row: only 'Fjern blokering', styled neutral", JSON.stringify(rowFor(list, 'Carl Blocked').buttons) === JSON.stringify([{ text: 'Fjern blokering', promote: false, neutral: true }]), rowFor(list, 'Carl Blocked'));
check("normal row: 'Gør til administrator' (gold) + 'Bloker' (default), in that order", JSON.stringify(rowFor(list, 'Bob Normal').buttons) === JSON.stringify([{ text: 'Gør til administrator', promote: true, neutral: false }, { text: 'Bloker', promote: false, neutral: false }]), rowFor(list, 'Bob Normal'));
check("the sole administrator has no delete button either", rowFor(list, 'Alice Owner').deleteBtn === null, rowFor(list, 'Alice Owner'));
check("a normal account has a delete button", rowFor(list, 'Bob Normal').deleteBtn === 'Slet konto', rowFor(list, 'Bob Normal'));
check("a blocked account also has a delete button, alongside 'Fjern blokering'", rowFor(list, 'Carl Blocked').deleteBtn === 'Slet konto', rowFor(list, 'Carl Blocked'));

// ---- promote Bob ----
await clickThrough(btn('Bob Normal', 'Gør til administrator'));
check("promote confirmation names the account and what it grants", lastConfirmText === 'Gør Bob Normal til administrator? Personen kan så redigere huskelisterne og administrere alle brugere.', lastConfirmText);
list = await rows();
check("Bob is now shown as Administrator", rowFor(list, 'Bob Normal').meta.includes('Administrator'), rowFor(list, 'Bob Normal'));
check("...with a 'Fjern administrator' button now that there are 2 administrators", JSON.stringify(rowFor(list, 'Bob Normal').buttons) === JSON.stringify([{ text: 'Fjern administrator', promote: false, neutral: true }]), rowFor(list, 'Bob Normal'));
check("Alice (no longer sole) now also gets a 'Fjern administrator' button", JSON.stringify(rowFor(list, 'Alice Owner').buttons) === JSON.stringify([{ text: 'Fjern administrator', promote: false, neutral: true }]), rowFor(list, 'Alice Owner'));
check("an administrator has no delete button — promote closed off the option", rowFor(list, 'Bob Normal').deleteBtn === null, rowFor(list, 'Bob Normal'));

// ---- demote Bob back, dismissing once first to prove cancel is a no-op ----
await clickThrough(btn('Bob Normal', 'Fjern administrator'), "dismiss");
check("demote confirmation names the account, shorter wording", lastConfirmText === 'Fjern Bob Normal som administrator?', lastConfirmText);
list = await rows();
check("dismissing the demote confirmation changes nothing", rowFor(list, 'Bob Normal').meta.includes('Administrator'), rowFor(list, 'Bob Normal'));
await clickThrough(btn('Bob Normal', 'Fjern administrator'));
list = await rows();
check("accepting demotes Bob back to a normal row (promote + block buttons)", rowFor(list, 'Bob Normal').buttons.length === 2 && !rowFor(list, 'Bob Normal').meta.includes('Administrator'), rowFor(list, 'Bob Normal'));
check("Alice, sole administrator again, has no button", rowFor(list, 'Alice Owner').buttons.length === 0 && rowFor(list, 'Alice Owner').deleteBtn === null, rowFor(list, 'Alice Owner'));
check("Bob has his delete button back too, demoted", rowFor(list, 'Bob Normal').deleteBtn === 'Slet konto', rowFor(list, 'Bob Normal'));

// ---- last-administrator guard surfaces through the real UI's own API call, since there's no button to even attempt it with ----
let r = await page.evaluate(async () => {
  const token = await fetchFreshToken();
  return apiFetch('/members', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ userId: 'u-alice', owner: false }) });
});
check("attempting to demote the sole administrator is refused, even calling the API directly", r.status === 400 && r.body.error === 'Der skal altid være mindst én administrator', r);

// ---- a blocked account never shows a promote button (can't be promoted while blocked) ----
list = await rows();
check("Carl (blocked) has no promote button anywhere in the row", !rowFor(list, 'Carl Blocked').buttons.some((b) => b.text.includes('administrator')), rowFor(list, 'Carl Blocked'));

// ---- unblock Carl, then he becomes promotable ----
await clickThrough(btn('Carl Blocked', 'Fjern blokering'));
list = await rows();
check("once unblocked, Carl gets the normal two buttons including promote", JSON.stringify(rowFor(list, 'Carl Blocked').buttons.map((b) => b.text)) === JSON.stringify(['Gør til administrator', 'Bloker']), rowFor(list, 'Carl Blocked'));

// ---- promoting doesn't reopen the door to blocking (an administrator can't be blocked) ----
await clickThrough(btn('Dana Normal', 'Gør til administrator'));
list = await rows();
check("a freshly-promoted administrator has no block option available", !rowFor(list, 'Dana Normal').buttons.some((b) => b.text === 'Bloker'), rowFor(list, 'Dana Normal'));
await clickThrough(btn('Dana Normal', 'Fjern administrator')); // clean up back to a normal row

// ---- deleting an account: the icon button, its confirmation, and the real effect ----
const delBtn = (name) => page.locator('#members-list .manage-row', { hasText: name }).locator('.manage-delete-btn');
page.once("dialog", (d) => { lastConfirmText = d.message(); d.dismiss(); });
await delBtn('Carl Blocked').click();
await sleep(200);
check("delete confirmation warns it can't be undone and photos stay", lastConfirmText === 'Slet Carl Blocked helt? Kontoen kan ikke logges ind på igen, og dette kan ikke fortrydes. Billeder personen har delt, bliver stående.', lastConfirmText);
list = await rows();
check("dismissing the delete confirmation changes nothing — the row is still there", rowFor(list, 'Carl Blocked') !== undefined, list.map((r) => r.name));

await clickThrough(delBtn('Carl Blocked'));
list = await rows();
check("accepting removes the row from the list entirely", rowFor(list, 'Carl Blocked') === undefined, list.map((r) => r.name));
const stillThere = await page.evaluate(async () => {
  const token = await fetchFreshToken();
  const r = await apiFetch('/members', { headers: { Authorization: 'Bearer ' + token } });
  return r.body.items.some((x) => x.email === 'carl@example.com');
});
check("the real server no longer has Carl's account at all, not just hidden in the UI", !stillThere);

// ---- deleting an administrator is refused (no button exists, but the guard holds if called directly too) ----
let rDel = await page.evaluate(async () => {
  const token = await fetchFreshToken();
  return apiFetch('/members', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ userId: 'u-alice' }) });
});
check("an administrator can't be deleted, even calling the API directly", rDel.status === 400 && rDel.body.error.includes('fjern administrator-status'), rDel);

await page.screenshot({ path: screenshotPath("admin-promote-demote.png") });
check("no page errors the whole time", pageErrors.length === 0, pageErrors);
await browser.close();
finish();
