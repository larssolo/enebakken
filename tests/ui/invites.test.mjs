import { baseUrl, createChecks, launchBrowser, screenshotPath, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8940);
const { check, finish } = createChecks();

async function apiReq(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, ok: res.ok, body, setCookie };
}
const cookiePair = (h) => h.split(";")[0].trim();

await apiReq("/__test/reset", { method: "POST" });

const su = await apiReq("/api/auth/sign-in", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "owner@example.com", password: "anything" }),
});
const ownerCookie = cookiePair(su.setCookie[0]);
const tok = await apiReq("/api/auth/token", { headers: { Cookie: ownerCookie } });
const ownerToken = tok.body.token;

// ---- fresh invite: link should auto-login the visitor ----
let inv = await apiReq("/api/invites", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ownerToken },
  body: JSON.stringify({ email: "frans.falk@example.com" }),
});
const freshLink = inv.body.link.replace("https://www.enebakken.info", BASE);

// ---- an email that already has an account: link should fall back to the classic banner ----
await apiReq("/api/auth/sign-up", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "existing.eva@example.com", password: "correcthorsebatterystaple", name: "Existing Eva" }),
});
inv = await apiReq("/api/invites", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ownerToken },
  body: JSON.stringify({ email: "existing.eva@example.com" }),
});
const fallbackLink = inv.body.link.replace("https://www.enebakken.info", BASE);

const browser = await launchBrowser();

// ---- 1) fresh invite link, visited signed out ----
{
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(freshLink, { waitUntil: "load" });
  await sleep(600);

  check("visiting the link alone does NOT log anyone in yet — a click is required", await page.evaluate(() => !me.authenticated), null);
  const promptText = await page.locator("#invite-banner").textContent();
  check("shows a one-click login prompt instead of auto-submitting", /Tryk her for at logge ind/.test(promptText || ""), promptText);

  await page.locator('#invite-banner button:has-text("Tryk her for at logge ind")').click();
  await sleep(600);

  const bannerText = await page.locator("#page-banner").textContent();
  check("clicking the prompt logs the invitee in and shows the welcome banner", /logget ind/i.test(bannerText || ""), bannerText);
  check("...and it points at 'Skift adgangskode' as the way to choose your own", /Skift adgangskode/.test(bannerText || ""), bannerText);
  check("...and at 'Skift navn' for fixing the name the invite gave them", /Skift navn/.test(bannerText || ""), bannerText);

  const accountBarText = await page.locator("#account-bar").textContent();
  check("account bar shows the invitee signed in with their placeholder name", /Hej, Frans/.test(accountBarText || ""), accountBarText);
  check("'Skift adgangskode' button is present", await page.locator('#account-bar button:has-text("Skift adgangskode")').count() === 1, accountBarText);
  check("no leftover ?invite= param in the address bar", !page.url().includes("invite="), page.url());
  check("the invite-only banner (log in or sign up yourself) is NOT shown for auto-login", await page.locator("#invite-banner").isHidden(), null);

  await page.locator('#account-bar button:has-text("Skift adgangskode")').click();
  await sleep(300);
  check("'Skift adgangskode' opens the auth dialog in forgot-password mode", await page.locator("#forgot-form").isVisible() && await page.locator("#signin-form").isHidden(), null);
  const prefilled = await page.locator("#forgot-email").inputValue();
  check("...with the signed-in account's own email pre-filled", prefilled === "frans.falk@example.com", prefilled);
  // Checked with the dialog OPEN: inside a closed dialog everything reads
  // as hidden, which is how a stale banner slipped past this test before.
  check("the used-up invite prompt does NOT linger above the change-password form", await page.locator("#invite-banner").isHidden(), await page.locator("#invite-banner").textContent());

  await page.screenshot({ path: screenshotPath("invite-auto-login.png") });
  check("no page errors", pageErrors.length === 0, pageErrors);
  await context.close();
}

