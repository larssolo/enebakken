// Browser tests for the easter-egg game, Dyrevennerne: opened by tapping
// the logo 5 times, played inside its frame with Playwright's fake clock so
// every timing is deterministic.
import { baseUrl, createChecks, launchBrowser, sleep } from "../lib/harness.mjs";

const BASE = baseUrl(8935);
const { check, finish } = createChecks();
const T0 = new Date("2026-06-01T10:00:00Z").getTime();
let a, far;

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
// Every frame (page and game) records its own uncaught errors.
await context.addInitScript(() => {
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
});
const page = await context.newPage();
await page.clock.install({ time: T0 });
await page.goto(BASE + "/", { waitUntil: "load" });
await page.clock.pauseAt(T0 + 60_000);

const game = page.frameLocator("#game-frame");
const gameFrame = () => page.frames().find((f) => f.url().endsWith("/dyrevennerne.html"));
const store = () => gameFrame().evaluate(() => JSON.parse(localStorage.getItem("dyrevennerne:v1") || "null"));
const text = (sel) => game.locator(sel).textContent();
const fullHearts = () => game.locator("#hearts use[href='#i-heart']").count();
async function animal() {
  return gameFrame().evaluate(() => {
    const a = document.getElementById("animal");
    const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(a.style.transform || "");
    return { state: a.className.replace("animal", "").trim(), x: m ? +m[1] : 0, y: m ? +m[2] : 0, size: parseFloat(a.style.getPropertyValue("--size")) || 0 };
  });
}
async function waitForAnimal() {
  for (let i = 0; i < 30; i++) {
    const a = await animal();
    if (a.state === "in") return a;
    await page.clock.runFor(100);
  }
  throw new Error("no animal appeared");
}
// Messages between the game and the page (close, ready) are delivered as
// separate tasks, so what they cause is checked a beat later.
async function eventually(fn) {
  for (let i = 0; i < 40; i++) { if (await fn()) return true; await sleep(25); }
  return false;
}
const dialogOpen = () => page.locator("#game-dialog").evaluate((d) => d.open);
const tapArena = (x, y) => game.locator("#arena").tap({ position: { x, y } });
async function catchOne() { const a = await waitForAnimal(); await tapArena(a.x, a.y); await page.clock.runFor(450); return a; }
// A point on the arena well away from the animal (and below the HUD).
async function farFrom(a) {
  const box = await game.locator("#arena").boundingBox();
  return { x: a.x < box.width / 2 ? box.width - 30 : 30, y: a.y < box.height * .6 ? box.height - 40 : box.height * .5 };
}

// ---- opening: 5 quick taps on the logo ----
for (let i = 0; i < 4; i++) await page.locator(".hero-logo").click({ force: true });
check("4 taps don't open the game", !(await page.locator("#game-dialog").evaluate((d) => d.open)));
await page.locator(".hero-logo").click({ force: true });
check("the 5th tap opens it", await page.locator("#game-dialog").evaluate((d) => d.open));
await game.locator("#menu.on").waitFor();
check("the game loads into its own frame", !!gameFrame(), page.frames().map((f) => f.url()));
check("once loaded, the page's fallback close button steps aside for the game's own", await eventually(() => page.locator("#game-close").isHidden()));
check("...which is shown because the game knows it's embedded", await game.locator("#menu [data-action=close]").isVisible());

// ---- the start screen: title above the horizon line ----
const menuBox = await game.locator("#menu").boundingBox();
const titleBox = await game.locator(".title").boundingBox();
const subBox = await game.locator(".subtitle").boundingBox();
check("the title and subtitle sit above the background's horizon (46%), not on it",
  subBox.y + subBox.height < menuBox.y + menuBox.height * .46 && titleBox.y + titleBox.height < menuBox.y + menuBox.height * .46,
  { titleBottom: titleBox.y + titleBox.height, subBottom: subBox.y + subBox.height, horizon: menuBox.y + menuBox.height * .46 });
const btnBox = await game.locator("#playBtn").boundingBox();
check("...and the start button stands on the meadow below it", btnBox.y > menuBox.y + menuBox.height * .46, btnBox);

// ---- level select ----
await game.locator("#playBtn").click();
const cards = game.locator("#levelGrid .level");
check("six levels", await cards.count() === 6);
check("fresh start: only level 1 is open", await game.locator("#levelGrid .level:not(.locked)").count() === 1);
await cards.nth(1).click();
check("tapping a locked level does nothing", await game.locator("#levels.on").isVisible());

// ---- play ----
await cards.nth(0).click();
check("level 1 starts with 3 hearts and its mission", await game.locator("#play.on").isVisible() && await fullHearts() === 3 && (await text("#missionText")) === "Fang 8 dyr" && (await text("#missionCount")) === "0/8");
const pauseBox = await game.locator("#pauseBtn").boundingBox(), timeBox = await game.locator("#timePill").boundingBox();
check("the pause button no longer covers the clock", pauseBox.x >= timeBox.x + timeBox.width, { pauseBox, timeBox });

// The first animal is out after ~0.45 s; a stray tap before 0.8 s (say, the
// second half of a double-tap on the level card) must not cost a heart.
await page.clock.runFor(520);
a = await animal();
check("an animal is out", a.state === "in", a);
far = await farFrom(a);
await tapArena(far.x, far.y);
check("a stray tap in the first moment of a round costs nothing", await fullHearts() === 3);
await page.clock.runFor(400);

