/**
 * Captures `demo/less-search.gif` from the real Hunk TUI.
 *
 * Drives an actual `hunk` binary inside a PTY (tuistory), renders each styled
 * terminal state to a retina PNG (ghostty-opentui), and assembles the timeline
 * into a looping GIF with ffmpeg. Nothing here is a mockup: every frame is the
 * extension running against `demo/config-cache.patch`.
 *
 * The session runs under a throwaway `XDG_CONFIG_HOME` holding the one config
 * line the README recommends, so the recording shows `/` opening the prompt
 * rather than the default `ctrl+f`, and so an installed copy of this extension
 * cannot load alongside the checkout being recorded.
 *
 * Usage, from the repository root:
 *   bun run capture:demo
 *
 * Needs `hunk` (0.19.0 or newer) and `ffmpeg` on PATH; override either with
 * HUNK= or FFMPEG=. Optional, Unix-oriented maintainer task — tests never run
 * it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTerminal, type Session } from "tuistory";

// ghostty-opentui is tuistory's own dependency; resolve it from tuistory's real
// location so this script needs no direct dependency on it.
const tuistoryEntry = createRequire(import.meta.url).resolve("tuistory");
const ghosttyImageEntry = createRequire(tuistoryEntry).resolve("ghostty-opentui/image");
const { renderTerminalToImage } = await import(ghosttyImageEntry);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const demoDir = join(repoRoot, "demo");
const patchPath = join(demoDir, "config-cache.patch");
const gifPath = join(demoDir, "less-search.gif");

const hunk = process.env.HUNK ?? "hunk";
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

/** Terminal geometry: wide enough for real code, short enough to read as a GIF. */
const COLS = 104;
const ROWS = 28;

/** Must mirror ghostty-opentui's image math. */
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.4;
const DPR = 2;

/** Playback rate and the pixel width the GIF is scaled down to. */
const FPS = 12;
const GIF_WIDTH = 1040;

/** The search the recording performs. */
const PATTERN = "readConfig";

function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}

function run(command: string, args: string[]) {
  const proc = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.status !== 0) {
    const stderrTail = (proc.stderr ?? "").split("\n").slice(-12).join("\n");
    throw new Error(`${command} ${args.slice(0, 4).join(" ")}… failed:\n${stderrTail}`);
  }
}

/** A recorded terminal state and how long the GIF should hold it. */
interface Frame {
  png: Buffer;
  holdMs: number;
}

/**
 * Records terminal states on demand, merging a repeat into the previous frame's
 * hold so a still moment costs one GIF frame instead of many.
 */
class Timeline {
  private frames: Frame[] = [];

  constructor(private session: Session) {}

  /** Capture the current terminal state and hold it. */
  async hold(holdMs: number) {
    const png: Buffer = await renderTerminalToImage(this.session.getTerminalData(), {
      format: "png",
      devicePixelRatio: DPR,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
    });
    const previous = this.frames.at(-1);
    if (previous && previous.png.equals(png)) {
      previous.holdMs += holdMs;
      return;
    }
    this.frames.push({ png, holdMs });
  }

  /** Press a key, let the TUI settle, and record what it painted. */
  async press(key: string, settleMs: number, holdMs: number) {
    await this.session.press(key as Parameters<Session["press"]>[0]);
    await sleep(settleMs);
    await this.hold(holdMs);
  }

  /** Type a pattern one character per frame, so the prompt visibly fills in. */
  async typePattern(pattern: string, perCharMs: number) {
    for (const character of pattern) {
      this.session.writeRaw(character);
      await sleep(90);
      await this.hold(perCharMs);
    }
  }