// ---- 2) invite link for an email that already had an account, visited signed out ----
{
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(fallbackLink, { waitUntil: "load" });
  await sleep(600);

  check("shows the same one-click prompt first (can't tell yet whether this email will auto-login)", await page.locator('#invite-banner button:has-text("Tryk her for at logge ind")').count() === 1, null);
  await page.locator('#invite-banner button:has-text("Tryk her for at logge ind")').click();
  await sleep(600);

  check("falls back to the classic invite banner instead of claiming auto-login", await page.locator("#invite-banner").isVisible(), null);
  const bannerText = await page.locator("#invite-banner").textContent();
  check("...with the original 'log in or sign up' wording", /Log ind eller opret en bruger/.test(bannerText || ""), bannerText);
  check("the auth dialog opens (asking them to sign in)", await page.locator("#auth-dialog").isVisible(), null);
  check("account bar shows signed out, not silently logged into someone else's account", (await page.locator("#account-bar").textContent()).includes("Log ind"), await page.locator("#account-bar").textContent());

  await page.screenshot({ path: screenshotPath("invite-fallback.png") });
  check("no page errors", pageErrors.length === 0, pageErrors);
  await context.close();
}

// ---- 3) the plain "Log ind" button at the bottom, no invite involved ----
{
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "load" });
  await sleep(600);

  await page.locator('#account-bar button:has-text("Log ind")').click();
  await sleep(300);
  check("the account bar's 'Log ind' opens the dialog WITH the sign-in form showing", await page.locator("#signin-form").isVisible(), null);
  check("...and the 'Log ind' tab marked active", await page.locator("#switch-signin").evaluate((el) => el.classList.contains("active")), null);
  check("...and no invite banner, since there is no invite", await page.locator("#invite-banner").isHidden(), null);

  // Photo delete buttons are decided when a card is drawn: signed out, none.
  await page.locator("#auth-dialog button:has-text('Luk')").first().click();
  await page.locator('.tab-btn:has-text("Billeder")').click();
  await sleep(300);
  const deleteButtonsOn = () => page.$$eval("#photo-grid .photo-card", (cards) =>
    cards.filter((c) => c.querySelector(".delete-photo-btn")).map((c) => c.querySelector(".photo-caption").textContent));
  check("signed out: no photo has a delete button", (await deleteButtonsOn()).length === 0, await deleteButtonsOn());

  // Sign in through the dialog the way a person would, then sign out and
  // open it again: it must come back the same, not in some leftover state.
  await page.locator('#account-bar button:has-text("Log ind")').click();
  await sleep(300);
  await page.locator("#signin-email").fill("existing.eva@example.com");
  await page.locator("#signin-password").fill("whatever-the-mock-accepts");
  await page.locator('#signin-form button[type="submit"]').click();
  await sleep(700);
  check("signing in through that form works", /Hej, Existing/.test(await page.locator("#account-bar").textContent()), await page.locator("#account-bar").textContent());
  check("after signing in, her own photo gets a delete button — and only hers", JSON.stringify(await deleteButtonsOn()) === JSON.stringify(["Evas billede"]), await deleteButtonsOn());

  await page.locator('#account-bar button:has-text("Log ud")').click();
  await sleep(500);
  check("after signing out, the delete buttons are gone again", (await deleteButtonsOn()).length === 0, await deleteButtonsOn());
  await page.locator('#account-bar button:has-text("Log ind")').click();
  await sleep(300);
  check("after signing out, 'Log ind' opens the sign-in form again", await page.locator("#signin-form").isVisible(), null);

  check("no page errors", pageErrors.length === 0, pageErrors);
  await context.close();
}

