import { baseUrl, createChecks, launchBrowser, screenshotPath, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8936);
const pageErrors = [];
const { check, finish } = createChecks();
const browser = await launchBrowser();

const initMock = () => {
  window.__calls = [];
  window.__users = [
    { user_id: 'owner-1', display_name: 'Lars Sohl', email: 'larssohl@gmail.com', role: 'owner', photos: 13 },
    { user_id: 'u-2', display_name: 'Anna Hansen', email: 'anna@example.com', role: 'user', photos: 1 },
    { user_id: 'u-3', display_name: 'Spam Konto', email: 'spam@example.com', role: 'blocked', photos: 4 },
  ];
  const realFetch = window.fetch.bind(window);
  const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), location.href);
    const method = opts.method || 'GET';
    if (u.pathname === '/api/auth/token') return ok({ token: 'fake' });
    if (u.pathname === '/api/members') {
      window.__calls.push({ method, body: opts.body || null });
      if (method === 'PATCH') {
        const b = JSON.parse(opts.body);
        const user = window.__users.find(x => x.user_id === b.userId);
        user.role = b.blocked ? 'blocked' : 'user';
        return ok({ ok: true });
      }
      return ok({ items: window.__users });
    }
    if (u.pathname === '/api/invites') return ok({ items: [] });
    if (u.pathname === '/api/photos/presign') { window.__calls.push({ method, path: u.pathname, body: opts.body }); return ok({ ok: true, object_key: 'photos/x.png', upload_url: 'https://storage.invalid/put' }); }
    if (u.origin === 'https://storage.invalid') { window.__calls.push({ method, path: 'storage-put', contentLength: opts.body && opts.body.size }); return new Response('', { status: 200 }); }
    if (u.pathname === '/api/photos' && method === 'POST') { window.__calls.push({ method, path: u.pathname, body: opts.body }); return ok({ ok: true, id: 1 }); }
    return realFetch(url, opts);
  };
};

const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
await context.addInitScript(initMock);
const page = await context.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.locator('button[aria-controls="billeder"]').click();

const uploadUi = () => page.evaluate(() => ({ plus: !document.getElementById('add-photo-btn').hidden, hint: document.getElementById('upload-hint').hidden ? null : document.getElementById('upload-hint').textContent }));

// signed out
let ui = await uploadUi();
check("signed out: no upload button, hint says log in", !ui.plus && ui.hint === 'Log ind for at dele billeder.', ui);

// signed in, never invited (no role) -> may upload
await page.evaluate(() => { me = { authenticated: true, userId: 'u-2', email: 'anna@example.com', name: 'Anna Hansen', role: null }; renderPhotoUploadVisibility(); });
ui = await uploadUi();
check("signed in without invitation: upload button shown, no hint", ui.plus && ui.hint === null, ui);

// blocked
await page.evaluate(() => { me.role = 'blocked'; renderPhotoUploadVisibility(); });
ui = await uploadUi();
check("blocked: no upload button, told why", !ui.plus && ui.hint === 'Din konto er blokeret fra at dele billeder.', ui);

// sign-up text no longer mentions invitations
const signupHint = await page.evaluate(() => document.querySelector('#signup-form .form-hint').textContent);
check("sign-up text explains uploading after login (no invitation claim)", signupHint === 'Når du er logget ind, kan du dele billeder på opslagstavlen.', signupHint);

// upload sends the exact byte size to presign, and the PUT body is that size
await page.evaluate(() => { me.role = null; renderPhotoUploadVisibility(); });
await page.locator('#add-photo-btn').click();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
await page.setInputFiles('#photo-file', { name: 'lille.png', mimeType: 'image/png', buffer: png });
await page.fill('#photo-caption', 'Test');
await page.locator('#photo-upload-btn').click();
await page.waitForTimeout(600);
const up = await page.evaluate(() => window.__calls.filter(c => c.path));
const presignBody = JSON.parse(up.find(c => c.path === '/api/photos/presign').body);
const put = up.find(c => c.path === 'storage-put');
check("presign request carries the exact byte size of what is uploaded", presignBody.size === put.contentLength && presignBody.size > 0 && presignBody.contentType === 'image/png', { presign: presignBody, putBytes: put.contentLength });

// owner: admin list shows every account with status, and block/unblock send PATCH
await page.evaluate(() => { me = { authenticated: true, userId: 'owner-1', email: 'larssohl@gmail.com', name: 'Lars Sohl', role: 'owner' }; renderAccountBar(); });
await page.locator('#account-bar button:has-text("Administrer brugere")').click();
await page.waitForTimeout(400);
const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#members-list .manage-row')).map(li => ({
  name: li.querySelector('.manage-row-name').textContent,
  meta: li.querySelector('.manage-row-meta').textContent,
  buttons: Array.from(li.querySelectorAll('.manage-remove-btn')).map(b => ({ text: b.textContent, neutral: b.classList.contains('is-neutral'), promote: b.classList.contains('is-promote') })),
})));
let list = await rows();
check("section is called 'Brugere'", (await page.evaluate(() => document.querySelector('#members-list').previousElementSibling.textContent)) === 'Brugere');
check("owner row: status + photo count, no button (sole administrator)", list[0].name === 'Lars Sohl' && list[0].meta === 'larssohl@gmail.com · Administrator · 13 billeder' && list[0].buttons.length === 0, list[0]);
check("uninvited user listed with 'Gør til administrator' + 'Bloker' (singular '1 billede')", list[1].meta === 'anna@example.com · 1 billede' && JSON.stringify(list[1].buttons) === JSON.stringify([{ text: 'Gør til administrator', neutral: false, promote: true }, { text: 'Bloker', neutral: false, promote: false }]), list[1]);
check("blocked user shows 'Blokeret' and a neutral 'Fjern blokering', no promote option while blocked", list[2].meta === 'spam@example.com · Blokeret · 4 billeder' && JSON.stringify(list[2].buttons) === JSON.stringify([{ text: 'Fjern blokering', neutral: true, promote: false }]), list[2]);

await page.locator('#members-list .manage-row', { hasText: 'Anna Hansen' }).locator('button:has-text("Bloker")').click();
await page.waitForTimeout(400);
await page.locator('#members-list .manage-row', { hasText: 'Spam Konto' }).locator('button:has-text("Fjern blokering")').click();
await page.waitForTimeout(400);
const patches = await page.evaluate(() => window.__calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body)));
check("block and unblock send the right PATCH bodies", JSON.stringify(patches) === JSON.stringify([{ userId: 'u-2', blocked: true }, { userId: 'u-3', blocked: false }]), patches);
list = await rows();
check("list reloads with the new states (Anna now blocked-only-button, Spam back to promote+block)", list[1].buttons.length === 1 && list[1].buttons[0].text === 'Fjern blokering' && list[2].buttons.map(b => b.text).join(',') === 'Gør til administrator,Bloker', list.map(r => r.buttons));
await page.screenshot({ path: screenshotPath("admin-users.png") });

check("no page errors", pageErrors.length === 0, pageErrors);
await browser.close();
finish();
