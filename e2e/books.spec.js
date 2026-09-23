const { test, expect } = require("@playwright/test");
const fs = require("fs");
const tinyPNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAACWCAYAAACb3McZAAABnklEQVR4nO3VMRGAMAAEwYB/JamRgwgkxEByGNgtv7/5653fM4Ctez8DAoEfHgSCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBMbZAjdEBFaP6faTAAAAAElFTkSuQmCC",
  "base64",
);

async function localStudio(page) {
  await page.route("**/static/js/firebase-bootstrap.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};",
    }),
  );
  await page.goto("/books");
  await page.getByRole("button", { name: "＋ New book", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Picture book A little room for a big adventure.",
      exact: true,
    })
    .click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
}
const field = (page, name) => page.locator('[data-field="' + name + '"]');

test("local books fit the viewport, retain text, respect focus and manage pages", async ({
  page,
}) => {
  await localStudio(page);
  const pageBounds = await page.locator(".book-sheet").boundingBox();
  const viewport = page.viewportSize();
  expect(pageBounds.height).toBeLessThan(viewport.height - 130);
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Text", exact: true })
    .fill("A small fox found a bright idea.");
  await field(page, "style.font").selectOption("Andika");
  await field(page, "style.weight").selectOption("700");
  await expect(field(page, "style.weight")).toHaveValue("700");
  await field(page, "style.font").selectOption("Nunito");
  await expect(field(page, "style.weight")).toHaveAttribute("type", "range");
  await page.locator("#object-text").press("ArrowRight");
  await expect(page.locator("#page-position")).toHaveText("Front cover");
  await page.locator("#book-spread").click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Shift+N");
  await expect(page.locator(".book-thumb")).toHaveCount(5);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".book-thumb")).toHaveCount(4);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".book-thumb")).toHaveCount(5);
  await page.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(page.locator(".book-thumb")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Version history", exact: true })
    .click();
  await page.locator("summary").filter({ hasText: "Deleted pages" }).click();
  await page.getByRole("button", { name: "Restore page", exact: true }).click();
  await expect(page.locator(".book-thumb")).toHaveCount(5);
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.locator(".book-thumb")).toHaveCount(5);
  if (
    await page
      .getByRole("button", { name: "First page", exact: true })
      .isEnabled()
  )
    await page.getByRole("button", { name: "First page", exact: true }).click();
  await expect(page.locator("#book-spread svg")).toContainText(
    "A small fox found a bright idea.",
  );
});

test("multiple image drops target the visible page, stay small and undo together", async ({
  page,
}) => {
  await localStudio(page);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  const sheet = page.locator(".book-sheet").nth(1),
    box = await sheet.boundingBox();
  const data = await page.evaluateHandle((bytes) => {
    const d = new DataTransfer();
    for (const name of ["one.png", "two.png"])
      d.items.add(
        new File([new Uint8Array(bytes)], name, { type: "image/png" }),
      );
    return d;
  }, Array.from(tinyPNG));
  await sheet.dispatchEvent("dragover", { dataTransfer: data });
  await expect(sheet).toHaveClass(/drop-target/);
  await sheet.dispatchEvent("drop", {
    dataTransfer: data,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await expect(sheet.locator("image")).toHaveCount(2);
  await expect(
    page.locator(".book-sheet").first().locator("image"),
  ).toHaveCount(0);
  expect(Number(await field(page, "w").inputValue())).toBeLessThanOrEqual(74.3);
  expect(Number(await field(page, "h").inputValue())).toBeLessThanOrEqual(105);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(sheet.locator("image")).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(sheet.locator("image")).toHaveCount(2);
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.reload();
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await expect(page.locator(".book-sheet").nth(1).locator("image")).toHaveCount(
    2,
  );
});

test("file picker, invalid images, backup and all print export choices work", async ({
  page,
}) => {
  test.setTimeout(120000);
  await localStudio(page);
  await page.locator("#image-input").setInputFiles({
    name: "sketch.png",
    mimeType: "image/png",
    buffer: tinyPNG,
  });
  await expect(page.locator("#book-spread image")).toHaveCount(1);
  await page.locator("#image-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator("#upload-list")).toContainText(
    "Choose a PNG, JPEG or WebP image.",
  );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  for (const [format, arrangement] of [
    ["faithful", "cut"],
    ["faithful", "fold"],
    ["editable", "cut"],
    ["editable", "fold"],
    ["pdf", "cut"],
  ]) {
    await field(page, "exportFormat").selectOption(format);
    await field(page, "arrangement").selectOption(arrangement);
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await pending;
    const file = await download.path();
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    expect(download.suggestedFilename()).toMatch(
      format === "pdf" ? /\.pdf$/ : /\.docx$/,
    );
  }
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download backup", exact: true })
    .click();
  const archive = await (await pending).path();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("link", { name: "Book Studio library", exact: true })
    .click();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#backup-input").setInputFiles(archive);
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#book-spread image")).toHaveCount(1);
  await expect(page.locator("#book-title")).toHaveValue(/imported/);
});

test("mobile navigation, drawing and reduced-motion remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await localStudio(page);
  await expect(page.locator(".book-sheet")).toHaveCount(1);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  const metrics = await page.evaluate(() => ({
    width: document.body.scrollWidth,
    viewport: innerWidth,
    animation: getComputedStyle(document.getElementById("book-spread"))
      .animationName,
    nav: document.querySelector(".book-navigation").getBoundingClientRect()
      .bottom,
  }));
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.animation).toBe("none");
  expect(metrics.nav).toBeLessThanOrEqual(844);
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  const sheet = page.locator(".book-sheet");
  const box = await sheet.boundingBox();
  await sheet.dispatchEvent("pointerdown", {
    pointerType: "pen",
    pointerId: 1,
    clientX: box.x + 30,
    clientY: box.y + 100,
    pressure: 0.7,
    bubbles: true,
  });
  await page.dispatchEvent("body", "pointermove", {
    pointerType: "pen",
    pointerId: 1,
    clientX: box.x + 100,
    clientY: box.y + 120,
    pressure: 0.3,
    bubbles: true,
  });
  await page.dispatchEvent("body", "pointerup", {
    pointerType: "pen",
    pointerId: 1,
    bubbles: true,
  });
  await expect(page.locator("#book-spread svg path")).not.toHaveCount(0);
  await page
    .getByRole("button", { name: "Page settings", exact: true })
    .click();
  await expect(page.locator("#inspector")).toBeVisible();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator(".book-toolbar")).toBeHidden();
});

