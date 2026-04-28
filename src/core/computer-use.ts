import type { Page } from "playwright";
import { getAnthropicClient, estimateCost } from "./llm.js";
import { getCostGuard } from "./cost-guard.js";

/**
 * Playwright-backed Claude Computer Use loop.
 *
 * Anthropic's reference uses Xvfb + a Linux desktop. We replace that with
 * Playwright primitives so we get:
 *   - real Chromium with stealth fingerprints (vs. Xvfb desktop)
 *   - same browser context as the rest of the audit (cookies, localStorage)
 *   - no Docker requirement
 *   - lightning-fast screenshots vs X11 grabs
 *
 * Coordinate scaling: Anthropic's vision pipeline downscales any image to
 * max 1568px long edge / ~1.15M pixels. We resize screenshots before sending
 * AND scale Claude's returned coordinates back up to the real viewport.
 */

const BETA_HEADER = "computer-use-2025-11-24";
const TOOL_TYPE = "computer_20251124";

const MAX_LONG_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

export interface ComputerUseOptions {
  page: Page;
  task: string;
  model: string;
  maxIterations?: number;
  systemPrompt?: string;
}

export interface ComputerUseResult {
  finalText: string;
  iterations: number;
  costUsd: number;
  history: Array<{ role: string; summary: string }>;
}

interface AnyContentBlock {
  type: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // text
  text?: string;
}

function getScaleFactor(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  const totalPixels = width * height;
  const longEdgeScale = MAX_LONG_EDGE / longEdge;
  const totalPixelsScale = Math.sqrt(MAX_PIXELS / totalPixels);
  return Math.min(1.0, longEdgeScale, totalPixelsScale);
}

/**
 * Run an autonomous Computer Use task against the given Playwright page.
 *
 * The function:
 *  1. Captures viewport size
 *  2. Loops: send screenshot + history → Claude → execute returned action
 *  3. Stops on no-tool-use response, error, or max iterations
 */