// ---- 4) the administrator's side: edit mode, the user list, self-demotion ----
{
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/", { waitUntil: "load" });
  await sleep(600);

  await page.locator('#account-bar button:has-text("Log ind")').click();
  await sleep(300);
  await page.locator("#signin-email").fill("owner@example.com");
  await page.locator("#signin-password").fill("x");
  await page.locator('#signin-form button[type="submit"]').click();
  await sleep(800);

  await page.locator('.tab-btn:has-text("Billeder")').click();
  await sleep(300);
  check("an administrator gets a delete button on every photo right after signing in", (await page.$$eval("#photo-grid .delete-photo-btn", (b) => b.length)) === 2, null);

  // Enter edit mode now; what happens to it on self-demotion is checked below.
  await page.locator('.tab-btn:has-text("Luk ned")').click();
  await page.locator("#edit-btn-luk").click();
  await sleep(200);
  check("administrator can enter edit mode", await page.locator("#edit-actions-luk").isVisible(), null);

  // The user list: an invite shows up there at once, marked as not yet used.
  await page.locator('#account-bar button:has-text("Administrer brugere")').click();
  await sleep(600);
  check("the invite form has an optional name field, empty to begin with", await page.locator("#invite-name").isVisible() && (await page.locator("#invite-name").inputValue()) === "" && !(await page.locator("#invite-name").evaluate((el) => el.required)), null);
  await page.locator("#invite-email").fill("new.person@example.com");
  await page.locator("#invite-name").fill("  Ny  Person ");
  await page.locator('#invite-form button[type="submit"]').click();
  await sleep(900);
  const rowFor = (email) => page.locator("#members-list .manage-row", { hasText: email });
  check("a new invite's account appears in 'Brugere' immediately", await rowFor("new.person@example.com").count() === 1, null);
  check("...under the name given in the invite form (spaces tidied)", (await rowFor("new.person@example.com").locator(".manage-row-name").textContent()) === "Ny Person", await rowFor("new.person@example.com").locator(".manage-row-name").textContent());
  const mailto = await page.evaluate(() => pendingInviteMailto);
  check("the invitation e-mail greets them by first name", mailto.includes(encodeURIComponent("Hej Ny!")), mailto);
  check("...marked as invited but not yet used", /Inviteret — har ikke brugt linket endnu/.test(await rowFor("new.person@example.com").locator(".manage-row-meta").textContent()), await rowFor("new.person@example.com").locator(".manage-row-meta").textContent());
  check("the user list has no duplicate rows", (await page.$$eval("#members-list .manage-row-name", (els) => els.map((e) => e.textContent))).length
    === new Set(await page.$$eval("#members-list .manage-row-meta", (els) => els.map((e) => e.textContent.split(" · ")[0]))).size, null);

  await page.locator("#pending-invites-list .manage-row", { hasText: "new.person@example.com" }).locator('button:has-text("Annullér")').click();
  await sleep(900);
  check("cancelling the invite removes its account from 'Brugere' at once", await rowFor("new.person@example.com").count() === 0, null);

  // Self-demotion: make eva an administrator, then step down yourself.
  await rowFor("existing.eva@example.com").locator('button:has-text("Gør til administrator")').click();
  await sleep(800);
  await rowFor("owner@example.com").locator('button:has-text("Fjern administrator")').click();
  await sleep(1000);
  check("after removing yourself as administrator the dialog closes", !(await page.locator("#manage-users-dialog").evaluate((d) => d.open)), null);
  check("...a banner says so", /ikke længere administrator/.test(await page.locator("#page-banner").textContent()), await page.locator("#page-banner").textContent());
  check("...'Administrer brugere' is gone from the account bar", await page.locator('#account-bar button:has-text("Administrer brugere")').count() === 0, await page.locator("#account-bar").textContent());
  // An unsaved draft is kept on purpose (a lost session looks the same as
  // this, and signing back in should let the edit be saved, not retyped);
  // "Annullér" stays available to leave it.
  check("...'Rediger' is hidden, while an open draft is kept with 'Annullér' still available", await page.locator("#edit-btn-luk").isHidden() && await page.locator('#edit-actions-luk button:has-text("Annullér")').isVisible(), null);
  await page.locator('.tab-btn:has-text("Billeder")').click();
  await sleep(300);
  check("...and the delete buttons on other people's photos are gone", (await page.$$eval("#photo-grid .delete-photo-btn", (b) => b.length)) === 0, null);

  check("no page errors", pageErrors.length === 0, pageErrors);
  await context.close();
}