const settingsTab = (page) =>
  page.getByRole("tab", { name: "Settings", exact: true });
const layersTab = (page) => page.getByRole("tab", { name: /Layers ·/ });
const canvasItems = (page) =>
  page.locator("#book-spread > .book-sheet > svg > g > g[data-object]");
async function leaveCanvasSelection(page) {
  await page.locator("#book-viewport").click({ position: { x: 5, y: 5 } });
}

test("text edits on the page, selectors apply once, typing undoes together and settings truly close", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await localStudio(page);
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Edit text on page",
    exact: true,
  });
  await editor.fill("The moon kept a little secret.");
  await editor.press("End");
  await editor.pressSequentially(" A fox found it.");
  await editor.press("Escape");
  await expect(page.locator("#object-text")).toHaveValue(
    "The moon kept a little secret. A fox found it.",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#book-spread svg").first()).toContainText(
    "Your story starts here.",
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await canvasItems(page).last().dblclick();
  await expect(editor).toHaveValue(
    "The moon kept a little secret. A fox found it.",
  );
  await editor.press("Escape");
  await field(page, "style.font").selectOption("Comic Neue");
  await field(page, "style.weight").selectOption("700");
  await expect(field(page, "style.weight")).toHaveValue("700");
  await field(page, "style.font").selectOption("Andika");
  await expect(field(page, "style.font")).toHaveValue("Andika");
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(page.locator("#workspace")).toHaveClass(/inspector-closed/);
  await leaveCanvasSelection(page);
  await expect(page.locator(".book-selection")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Page settings", exact: true })
    .click();
  await expect(page.locator("#inspector")).toBeVisible();
  expect(errors).toEqual([]);
});

test("pill proportions, object copy and paste, layer ordering and lock/visibility controls work", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await localStudio(page);
  await page.getByRole("button", { name: "Add shape", exact: true }).click();
  await field(page, "shape").selectOption("pill");
  expect(+(await field(page, "w").inputValue())).toBeGreaterThan(
    1.6 * +(await field(page, "h").inputValue()),
  );
  const original = await canvasItems(page).count();
  await page.locator(".book-sheet").press("ControlOrMeta+c");
  await page.locator(".book-sheet").press("ControlOrMeta+v");
  await expect(canvasItems(page)).toHaveCount(original + 1);
  await layersTab(page).click();
  const top = page.locator(".book-layer").first();
  const copied = await top
    .locator("[data-select-object]")
    .getAttribute("data-select-object");
  await expect(top.locator("[data-layer-up]")).toBeDisabled();
  await top.locator("[data-layer-down]").click();
  await expect(
    page.locator(".book-layer").nth(1).locator("[data-select-object]"),
  ).toHaveAttribute("data-select-object", copied);
  await page.locator(`[data-lock="${copied}"]`).first().click();
  await settingsTab(page).click();
  await expect(field(page, "shape")).toBeDisabled();
  await page
    .getByRole("button", { name: "Unlock object", exact: true })
    .click();
  await expect(field(page, "shape")).toBeEnabled();
  await layersTab(page).click();
  await page.locator(`#book-layers [data-hide="${copied}"]`).click();
  await expect(canvasItems(page)).toHaveCount(original);
  await expect(page.locator(`[data-select-object="${copied}"]`)).toContainText(
    "Hidden",
  );
  await page.locator(`#book-layers [data-hide="${copied}"]`).click();
  await expect(canvasItems(page)).toHaveCount(original + 1);
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.reload();
  await expect(canvasItems(page)).toHaveCount(original + 1);
});

