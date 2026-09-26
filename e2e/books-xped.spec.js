const { test, expect } = require("@playwright/test");

const field = (page, name) => page.locator(`[data-field="${name}"]`);
async function studio(page) {
  await page.route("**/static/js/firebase-bootstrap.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: "window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};",
  }));
  await page.goto("/books");
  await page.getByRole("button", { name: "＋ New book", exact: true }).click();
  await page.locator('[data-template="blank"]').click();
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
}
async function themes(page, variant = "corner", mode = "light") {
  await page.getByRole("button", { name: "Page settings", exact: true }).click();
  const summary = page.locator("summary").filter({ hasText: "Book palette & themes" });
  if (!(await summary.locator("..").evaluate((el) => el.open))) await summary.click();
  await page.getByRole("button", { name: "Choose a book theme", exact: true }).click();
  await page.locator('[data-theme="xped"]').click();
  await page.locator(`[data-xped-variant="${variant}"]`).click();
  await page.locator(`[data-xped-mode="${mode}"]`).click();
}
async function applyXped(page, variant = "corner", mode = "light") {
  await themes(page, variant, mode);
  await page.getByRole("button", { name: "Apply xPED", exact: true }).click();
}
async function addExtra(page, type) {
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  await page.locator(`[data-extra="${type}"]`).click();
}
async function liveColor(page, name, colors) {
  const input = field(page, name);
  await input.focus();
  for (const color of colors) {
    await input.evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, color);
    await expect(input).toBeFocused();
  }
}