export async function runComputerUseTask(
  opts: ComputerUseOptions,
): Promise<ComputerUseResult> {
  const client = getAnthropicClient();
  const page = opts.page;
  const maxIter = opts.maxIterations ?? 15;

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Page has no viewport — Computer Use requires fixed viewport.");
  }
  const realWidth = viewport.width;
  const realHeight = viewport.height;
  const scale = getScaleFactor(realWidth, realHeight);
  const scaledWidth = Math.floor(realWidth * scale);
  const scaledHeight = Math.floor(realHeight * scale);

  const tools = [
    {
      type: TOOL_TYPE,
      name: "computer",
      display_width_px: scaledWidth,
      display_height_px: scaledHeight,
      display_number: 1,
    },
  ];

  // Build initial messages: a screenshot kickoff + the task description.
  const messages: Array<{
    role: "user" | "assistant";
    content: unknown;
  }> = [
    {
      role: "user",
      content: opts.task,
    },
  ];

  let totalCost = 0;
  let finalText = "";
  const history: Array<{ role: string; summary: string }> = [];

  for (let iter = 0; iter < maxIter; iter++) {
    // Cast the SDK to a permissive shape because the beta API surface evolves;
    // we already pin the beta header explicitly.
    const c = client as unknown as {
      beta: {
        messages: {
          create(args: Record<string, unknown>): Promise<{
            content: AnyContentBlock[];
            stop_reason?: string;
            usage: { input_tokens: number; output_tokens: number };
          }>;
        };
      };
    };

    const guard = getCostGuard();
    guard.checkBudget();
    const response = await c.beta.messages.create({
      model: opts.model,
      max_tokens: 4096,
      system:
        opts.systemPrompt ??
        "You are an expert QA engineer auditing a web product. After each step, take a screenshot and verify the outcome before continuing.",
      tools,
      messages,
      betas: [BETA_HEADER],
    });

    guard.recordUsage(
      opts.model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );
    totalCost += estimateCost(
      opts.model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const content = response.content as AnyContentBlock[];
    messages.push({ role: "assistant", content });

    // Collect text + tool uses
    const toolUses = content.filter((b) => b.type === "tool_use");
    const textBlocks = content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text ?? "").join("\n");
      history.push({ role: "assistant", summary: finalText.slice(0, 200) });
    }

    if (toolUses.length === 0) {
      // Done
      return { finalText, iterations: iter + 1, costUsd: totalCost, history };
    }

    // Execute each tool use sequentially
    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
      >;
      is_error?: boolean;
    }> = [];

    for (const tu of toolUses) {
      try {
        const result = await executeAction(
          page,
          tu.input ?? {},
          scale,
          realWidth,
          realHeight,
          scaledWidth,
          scaledHeight,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id ?? "",
          content: result,
        });
        history.push({
          role: "tool",
          summary: `${(tu.input?.action as string) ?? "unknown"} → ok`,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id ?? "",
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          is_error: true,
        });
        history.push({
          role: "tool",
          summary: `${(tu.input?.action as string) ?? "unknown"} → error`,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    finalText: finalText || "(max iterations reached)",
    iterations: maxIter,
    costUsd: totalCost,
    history,
  };
}

/**
 * Execute a single Computer Use action against a Playwright page.
 * Coordinates from Claude are in scaled space; we scale them back up.
 */
async function executeAction(
  page: Page,
  input: Record<string, unknown>,
  scale: number,
  realWidth: number,
  realHeight: number,
  scaledWidth: number,
  scaledHeight: number,
): Promise<
  Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
  >
> {
  const action = input.action as string;
  const coord = input.coordinate as [number, number] | undefined;
  const text = input.text as string | undefined;

  const realCoord = coord
    ? ([Math.round(coord[0] / scale), Math.round(coord[1] / scale)] as [number, number])
    : undefined;

  switch (action) {
    case "screenshot": {
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "left_click": {
      if (!realCoord) throw new Error("left_click requires coordinate");
      const modifier = parseModifier(text);
      if (modifier) {
        await page.keyboard.down(modifier);
      }
      await page.mouse.click(realCoord[0], realCoord[1]);
      if (modifier) {
        await page.keyboard.up(modifier);
      }
      await page.waitForTimeout(300);
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "right_click": {
      if (!realCoord) throw new Error("right_click requires coordinate");
      await page.mouse.click(realCoord[0], realCoord[1], { button: "right" });
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "middle_click": {
      if (!realCoord) throw new Error("middle_click requires coordinate");
      await page.mouse.click(realCoord[0], realCoord[1], { button: "middle" });
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "double_click": {
      if (!realCoord) throw new Error("double_click requires coordinate");
      await page.mouse.dblclick(realCoord[0], realCoord[1]);
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "triple_click": {
      if (!realCoord) throw new Error("triple_click requires coordinate");
      await page.mouse.click(realCoord[0], realCoord[1], { clickCount: 3 });
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "left_click_drag": {
      const startCoord = (input.start_coordinate as [number, number]) ?? coord;
      const endCoord = (input.end_coordinate as [number, number]) ?? undefined;
      if (!startCoord || !endCoord) {
        throw new Error("left_click_drag requires start and end coordinates");
      }
      await page.mouse.move(
        Math.round(startCoord[0] / scale),
        Math.round(startCoord[1] / scale),
      );
      await page.mouse.down();
      await page.mouse.move(
        Math.round(endCoord[0] / scale),
        Math.round(endCoord[1] / scale),
        { steps: 10 },
      );
      await page.mouse.up();
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "mouse_move": {
      if (!realCoord) throw new Error("mouse_move requires coordinate");
      await page.mouse.move(realCoord[0], realCoord[1]);
      return [{ type: "text", text: "moved" }];
    }
    case "type": {
      if (!text) throw new Error("type requires text");
      await page.keyboard.type(text, { delay: 20 });
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "key": {
      if (!text) throw new Error("key requires text");
      await page.keyboard.press(translateKey(text));
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "hold_key": {
      if (!text) throw new Error("hold_key requires text");
      const duration = (input.duration as number) ?? 1;
      await page.keyboard.down(translateKey(text));
      await page.waitForTimeout(duration * 1000);
      await page.keyboard.up(translateKey(text));
      return [{ type: "text", text: "held" }];
    }
    case "scroll": {
      const direction = (input.scroll_direction as string) ?? "down";
      const amount = (input.scroll_amount as number) ?? 3;
      const dx = direction === "left" ? -amount * 100 : direction === "right" ? amount * 100 : 0;
      const dy = direction === "up" ? -amount * 100 : direction === "down" ? amount * 100 : 0;
      if (realCoord) {
        await page.mouse.move(realCoord[0], realCoord[1]);
      }
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(300);
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    case "wait": {
      const duration = (input.duration as number) ?? 1;
      await page.waitForTimeout(duration * 1000);
      return [{ type: "text", text: `waited ${duration}s` }];
    }
    case "left_mouse_down": {
      if (!realCoord) throw new Error("left_mouse_down requires coordinate");
      await page.mouse.move(realCoord[0], realCoord[1]);
      await page.mouse.down();
      return [{ type: "text", text: "mouse down" }];
    }
    case "left_mouse_up": {
      if (!realCoord) throw new Error("left_mouse_up requires coordinate");
      await page.mouse.move(realCoord[0], realCoord[1]);
      await page.mouse.up();
      return [{ type: "text", text: "mouse up" }];
    }
    case "zoom": {
      // Zoom action: re-screenshot a region. We just take a fresh screenshot
      // since we don't actually need to zoom — the model can read it natively.
      return [await takeScaledScreenshot(page, scaledWidth, scaledHeight)];
    }
    default:
      throw new Error(`Unsupported computer-use action: ${action}`);
  }
}

async function takeScaledScreenshot(
  page: Page,
  scaledWidth: number,
  scaledHeight: number,
): Promise<{
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
}> {
  // Take native screenshot, then resize to the exact scaled dims we declared
  // in the tool definition. This ensures Claude's coordinate space matches
  // ours after we scale back up.
  const native = await page.screenshot({ type: "png", fullPage: false });

  // Use sharp if available; if not, fall back to sending the native buffer
  // (Claude will downsample on its side).
  try {
    const sharpMod = (await import("sharp").catch(() => null)) as
      | { default: (input: Buffer) => {
          resize: (w: number, h: number, opts: { fit: "fill" }) => {
            png: () => { toBuffer: () => Promise<Buffer> };
          };
        } }
      | null;
    if (sharpMod) {
      const resized = await sharpMod.default(native)
        .resize(scaledWidth, scaledHeight, { fit: "fill" })
        .png()
        .toBuffer();
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: resized.toString("base64"),
        },
      };
    }
  } catch {
    // fall through
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: native.toString("base64"),
    },
  };
}

function parseModifier(text?: string): "Shift" | "Control" | "Alt" | "Meta" | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t === "shift") return "Shift";
  if (t === "ctrl" || t === "control") return "Control";
  if (t === "alt") return "Alt";
  if (t === "super" || t === "meta" || t === "cmd") return "Meta";
  return undefined;
}

function translateKey(input: string): string {
  // Anthropic uses xdotool-style names; Playwright uses its own.
  const map: Record<string, string> = {
    Return: "Enter",
    return: "Enter",
    ctrl: "Control",
    super: "Meta",
    cmd: "Meta",
    Page_Down: "PageDown",
    Page_Up: "PageUp",
  };
  // Handle combos like "ctrl+s"
  if (input.includes("+")) {
    return input
      .split("+")
      .map((p) => map[p.trim()] ?? p.trim())
      .join("+");
  }
  return map[input] ?? input;
}