// ---- 5) "Skift navn" ----
{
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "load" });
  await sleep(600);
  check("signed out: there's no 'Skift navn'", await page.locator('#account-bar button:has-text("Skift navn")').count() === 0, null);

  await page.locator('#account-bar button:has-text("Log ind")').click();
  await sleep(300);
  await page.locator("#signin-email").fill("frans.falk@example.com");
  await page.locator("#signin-password").fill("x");
  await page.locator('#signin-form button[type="submit"]').click();
  await sleep(800);
  check("signed in with the name the invite made up", /Hej, Frans/.test(await page.locator("#account-bar").textContent()), await page.locator("#account-bar").textContent());

  const nameBtn = page.locator('#account-bar button:has-text("Skift navn")');
  check("'Skift navn' is in the account bar", await nameBtn.count() === 1, await page.locator("#account-bar").textContent());
  await nameBtn.click();
  await sleep(200);
  check("it opens a dialog with the current name filled in", await page.locator("#name-dialog").evaluate((d) => d.open) && (await page.locator("#name-input").inputValue()) === "Frans Falk", await page.locator("#name-input").inputValue());

  await page.locator("#name-input").fill("   ");
  await page.locator("#name-submit").click();
  await sleep(300);
  check("only spaces: refused in the dialog, which stays open", (await page.locator("#name-error").textContent()) === "Skriv dit navn" && await page.locator("#name-dialog").evaluate((d) => d.open), await page.locator("#name-error").textContent());

  await apiReq("/__test/fail-update-user?on=1");
  await page.locator("#name-input").fill("Franz Falk");
  await page.locator("#name-submit").click();
  await sleep(600);
  await apiReq("/__test/fail-update-user?on=0");
  check("when saving fails: the error is shown and the dialog stays open", /Kunne ikke gemme navnet/.test(await page.locator("#name-error").textContent()) && await page.locator("#name-dialog").evaluate((d) => d.open), await page.locator("#name-error").textContent());
  check("...the name in the account bar is unchanged", /Hej, Frans/.test(await page.locator("#account-bar").textContent()), await page.locator("#account-bar").textContent());
  check("...and 'Gem' can be pressed again", await page.locator("#name-submit").isEnabled(), null);

  await page.locator("#name-submit").click();
  await sleep(800);
  check("saving closes the dialog", !(await page.locator("#name-dialog").evaluate((d) => d.open)), null);
  check("...confirms the new name in a banner", (await page.locator("#page-banner").textContent()).includes("Dit navn er ændret til Franz Falk."), await page.locator("#page-banner").textContent());
  check("...and the account bar uses it at once", /Hej, Franz/.test(await page.locator("#account-bar").textContent()), await page.locator("#account-bar").textContent());

  // A tick made after the change carries the new name (it travels in the
  // token, so a stale cached token would still say "Frans").
  const tokenName = await page.evaluate(async () => {
    const t = await getSyncToken();
    return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).name;
  });
  check("...and the token the checklist sync reuses carries the new name", tokenName === "Franz Falk", tokenName);

  await page.reload({ waitUntil: "load" });
  await sleep(700);
  check("the new name is still there after a reload", /Hej, Franz/.test(await page.locator("#account-bar").textContent()), await page.locator("#account-bar").textContent());
  await nameBtn.click();
  await sleep(200);
  await page.locator('#name-dialog button:has-text("Annullér")').click();
  check("'Annullér' closes the dialog without changing anything", !(await page.locator("#name-dialog").evaluate((d) => d.open)) && /Hej, Franz/.test(await page.locator("#account-bar").textContent()), null);

  await page.screenshot({ path: screenshotPath("change-name.png") });
  check("no page errors", pageErrors.length === 0, pageErrors);
  await context.close();
}

await browser.close();
finish();