test("xPED cover pairs, paper treatments, artwork, font choices and print preview agree", async ({ page }) => {
  await studio(page);
  await themes(page);
  await expect(page.locator(".book-cover-choice")).toHaveCount(4);
  await expect(page.locator(".book-cover-pair svg")).toHaveCount(8);
  for (const variant of ["corner", "route", "shapes", "minimal"]) {
    const card = page.locator(`[data-xped-variant="${variant}"]`);
    await expect(card.locator('[data-theme-artwork="xped"]')).toHaveCount(2);
    await expect(card.locator('[data-xped-mark]')).toHaveCount(2);
  }
  await page.locator('[data-xped-variant="minimal"]').click();
  await page.locator('[data-xped-mode="dark"]').click();
  await page.getByRole("button", { name: "Apply xPED", exact: true }).click();
  await expect(page.locator('#book-spread [data-xped-mark="white"]')).toHaveCount(1);
  await expect(field(page, "page.background")).toHaveValue("#062940");
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await expect(field(page, "style.font")).toHaveValue("General Sans");
  await expect(field(page, "style.weight").locator("option")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Italic", exact: true })).toBeDisabled();
  await field(page, "style.font").selectOption("Nohemi");
  await expect(field(page, "style.weight")).toHaveValue("700");
  await expect(field(page, "style.weight").locator("option")).toHaveCount(1);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await expect(page.locator('#book-spread [data-xped-corner="blue"]')).toHaveCount(2);
  await expect(page.locator('#book-spread [data-interior-side]').nth(0)).toHaveAttribute('data-interior-side', 'left');
  await expect(page.locator('#book-spread [data-interior-side]').nth(1)).toHaveAttribute('data-interior-side', 'right');
  await page.getByRole("button", { name: "Page settings", exact: true }).click();
  await field(page, "page.themeArtwork").locator("..").click();
  await expect(page.locator('#book-spread [data-xped-corner="blue"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Duplicate page", exact: true }).click();
  await expect(field(page, "page.themeArtwork")).not.toBeChecked();
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await expect(field(page, "page.themeArtwork")).toBeChecked();
  await expect(field(page, "page.background")).toHaveValue("#062940");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(field(page, "arrangement")).toHaveCount(0);
  await expect(page.locator("#print-preview > div").first()).toContainText("Cover / Blank");
  await expect(page.locator(".book-print-sheet").first().locator(":scope > :first-child")).toHaveJSProperty("tagName", "svg");
  await expect(page.locator('#print-preview [data-interior-side]').first()).toHaveAttribute('data-interior-side', 'left');
  await field(page, "economy").locator("..").click();
  await expect(page.locator(".book-print-sheet").first().locator("svg > rect").first()).toHaveAttribute("fill", "#ffffff");
  await expect(page.locator('#print-preview [data-xped-mark="white"]')).toHaveCount(0);
  await field(page, "exportGuides").locator("..").click();
  await expect(page.locator(".book-print-sheet.with-guide")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(field(page, "page.background")).toHaveValue("#062940");
});

test("color input events paint immediately, preserve picker focus and undo as one gesture", async ({ page }) => {
  await studio(page);
  await applyXped(page);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await addExtra(page, "flow");
  const original = await page.locator('#book-spread [data-flow-style] > rect').first().getAttribute("fill");
  await liveColor(page, "fill", ["#edb2f1", "#aa2255", "#ffcc44"]);
  await expect(page.locator('#book-spread [data-object] [fill="#ffcc44"]').first()).toBeVisible();
  await field(page, "fill").dispatchEvent("change");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator('#book-spread [data-flow-style] > rect').first()).toHaveAttribute("fill", original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator('#book-spread [data-flow-style] > rect').first()).toHaveAttribute("fill", "#ffcc44");
  await page.getByRole("button", { name: "Add shape", exact: true }).click();
  await liveColor(page, "fill", ["#fdc08a", "#68ddbb"]);
  await expect(page.locator('#book-spread [data-object] [fill="#68ddbb"]').first()).toBeVisible();
  await addExtra(page, "table");
  await field(page, "tableStyle").selectOption("custom");
  await liveColor(page, "fill", ["#c0a3ea", "#abcdee"]);
  await expect(page.locator('#book-spread [data-object] [fill="#abcdee"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await liveColor(page, "style.color", ["#dd5599", "#3311aa"]);
  await expect(page.locator('#book-spread [data-object] [fill="#3311aa"]').first()).toBeVisible();
  await page.locator("summary").filter({ hasText: "Text spacing & effects" }).click();
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await liveColor(page, "style.highlight", ["#eeffcc", "#ffaacc"]);
  await expect(page.locator('#book-spread [fill="#ffaacc"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Page settings", exact: true }).click();
  await liveColor(page, "page.background", ["#ffffee", "#f1f4fb"]);
  await expect(page.locator('.book-sheet[data-active="true"] > svg > rect').first()).toHaveAttribute("fill", "#f1f4fb");
  const paletteSummary = page.locator("summary").filter({ hasText: "Book palette & themes" });
  if (!(await paletteSummary.locator("..").evaluate((el) => el.open))) await paletteSummary.click();
  await liveColor(page, "palette.0", ["#222288", "#003388"]);
  await expect(field(page, "palette.0")).toHaveValue("#003388");
});

test("xPED theme and page overrides survive reload, versions and backup import", async ({ page }) => {
  test.setTimeout(60000);
  await studio(page);
  await applyXped(page, "route", "dark");
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  await field(page, "versionName").fill("Navy route");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await applyXped(page, "shapes", "light");
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator('.book-version-preview [data-cover-variant="route"]')).toHaveCount(4);
  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  await expect(page.locator('#book-spread [data-cover-variant="route"]')).toHaveCount(1);
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.locator('#book-spread [data-cover-variant="route"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await expect(field(page, "page.background")).toHaveValue("#062940");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup", exact: true }).click();
  const file = await (await pending).path();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("link", { name: "Book Studio library", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#backup-input").setInputFiles(file);
  await expect(page.locator('#book-spread [data-cover-variant="route"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await expect(field(page, "page.background")).toHaveValue("#062940");
});

test('page number placement, typography, color and order survive saving and match print', async ({ page }) => {
  await studio(page);
  await applyXped(page, 'minimal', 'light');
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await field(page, 'styleName').selectOption('heading');
  await expect(field(page, 'style.color')).toHaveValue('#ffffff');
  await page.getByRole('button', { name: 'Page settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Page numbers$/ }).click();
  await field(page, 'pageNumbers.enabled').locator('..').click();
  await expect(page.locator('#book-spread [data-page-number]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next pages', exact: true }).click();
  await expect(page.locator('#book-spread [data-page-number]')).toHaveText(['1', '2']);
  await field(page, 'pageNumbers.position').selectOption('center');
  await expect(page.locator('#book-spread [data-page-number]').first()).toHaveAttribute('text-anchor', 'middle');
  await field(page, 'pageNumbers.font').selectOption('Nohemi');
  await expect(field(page, 'pageNumbers.weight')).toHaveValue('700');
  await field(page, 'pageNumbers.size').fill('12');
  await field(page, 'pageNumbers.colorMode').selectOption('custom');
  await liveColor(page, 'pageNumbers.color', ['#885511', '#007acc']);
  await expect(page.locator('#book-spread [data-page-number]').first()).toHaveAttribute('fill', '#007acc');
  await field(page, 'pageNumbers.position').selectOption('outer');
  await expect(page.locator('#book-spread [data-page-number]').nth(0)).toHaveAttribute('text-anchor', 'start');
  await expect(page.locator('#book-spread [data-page-number]').nth(1)).toHaveAttribute('text-anchor', 'end');
  await page.getByRole('button', { name: 'Duplicate page', exact: true }).click();
  await expect(page.locator('#page-list [data-page-number]')).toHaveText(['1', '2', '3']);
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect(page.locator('#page-list [data-interior-side]')).toHaveCount(3);
  await expect(page.locator('#page-list [data-page-number]')).toHaveText(['1', '2', '3']);
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  await page.reload();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('#print-preview [data-page-number]')).toHaveText(['1', '2', '3']);
  await expect(page.locator('#print-preview [data-page-number]').first()).toHaveAttribute('font-family', 'Nohemi');
});