await catchOne();
check("tapping the animal catches it", (await text("#score")) === "1" && (await text("#missionCount")) === "1/8");

// A fast double tap on the same animal counts once.
a = await waitForAnimal();
await tapArena(a.x, a.y);
await tapArena(a.x, a.y);
check("a double tap on one animal counts once", (await text("#score")) === "2", await text("#score"));
await page.clock.runFor(450);

// Just beside it: "Tæt på!", no heart lost. Taps a little off still count.
a = await waitForAnimal();
await tapArena(a.x + a.size * .45, a.y + a.size * .2);
check("a slightly-off tap still catches (the target is generous for small fingers)", (await text("#score")) === "3", await text("#score"));
await page.clock.runFor(450);
a = await waitForAnimal();
await tapArena(a.x + (a.x > a.size * 1.3 ? -1 : 1) * a.size * .95, a.y);
check("a near miss says 'Tæt på!' and costs no heart", await fullHearts() === 3 && (await game.locator(".poptxt.near").count()) >= 1);

// Far off: one heart — and a burst of wild taps costs only one.
far = await farFrom(a);
await tapArena(far.x, far.y);
check("a clear miss costs a heart", await fullHearts() === 2);
await tapArena(far.x, far.y - 20);
await tapArena(far.x - 20, far.y);
check("...but a burst of wild taps right after costs no more", await fullHearts() === 2);

// Pause stops the clock.
const before = await text("#time");
await game.locator("#pauseBtn").click();
check("pause shows the pause card", await game.locator("#pause.on").isVisible());
await page.clock.runFor(5000);
check("...and the time doesn't run while paused", (await text("#time")) === before, { before, after: await text("#time") });
await game.locator("#resumeBtn").click();

// Catch the rest of the mission.
for (let i = 0; i < 5; i++) await catchOne();
check("8 catches complete the mission", (await text("#missionCount")) === "8/8" && await game.locator("#mission.done").isVisible());

// Run out the clock.
await page.clock.runFor(36_000);
await page.clock.runFor(2_500);
check("time's up: the end card says the mission is done", await game.locator("#end.on").isVisible() && (await text("#endTitle")) === "MISSION KLARET!");
check("...with the catch count", (await text("#finalScore")) === "8");
check("...one star earned (8 of 8, no extra)", await game.locator("#endStars use[href='#i-star']").count() === 1);
check("...the next level announced as unlocked, and a 'next' button", await game.locator("#unlockNote.on").isVisible() && await game.locator("#nextBtn").isVisible());
let saved = await store();
check("progress is saved: 1 star on level 1, level 2 open", saved && saved.stars[0] === 1 && saved.unlocked === 2, saved);

// Replaying and doing worse keeps the best, and doesn't pile stars up.
await game.locator("#replayBtn").click();
await page.clock.runFor(36_000);
await page.clock.runFor(2_500);
check("a worse replay ends without a star", (await text("#endTitle")) === "Godt forsøgt!" && await game.locator("#endStars use[href='#i-star']").count() === 0);
saved = await store();
check("...and level 1 keeps its best: still 1 star, total still 1", saved.stars[0] === 1 && saved.stars.reduce((x, y) => x + y, 0) === 1, saved);

// Losing all hearts ends the round.
await game.locator("#replayBtn").click();
await page.clock.runFor(900);
for (let i = 0; i < 3; i++) {
  a = await waitForAnimal();
  far = await farFrom(a);
  await tapArena(far.x, far.y);
  await page.clock.runFor(1300);
}
check("three clear misses (spaced out) end the round", await game.locator("#end.on").isVisible() && /hjerterne/.test(await text("#endTitle")), await text("#endTitle"));

// Back on the level list, level 2 is open and level 1 shows its star.
await game.locator("#levelsBtn").click();
check("the level list shows level 1's star and level 2 open",
  await cards.nth(0).locator("use[href='#i-star']").count() === 1 && !(await cards.nth(1).getAttribute("class")).includes("locked"));
await game.locator("#menuBtn").click();
check("the start screen shows the total stars and best catch", (await text("#totalStars")) === "1" && (await text("#bestScore")) === "8");

// ---- closing ----
await game.locator("#menu [data-action=close]").click();
check("the game's ✕ closes the dialog", await eventually(async () => !(await dialogOpen())));
check("...and unloads the game so nothing keeps running", await eventually(async () => (await page.locator("#game-frame").getAttribute("src")) === "about:blank"));

for (let i = 0; i < 5; i++) await page.locator(".hero-logo").click({ force: true });
await game.locator("#menu.on").waitFor();
check("reopening starts fresh but remembers the progress", (await text("#totalStars")) === "1");
await game.locator("#playBtn").click();
await game.locator("#levels.on").waitFor();
await gameFrame().locator("body").press("Escape");
check("Escape inside the game closes it too", await eventually(async () => !(await dialogOpen())));

// ---- the file on its own ----
const solo = await context.newPage();
await solo.goto(BASE + "/dyrevennerne.html");
check("opened on its own, the game shows no close buttons", await solo.locator("[data-action=close]").first().isHidden());
check("...and still starts", await solo.locator("#menu.on").isVisible());

const errors = [...(await page.evaluate(() => window.__errors)), ...(await solo.evaluate(() => window.__errors))];
check("no errors in the page or the game", errors.length === 0, errors);

await browser.close();
finish();