test("layout guides persist, drag snaps to a third, alignment, zoom and backdrop dismissal work", async ({
  page,
}) => {
  await localStudio(page);
  await page.locator("summary").filter({ hasText: "Layout guides" }).click();
  await field(page, "grid").check();
  await field(page, "thirds").check();
  await field(page, "rulers").check();
  await expect(page.locator(".book-grid-overlay")).toHaveCount(1);
  expect(await page.locator(".book-ruler-x text").count()).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Add shape", exact: true }).click();
  await field(page, "w").fill("20");
  await field(page, "h").fill("20");
  const box = await page.locator(".book-sheet").boundingBox(),
    scale = box.width / 148.5;
  const shape = await canvasItems(page).last().boundingBox();
  await page.mouse.move(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 49.5 * scale + 1, box.y + 70 * scale + 1, {
    steps: 5,
  });
  await expect(page.locator(".book-drag-guides")).toBeVisible();
  await page.mouse.up();
  await page
    .locator("summary")
    .filter({ hasText: "Position & rotation" })
    .click();
  expect(+(await field(page, "x").inputValue())).toBeCloseTo(39.5, 1);
  expect(+(await field(page, "y").inputValue())).toBeCloseTo(60, 1);
  await page.getByRole("button", { name: "Middle", exact: true }).click();
  expect(+(await field(page, "y").inputValue())).toBeCloseTo(95, 1);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator("#zoom-value")).toHaveText("110%");
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  await expect(page.locator("#zoom-value")).toHaveText("100%");
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  await page.mouse.click(5, 5);
  await expect(page.locator("#book-dialog")).not.toBeVisible();
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.locator(".book-grid-overlay")).toHaveCount(1);
  await expect(page.locator(".book-ruler-x")).toBeVisible();
});

test("book tables and story diagrams edit cells and steps and survive backup/reload", async ({
  page,
}) => {
  await localStudio(page);
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  await page.locator('[data-extra="table"]').click();
  await page
    .getByRole("textbox", { name: "Row 2, column 1", exact: true })
    .fill("Moon fox");
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Row 2, column 3", exact: true })
    .fill("A secret");
  await field(page, "tableHeader").uncheck();
  await field(page, "tableRounded").uncheck();
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  await page.locator('[data-extra="flow"]').click();
  await page
    .getByRole("textbox", { name: "Step 1", exact: true })
    .fill("Find the moon");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Step 4", exact: true })
    .fill("Share the light");
  await page
    .getByRole("button", { name: "Move step 4 up", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Step 3", exact: true }),
  ).toHaveValue("Share the light");
  await field(page, "flowDirection").selectOption("horizontal");
  await field(page, "flowShape").selectOption("pill");
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.reload();
  await page.getByRole("button", { name: "Next pages", exact: true }).click();
  await page
    .getByRole("button", { name: "Page settings", exact: true })
    .click();
  await layersTab(page).click();
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await settingsTab(page).click();
  await expect(field(page, "flowDirection")).toHaveValue("horizontal");
  await expect(
    page.getByRole("textbox", { name: "Step 3", exact: true }),
  ).toHaveValue("Share the light");
  await layersTab(page).click();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await settingsTab(page).click();
  await expect(field(page, "tableHeader")).not.toBeChecked();
  await expect(
    page.getByRole("textbox", { name: "Row 2, column 3", exact: true }),
  ).toHaveValue("A secret");
});

test("themes, page organization, version preview/restore and searchable help are usable", async ({
  page,
}) => {
  await localStudio(page);
  await page
    .locator("summary")
    .filter({ hasText: "Book palette & themes" })
    .click();
  await page
    .getByRole("button", { name: "Choose a book theme", exact: true })
    .click();
  await page.locator('[data-theme="1"]').click();
  await page
    .getByRole("button", { name: "Apply Woodland tales", exact: true })
    .click();
  await expect(field(page, "page.background")).toHaveValue("#fbfaf0");
  await page
    .getByRole("button", { name: "Version history", exact: true })
    .click();
  await field(page, "versionName").fill("Woodland draft");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.locator(".book-version")).toContainText("4 pages");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await field(page, "page.title").fill("The clearing");
  await page.getByRole("button", { name: "Move later", exact: true }).click();
  await expect(page.locator('.book-thumb[aria-current="true"]')).toContainText(
    "The clearing",
  );
  await page
    .getByRole("button", { name: "Version history", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".book-version-preview figure")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Restore this version", exact: true })
    .click();
  await expect(page.locator(".book-thumb")).toHaveCount(4);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".book-thumb")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Keyboard shortcuts", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search shortcuts", exact: true })
    .fill("Paste");
  await expect(page.locator(".book-shortcut:visible")).toHaveCount(2);
});
