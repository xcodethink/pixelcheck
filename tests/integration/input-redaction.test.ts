import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { redactSensitiveInputs } from "../../src/core/recorder.js";

/**
 * Input redaction is what stands between a password field and the vision API.
 * Three things were wrong with it, all measured here in a real browser.
 *
 * It only walked the main frame's light DOM. A card number inside an iframe
 * kept its value, and so did a password inside an open shadow root — while the
 * function's own comment named Stripe, which renders its fields in exactly
 * such a frame.
 *
 * The replacement was permanent. Measured end to end: fill a password, take a
 * screenshot, submit — and the form submitted `********`. The site rejects the
 * login and the audit records a finding against the site for a fault in this
 * tool, which is the worst shape a bug can take in an auditing product.
 *
 * Failures were swallowed by a bare catch under a comment saying the caller
 * should log them. No caller did.
 *
 * A note on why this file exists rather than a unit test: the redaction runs
 * inside `page.evaluate`, and the first rewrite of it failed there and nowhere
 * else. esbuild wraps named functions in `__name(...)` to preserve
 * Function.name, that helper does not exist in the page, and the pass threw
 * `ReferenceError: __name is not defined` and redacted nothing at all — while
 * typechecking, linting and every unit test stayed green. Only a browser says
 * whether this code runs.
 */

let browser: Browser;
let page: Page;

const FIXTURE = `
  <form id="f" onsubmit="document.getElementById('sent').textContent=document.getElementById('pw').value;return false">
    <input type="password" id="pw" value="hunter2-REAL">
    <input name="card_number" id="cc" value="4242424242424242">
    <input name="username" id="user" value="alice@example.test">
    <input type="text" id="empty" name="password_empty" value="">
    <button id="go">Login</button>
  </form>
  <div id="sent"></div>
  <div id="host"></div>
  <iframe id="pay" srcdoc='<input name="card_number" id="ifcc" value="4111111111111111">'></iframe>
  <script>
    const sr = document.getElementById('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<input type="password" id="spw" value="shadow-SECRET">';
  </script>
`;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function values(): Promise<Record<string, string>> {
  return {
    pw: await page.$eval("#pw", (e) => (e as HTMLInputElement).value),
    cc: await page.$eval("#cc", (e) => (e as HTMLInputElement).value),
    user: await page.$eval("#user", (e) => (e as HTMLInputElement).value),
    shadow: await page.evaluate(
      () =>
        (
          (document.getElementById("host") as HTMLElement)
            .shadowRoot!.querySelector("#spw") as HTMLInputElement
        ).value,
    ),
    iframe: await page
      .frames()
      .find((f) => f !== page.mainFrame())!
      .$eval("#ifcc", (e) => (e as HTMLInputElement).value),
  };
}

beforeAll(async () => {
  page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.waitForTimeout(300);
});

describe("what redaction has to reach", () => {
  it("redacts across the main frame, an iframe and an open shadow root", async () => {
    const pass = await redactSensitiveInputs(page);
    const v = await values();

    expect(v.pw).toBe("********");
    expect(v.cc).toBe("********");
    // The two that were missed. An iframe is the normal shape for a hosted
    // payment field, which is the case the docs named.
    expect(v.iframe).toBe("********");
    expect(v.shadow).toBe("********");

    expect(pass.redacted).toBe(4);
    expect(pass.unreachableFrames).toBe(0);

    await pass.restore();
  });

  it("leaves a field that is not sensitive alone", async () => {
    // Over-redaction is the safer failure, but a pass that blanked everything
    // would make every screenshot useless and still satisfy the assertions
    // above.
    const pass = await redactSensitiveInputs(page);
    expect((await values()).user).toBe("alice@example.test");
    await pass.restore();
  });

  it("does not count an empty sensitive field", async () => {
    // `password_empty` matches the name pattern but holds nothing, so there is
    // nothing to redact or restore.
    const pass = await redactSensitiveInputs(page);
    expect(pass.redacted).toBe(4);
    await pass.restore();
  });
});

describe("restoring", () => {
  it("puts every value back exactly", async () => {
    const before = await values();
    const pass = await redactSensitiveInputs(page);
    await pass.restore();
    expect(await values()).toEqual(before);
  });

  it("leaves no marker attribute behind", async () => {
    const pass = await redactSensitiveInputs(page);
    await pass.restore();
    const left = await page.evaluate(
      () => document.querySelectorAll("[data-pixelcheck-redacted]").length,
    );
    expect(left).toBe(0);
  });

  it("is safe to call twice", async () => {
    const pass = await redactSensitiveInputs(page);
    await pass.restore();
    await pass.restore();
    expect((await values()).pw).toBe("hunter2-REAL");
  });

  it("lets the form submit its real value afterwards", async () => {
    // The measured defect: before restore existed, this submitted `********`,
    // and the audit would have recorded a login failure against the site.
    const fresh = await browser.newPage();
    try {
      await fresh.setContent(FIXTURE);
      await fresh.waitForTimeout(200);
      const pass = await redactSensitiveInputs(fresh);
      await fresh.screenshot();
      await pass.restore();
      await fresh.click("#go");
      expect(await fresh.$eval("#sent", (e) => e.textContent)).toBe("hunter2-REAL");
    } finally {
      await fresh.close();
    }
  });
});

describe("the screenshot itself", () => {
  it("is taken while the values are replaced", async () => {
    // The property the whole control exists for. Compared as pixels: a shot
    // taken during the pass must differ from one taken after restoring.
    const fresh = await browser.newPage();
    try {
      await fresh.setContent(
        `<input type="password" id="pw" value="hunter2REAL" style="font-size:40px;width:600px">`,
      );
      const pass = await redactSensitiveInputs(fresh);
      const during = await fresh.screenshot();
      await pass.restore();
      const after = await fresh.screenshot();
      expect(Buffer.compare(during, after)).not.toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