  /** Encode the timeline into a looping GIF through a two-pass ffmpeg palette. */
  async writeGif(outputPath: string) {
    if (this.frames.length === 0) {
      throw new Error("nothing was recorded");
    }

    const workDir = mkdtempSync(join(tmpdir(), "less-search-demo-"));
    try {
      const framePaths = this.frames.map((frame, index) => {
        const framePath = join(workDir, `frame-${String(index).padStart(3, "0")}.png`);
        writeFileSync(framePath, frame.png);
        return framePath;
      });

      const concatLines = ["ffconcat version 1.0"];
      this.frames.forEach((frame, index) => {
        concatLines.push(`file '${framePaths[index]}'`);
        concatLines.push(`duration ${(frame.holdMs / 1000).toFixed(3)}`);
      });
      // The concat demuxer needs the last file repeated to honor its duration.
      concatLines.push(`file '${framePaths.at(-1)}'`);
      const concatPath = join(workDir, "timeline.ffconcat");
      writeFileSync(concatPath, `${concatLines.join("\n")}\n`);

      // A generated palette keeps syntax highlighting and the match marks
      // distinguishable; GIF's 256 colors are not enough for a naive quantize.
      const scale = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
      const palettePath = join(workDir, "palette.png");
      run(ffmpeg, [
        "-y",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-vf",
        `${scale},palettegen=stats_mode=diff`,
        palettePath,
      ]);
      run(ffmpeg, [
        "-y",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-i",
        palettePath,
        "-lavfi",
        `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
        "-loop",
        "0",
        outputPath,
      ]);

      const seconds = this.frames.reduce((total, frame) => total + frame.holdMs, 0) / 1000;
      console.log(
        `${outputPath}: ${this.frames.length} frames, ${seconds.toFixed(1)}s, ` +
          `${(Bun.file(outputPath).size / 1_000_000).toFixed(2)} MB`,
      );
    } finally {
      // A failed encode must not strand retina frames in the temp directory.
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/**
 * Launch Hunk on the demo patch with this checkout loaded as an extension.
 *
 * The throwaway config home carries the `/` handover from the README and keeps
 * an installed copy of the extension out of the session, which would otherwise
 * refuse the checkout as a duplicate id.
 */
async function launchDemo() {
  const configHome = mkdtempSync(join(tmpdir(), "less-search-config-"));
  mkdirSync(join(configHome, "hunk"), { recursive: true });
  writeFileSync(
    join(configHome, "hunk", "config.toml"),
    ['[keybindings]', '"hunk-less-search.find" = "/"', ""].join("\n"),
  );

  const session = await launchTerminal({
    command: hunk,
    args: ["patch", patchPath, "--extension", repoRoot],
    cwd: repoRoot,
    cols: COLS,
    rows: ROWS,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
    },
  });

  return {
    session,
    cleanup: () => {
      session.close();
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

/**
 * Prove the TUI is taking keys before the storyboard starts.
 *
 * The first keypress after startup can land before the app subscribes, which
 * would silently drop the `/` that opens the prompt; toggling help is a
 * visible, reversible way to wait for input to be live.
 */
async function ensureKeyboardIsLive(session: Session) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await session.press("?");
    try {
      await session.waitForText(/Keyboard|Shortcuts|Help/i, { timeout: 1_000 });
      await session.press("escape");
      await sleep(400);
      return;
    } catch {
      // Keys are not live yet; try again.
    }
  }
  throw new Error("the TUI never acknowledged a keypress");
}

async function captureDemo() {
  const { session, cleanup } = await launchDemo();
  try {
    await session.waitForText(/load\.ts/, { timeout: 30_000 });
    await sleep(1_200);
    await ensureKeyboardIsLive(session);

    const timeline = new Timeline(session);

    // The idle prompt line, before anything is searched.
    await timeline.hold(1_400);

    // `/` opens the prompt, then the pattern is typed into it in place.
    await timeline.press("/", 350, 700);
    await timeline.typePattern(PATTERN, 140);
    await timeline.hold(700);

    // Enter jumps to the first match: marks appear in the diff, and the same
    // line that took the pattern now reports where the review landed.
    await timeline.press("enter", 600, 2_600);

    // `n` repeats it, hunk by hunk and file by file; `N` walks back.
    for (let step = 0; step < 3; step += 1) {
      await timeline.press("n", 500, 2_000);
    }
    await timeline.press("N", 500, 2_000);

    await timeline.hold(900);
    await timeline.writeGif(gifPath);
  } finally {
    cleanup();
  }
}

mkdirSync(demoDir, { recursive: true });
await captureDemo();
process.exit(0);
