import os from "node:os";
import chalk from "chalk";
import {memo, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {Box, Text, Spacer, measureElement, useApp, useInput, usePaste, useStdin, useWindowSize} from "ink";
import type {DOMElement} from "ink";
import type {Mode} from "../config.js";
import type {PreviewLine, Todo, ToolView} from "../types.js";
import {formatDuration, formatTokens, type Activity} from "../ui.js";
import {useFrame} from "./clock.js";
import {ACCENT, Header, MODE_COLOR, type HeaderInfo} from "./Header.js";
import {gradientAt} from "./logo.js";
import {renderMarkdown} from "../markdown.js";
import type {SlashCommand} from "../slash.js";
import type {EntryKind, NoteTone, Store} from "./store.js";
import {highlight} from "../diff.js";

/** SGR mouse reports (enabled in tui.tsx): button 64 is the wheel turned up, 65 down. */
// eslint-disable-next-line no-control-regex
const MOUSE_REPORT = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

export interface TuiConfig {
  model: string;
  baseURL: string;
  cwd: string;
  mode: Mode;
  version: string;
  /** For the completion menu that opens on "/". */
  commands?: SlashCommand[];
  /** Take the mouse wheel to scroll the conversation (NGOBE_MOUSE=0 leaves the mouse to the terminal). */
  mouse?: boolean;
  /** Where pasted clipboard images are saved (under clipboard/). */
  stateDir?: string;
}

interface Props {
  store: Store;
  config: TuiConfig;
  onInterrupt: () => boolean;
  /** ctrl+v: save the clipboard's image and return its path (null: no image). */
  onPasteImage?: () => Promise<string | null>;
  /** shift+tab */
  onModeCycle?: () => void;
  /** Any typing in the prompt (warms the model up again after a break). */
  onTyping?: () => void;
}

const MAX_RENDERED_ENTRIES = 300; // keep long sessions snappy; older ones fall off
const PREVIEW_LINES = 10;
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export function App({store, config, onInterrupt, onModeCycle, onTyping, onPasteImage}: Props) {
  useSyncExternalStore(store.subscribe, () => store.version);
  const {rows, columns} = useWindowSize();
  const {exit} = useApp();
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const [viewH, setViewH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const [stick, setStick] = useState(true); // keep the transcript pinned to the latest line
  const [offset, setOffset] = useState(0); // contentOffsetY while the user has scrolled up

  useEffect(() => {
    if (store.exitRequested) exit();
  }, [store.exitRequested, exit]);

  // Measure the viewport and the transcript after every render so the scroll window stays exact.
  useEffect(() => {
    const view = viewportRef.current ? measureElement(viewportRef.current).height : 0;
    const content = contentRef.current ? measureElement(contentRef.current).height : 0;
    if (view !== viewH) setViewH(view);
    if (content !== contentH) setContentH(content);
  });

  const maxOffset = Math.max(0, contentH - viewH);
  const scrolled = !stick && maxOffset > 0;
  const top = stick ? maxOffset : Math.min(offset, maxOffset);

  // Content that fits entirely (e.g. right after /clear) snaps back to the bottom.
  useEffect(() => {
    if (maxOffset === 0 && !stick) {
      setStick(true);
      setOffset(0);
    }
  }, [maxOffset, stick]);

  // Several wheel steps can arrive before the next render: count from the latest position.
  const position = useRef(top);
  position.current = top;
  const scrollBy = (delta: number) => {
    const next = Math.max(0, position.current + delta);
    position.current = Math.min(next, maxOffset);
    if (next >= maxOffset) {
      setStick(true);
      setOffset(0);
    } else {
      setStick(false);
      setOffset(next);
    }
  };

  // The mouse wheel scrolls the conversation only. Ink drops mouse reports before useInput, so
  // read them from the raw input: a "data" listener sees each chunk as Ink reads it.
  const {stdin} = useStdin();
  const wheel = useRef(scrollBy);
  wheel.current = scrollBy;
  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      for (const m of String(chunk).matchAll(MOUSE_REPORT)) {
        const button = Number(m[1]);
        if (button & 64) wheel.current(button & 1 ? 3 : -3);
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  useInput((_input, key) => {
    const page = Math.max(1, viewH - 2);
    if (key.pageUp) scrollBy(-page);
    else if (key.pageDown) scrollBy(page);
    else if (key.shift && key.upArrow) scrollBy(-3);
    else if (key.shift && key.downArrow) scrollBy(3);
  });

  const info: HeaderInfo = useMemo(
    () => ({version: config.version, model: store.model || config.model, server: serverOf(config.baseURL), cwd: tilde(config.cwd), mode: store.mode}),
    [config, store.mode, store.model],
  );
  const busy = store.busy;
  const openTodos = store.todos.length > 0 && (busy || store.todos.some((t) => t.status !== "completed"));

  return (
    <Box flexDirection="column" height={rows}>
      <Header info={info} busy={busy} rows={rows} columns={columns} />

      <Box ref={viewportRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" contentOffsetY={top}>
        <Box flexDirection="column" flexShrink={0} ref={contentRef}>
          {store.trust ? <TrustDialog dir={tilde(store.trust.dir)} choice={store.trust.choice} /> : store.entries.length === 0 ? <Welcome /> : null}
          {store.entries.slice(-MAX_RENDERED_ENTRIES).map((e) => (
            <EntryView key={e.id} kind={e.kind} text={e.text} tone={e.tone} view={e.view} />
          ))}
          {store.confirm ? <ConfirmPanel prompt={store.confirm.prompt} /> : null}
        </Box>
      </Box>

      {store.activity && !store.confirm ? <ActivityLine activity={store.activity} /> : null}
      {openTodos ? <TodoPanel todos={store.todos} /> : null}

      <Box height={1} paddingX={1} gap={1} marginTop={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {tilde(config.cwd)}
        </Text>
        <Spacer />
        <Text wrap="truncate-start">
          {scrolled ? <Text color="yellow">↑ {maxOffset - top} more lines below · </Text> : null}
          {store.queuedCount ? <Text dimColor>{store.queuedCount} queued · </Text> : null}
          <Text color={MODE_COLOR[store.mode]}>{store.mode} mode</Text>
        </Text>
      </Box>

      <Box flexShrink={0}>
        <InputBox
          store={store}
          commands={config.commands ?? []}
          onModeCycle={onModeCycle}
          onPasteImage={onPasteImage}
          onCtrlC={onInterrupt}
          onActivity={() => {
            onTyping?.();
            if (!stick) {
              setStick(true);
              setOffset(0);
            }
          }}
        />
      </Box>

      <Box height={1} paddingX={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {store.trust
            ? "↑/↓ choose · enter confirm · esc exit"
            : store.confirm
            ? "y allow · n deny · a always this session · esc deny"
            : busy
              ? "esc interrupt · type ahead to queue · PgUp/PgDn or ⇧↑/⇧↓ scroll"
              : "enter send · / commands · shift+tab mode · ctrl+v paste image · wheel/PgUp scroll · /help"}
        </Text>
      </Box>
    </Box>
  );
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

function serverOf(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return baseURL;
  }
}

function TrustDialog({dir, choice}: {dir: string; choice: number}) {
  const options = ["Yes, proceed", "No, exit"];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={2} paddingY={1} marginTop={1} marginX={1}>
      <Text bold color={ACCENT}>
        Do you trust the files in this folder?
      </Text>
      <Text> </Text>
      <Text bold>{dir}</Text>
      <Text> </Text>
      <Text>
        ngobe may read files in this folder, and their contents (AGENTS.md, custom agents) go into its context. Reading untrusted files can
        lead it to behave in unexpected ways.
      </Text>
      <Text>With your permission ngobe may also run commands and change files here. Running untrusted code is unsafe.</Text>
      <Text> </Text>
      {options.map((o, i) => (
        <Text key={o} color={i === choice ? ACCENT : undefined} bold={i === choice}>
          {i === choice ? "❯" : " "} {i + 1}. {o}
        </Text>
      ))}
    </Box>
  );
}

function Welcome() {
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text>
        <Text color={ACCENT}>✻</Text> What should we build? <Text dimColor>Describe a task, ask a question, or paste an error.</Text>
      </Text>
      <Text dimColor>  /help for commands · ngobe --mode plan to plan before changing anything</Text>
    </Box>
  );
}

// --- transcript ----------------------------------------------------------------

const NOTE_COLOR: Record<NoteTone, string> = {info: "gray", warn: "yellow", error: "red"};
const STATE_COLOR: Record<ToolView["state"], string> = {running: "gray", ok: "green", error: "red", declined: "yellow"};
const TONE_COLOR: Record<NonNullable<PreviewLine["tone"]>, string | undefined> = {add: "green", remove: "red", context: undefined, dim: undefined, error: "red"};
// Diff rows, as in Claude Code: removed lines on red, added on green, across the row.
const DIFF_BG = {add: "#12361d", remove: "#3d1418"} as const;
const DIFF_LINES = 30;

const EntryView = memo(
  function EntryView({kind, text, tone, view}: {kind: EntryKind; text: string; tone?: NoteTone; view?: Readonly<ToolView>}) {
    switch (kind) {
      case "user":
        return (
          <Box paddingX={1} marginTop={1}>
            <Box width={2} flexShrink={0}>
              <Text color={ACCENT} bold>
                ❯
              </Text>
            </Box>
            <Text bold>{text}</Text>
          </Box>
        );
      case "assistant":
        return (
          <Box paddingX={1} marginTop={1}>
            <Box width={2} flexShrink={0}>
              <Text>⏺</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={text} />
            </Box>
          </Box>
        );
      case "tool":
        return view ? <ToolRow view={view} /> : null;
      case "done":
        return (
          <Box paddingX={1} marginTop={1}>
            <Text color={tone === "warn" ? "yellow" : undefined} dimColor={tone !== "warn"}>
              ✻ {text}
            </Text>
          </Box>
        );
      case "note":
        return (
          <Box paddingX={1} marginTop={1}>
            <Box width={2} flexShrink={0}>
              <Text color={NOTE_COLOR[tone ?? "info"]}>●</Text>
            </Box>
            <Text color={tone === "info" ? undefined : NOTE_COLOR[tone ?? "info"]} dimColor={tone === "info"}>
              {text}
            </Text>
          </Box>
        );
      default:
        return null;
    }
  },
  (a, b) => a.kind === b.kind && a.text === b.text && a.tone === b.tone && a.view === b.view,
);

/** "⏺ Bash(npm test)" / "  ⎿  exit 0 · 3.1s" / preview lines; the dot pulses while it runs. */
function ToolRow({view}: {view: Readonly<ToolView>}) {
  const running = view.state === "running";
  const frame = useFrame(running);
  const dot = running ? (frame % 10 < 5 ? "white" : "gray") : STATE_COLOR[view.state];
  const preview = view.preview ?? [];
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={dot}>⏺ </Text>
        <Text bold>{view.label}</Text>
        {view.target ? <Text dimColor>({view.target})</Text> : null}
      </Text>
      {running ? (
        <Text dimColor>  ⎿  Running…</Text>
      ) : view.summary ? (
        <Text wrap="truncate-end">
          <Text dimColor>  ⎿  </Text>
          <Text color={view.state === "error" ? "red" : view.state === "declined" ? "yellow" : undefined} dimColor={view.state === "ok"}>
            {view.summary}
          </Text>
        </Text>
      ) : null}
      {!running && isDiff(preview) ? (
        <DiffRows lines={preview} />
      ) : (
        !running &&
        preview.slice(0, PREVIEW_LINES).map((p, i) => (
          <Text key={i} wrap="truncate-end" color={p.tone ? TONE_COLOR[p.tone] : undefined} dimColor={p.tone === "dim" || !p.tone}>
            {"     "}
            {p.text}
          </Text>
        ))
      )}
      {!running && !isDiff(preview) && preview.length > PREVIEW_LINES ? <Text dimColor>{`     … +${preview.length - PREVIEW_LINES} lines`}</Text> : null}
    </Box>
  );
}

function isDiff(preview: PreviewLine[]): boolean {
  return preview.some((p) => p.line !== undefined);
}

/** "  45 -  old line" on red, "  45 +  new line" on green, context plain; numbers padded alike. */
function DiffRows({lines}: {lines: PreviewLine[]}) {
  const shown = lines.slice(0, DIFF_LINES);
  const width = Math.max(...shown.map((p) => String(p.line ?? "").length));
  return (
    <>
      {shown.map((p, i) =>
        p.line === undefined ? (
          <Text key={i} dimColor>{`     ${" ".repeat(width)}   ${p.text}`}</Text>
        ) : (
          <Box key={i} marginLeft={5} backgroundColor={p.tone === "add" || p.tone === "remove" ? DIFF_BG[p.tone] : undefined}>
            <Text wrap="wrap">
              <Text dimColor>{String(p.line).padStart(width)} </Text>
              <Text color={p.tone === "add" ? "green" : p.tone === "remove" ? "red" : undefined}>{p.tone === "add" ? "+" : p.tone === "remove" ? "-" : " "} </Text>
              {highlight(p.text, p.lang).map((s, j) => (
                <Text key={j} color={s.color}>
                  {s.text}
                </Text>
              ))}
            </Text>
          </Box>
        ),
      )}
      {lines.length > DIFF_LINES ? <Text dimColor>{`     … +${lines.length - DIFF_LINES} lines`}</Text> : null}
    </>
  );
}

/** The reply rendered as terminal markdown (see markdown.ts). */
function Markdown({text}: {text: string}) {
  return (
    <>
      {renderMarkdown(text || " ").map((line, i) => (
        <Text key={i}>{line || " "}</Text>
      ))}
    </>
  );
}

function ConfirmPanel({prompt}: {prompt: string}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} marginX={1}>
      <Text color="yellow" bold>
        Permission needed
      </Text>
      <Text>{prompt}</Text>
    </Box>
  );
}

// --- live status -----------------------------------------------------------------

/** "✻ Running tests… (34s · 2.8k tokens · esc to interrupt)", with a light running over the words. */
function ActivityLine({activity}: {activity: Activity}) {
  const frame = useFrame(true);
  const glyph = SPINNER[frame % SPINNER.length];
  const [r, g, b] = gradientAt(frame / 40);
  const label = `${activity.label}…`;
  const at = frame % (label.length + 8);
  const shimmer = [...label].map((ch, i) => (Math.abs(i - at) <= 1 ? chalk.hex("#fff6dc")(ch) : chalk.hex(ACCENT)(ch))).join("");
  const stats = [formatDuration(Date.now() - activity.since), activity.tokens ? `${formatTokens(activity.tokens)} tokens` : "", "esc to interrupt"]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box paddingX={1} marginTop={1} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={`rgb(${r},${g},${b})`}>{glyph} </Text>
        {shimmer}
        <Text dimColor> ({stats})</Text>
      </Text>
    </Box>
  );
}

const TODO_MARK: Record<Todo["status"], string> = {pending: "☐", in_progress: "◐", completed: "☒"};
const MAX_TODOS = 7;

function TodoPanel({todos}: {todos: Todo[]}) {
  // Long lists: keep the item in progress in view.
  const current = Math.max(0, todos.findIndex((t) => t.status === "in_progress"));
  const from = Math.max(0, Math.min(current - 2, todos.length - MAX_TODOS));
  const shown = todos.slice(from, from + MAX_TODOS);
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      {shown.map((t, i) => (
        <Text key={from + i} wrap="truncate-end">
          <Text dimColor>{i === 0 ? "  ⎿  " : "     "}</Text>
          {t.status === "in_progress" ? (
            <Text bold color={ACCENT}>
              {TODO_MARK[t.status]} {t.activeForm || t.content}
            </Text>
          ) : t.status === "completed" ? (
            <Text dimColor strikethrough>
              {TODO_MARK[t.status]} {t.content}
            </Text>
          ) : (
            <Text>
              {TODO_MARK[t.status]} {t.content}
            </Text>
          )}
        </Text>
      ))}
      {todos.length > shown.length ? <Text dimColor>{`     … ${todos.length - shown.length} more`}</Text> : null}
    </Box>
  );
}

// --- input -----------------------------------------------------------------------

const MAX_SUGGESTIONS = 7;

/** Commands matching what's typed after "/" (names first, then aliases). */
function suggest(commands: SlashCommand[], value: string): SlashCommand[] {
  if (!/^\/[\w-]*$/.test(value)) return [];
  const q = value.slice(1).toLowerCase();
  return [
    ...commands.filter((c) => c.name.startsWith(q)),
    ...commands.filter((c) => !c.name.startsWith(q) && c.aliases?.some((a) => a.startsWith(q))),
  ];
}

function InputBox({
  store,
  commands,
  onModeCycle,
  onCtrlC,
  onActivity,
  onPasteImage,
}: {
  store: Store;
  commands: SlashCommand[];
  onModeCycle?: () => void;
  onPasteImage?: () => Promise<string | null>;
  onCtrlC: () => boolean;
  onActivity: () => void;
}) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const suggestions = suggest(commands, value);
  const pick = suggestions[Math.min(selected, suggestions.length - 1)];
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const insert = (s: string) => {
    setValue(value.slice(0, cursor) + s + value.slice(cursor));
    setCursor(cursor + s.length);
  };

  usePaste((text) => {
    if (store.confirm) return;
    insert(text.replace(/\r\n?/g, "\n"));
    onActivity();
  });

  // ctrl+v: a screenshot on the clipboard becomes a file path in the prompt (cmd+v still pastes text).
  const pasteImage = () => {
    if (!onPasteImage) return;
    void onPasteImage().then((file) => {
      if (!file) {
        store.note("info", "No image on the clipboard. Copy a screenshot first (Cmd+Ctrl+Shift+4 on macOS), or drag the file into the terminal.");
        return;
      }
      setValue((v) => {
        const next = `${v}${v && !v.endsWith(" ") ? " " : ""}${file} `;
        setCursor(next.length);
        return next;
      });
      onActivity();
    });
  };

  const showHistory = (index: number | null) => {
    if (index === null) {
      setValue(draft);
      setCursor(draft.length);
      setHistIndex(null);
    } else {
      const text = store.history[index];
      setValue(text);
      setCursor(text.length);
      setHistIndex(index);
    }
  };

  const submit = (text: string) => {
    if (text.trim() === "") return;
    store.submit(text);
    setHistIndex(null);
  };

  useInput((input, key) => {
    if (store.trust) {
      if (key.upArrow) store.moveTrustChoice(0);
      else if (key.downArrow) store.moveTrustChoice(1);
      else if (key.return) store.answerTrust(store.trust.choice === 0);
      else if (input === "1" || input === "y") store.answerTrust(true);
      else if (input === "2" || input === "n" || key.escape || (key.ctrl && input === "c")) store.answerTrust(false);
      return;
    }
    if (key.tab && key.shift) {
      if (!store.confirm) onModeCycle?.();
      return;
    }
    if (key.ctrl && input === "v" && !store.confirm) {
      pasteImage();
      return;
    }
    if (key.ctrl && input === "c") {
      if (onCtrlC()) return; // cancelled a run
      if (value) {
        // Clear typed text first; Ctrl+C at an empty prompt quits.
        setValue("");
        setCursor(0);
        setHistIndex(null);
      } else {
        store.requestExit();
      }
      return;
    }

    if (store.confirm) {
      if (input === "y" || input === "Y") store.answerConfirm("y");
      else if (input === "n" || input === "N" || key.escape) store.answerConfirm("n");
      else if (input === "a") store.answerConfirm("a");
      return;
    }

    // Scrolling keys belong to the transcript (App), not the prompt.
    if (key.pageUp || key.pageDown || (key.shift && (key.upArrow || key.downArrow))) return;
    // Esc interrupts a run (like Ctrl+C); with text typed it clears the prompt first.
    if (key.escape && !value && store.busy) {
      onCtrlC();
      return;
    }

    onActivity();

    // The "/" menu: ↑/↓ choose, tab completes, enter runs the highlighted command.
    if (suggestions.length && pick) {
      if (key.upArrow || key.downArrow) {
        const n = Math.min(suggestions.length, MAX_SUGGESTIONS);
        setSelected((Math.min(selected, n - 1) + (key.upArrow ? n - 1 : 1)) % n);
        return;
      }
      if (key.tab) {
        const text = `/${pick.name}${pick.args ? " " : ""}`;
        setValue(text);
        setCursor(text.length);
        setSelected(0);
        return;
      }
      if (key.return && value !== `/${pick.name}`) {
        submit(`/${pick.name}`);
        setValue("");
        setCursor(0);
        setSelected(0);
        return;
      }
    }

    if (key.backspace) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
      }
    } else if (key.delete) {
      if (cursor < value.length) setValue(value.slice(0, cursor) + value.slice(cursor + 1));
    } else if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
    } else if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1));
    } else if (key.home || (key.ctrl && input === "a")) {
      setCursor(0);
    } else if (key.end || (key.ctrl && input === "e")) {
      setCursor(value.length);
    } else if (key.upArrow) {
      if (store.history.length === 0) return;
      if (histIndex === null) {
        setDraft(value);
        showHistory(store.history.length - 1);
      } else if (histIndex > 0) {
        showHistory(histIndex - 1);
      }
    } else if (key.downArrow) {
      if (histIndex === null) return;
      showHistory(histIndex < store.history.length - 1 ? histIndex + 1 : null);
    } else if (key.escape) {
      setValue("");
      setCursor(0);
      setHistIndex(null);
    } else if (key.ctrl && input === "u") {
      setValue(value.slice(cursor));
      setCursor(0);
    } else if (key.ctrl && input === "k") {
      setValue(value.slice(0, cursor));
    } else if (key.ctrl && input === "w") {
      let i = cursor;
      while (i > 0 && value[i - 1] === " ") i--;
      while (i > 0 && value[i - 1] !== " ") i--;
      setValue(value.slice(0, i) + value.slice(cursor));
      setCursor(i);
    } else {
      // Text input. Terminals may batch several keystrokes into one event
      // (fast typing, unbracketed paste, piped input), so embedded CR/LF
      // are treated as Enter presses, not literal newlines.
      const text = key.return ? "\r" : input;
      if (!text || key.meta || key.tab) return;
      let current = value;
      let pos = cursor;
      const parts = text.split(/[\r\n]/);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) {
          current = current.slice(0, pos) + parts[i] + current.slice(pos);
          pos += parts[i].length;
        }
        if (i < parts.length - 1) {
          submit(current);
          current = "";
          pos = 0;
        }
      }
      setValue(current);
      setCursor(pos);
      setSelected(0);
    }
  });

  // Locate the cursor for rendering. Cursor display assumes lines don't wrap.
  const lines = value.split("\n");
  let remaining = cursor;
  let cursorLine = lines.length - 1;
  let cursorCol = lines[cursorLine].length;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].length) {
      cursorLine = i;
      cursorCol = remaining;
      break;
    }
    remaining -= lines[i].length + 1;
  }

  const confirm = store.confirm;
  const menu = confirm || store.trust ? [] : suggestions.slice(0, MAX_SUGGESTIONS);
  const nameWidth = Math.max(0, ...menu.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length));
  return (
    <Box flexDirection="column" flexGrow={1}>
    <Box
      borderStyle="round"
      borderColor={confirm ? "yellow" : ACCENT}
      borderDimColor={!confirm}
      paddingX={1}
      flexDirection="column"
      minHeight={4}
      maxHeight={10}
      overflowY="hidden"
    >
      {store.trust ? (
        <Text dimColor>Trust this folder? 1 yes · 2 no</Text>
      ) : confirm ? (
        <Text wrap="truncate-end">
          <Text bold color="yellow">
            ?{" "}
          </Text>
          <Text color="white">{confirm.prompt.split("\n")[0]}</Text> <Text dimColor>[y/n/a]</Text>
        </Text>
      ) : (
        <Text>
          <Text color={ACCENT}>❯ </Text>
          {lines.length === 1 && lines[0] === "" ? (
            <>
              <Text inverse> </Text>
              <Text dimColor> Ask ngobe anything · / for commands · drop a file path to read it</Text>
            </>
          ) : null}
          {(lines.length === 1 && lines[0] === "" ? [] : lines).map((line, i) => (
            <Text key={i}>
              {i > 0 ? "\n" : ""}
              {i === cursorLine ? (
                <>
                  {line.slice(0, cursorCol)}
                  <Text inverse>{line[cursorCol] ?? " "}</Text>
                  {line.slice(cursorCol + 1)}
                </>
              ) : (
                line
              )}
            </Text>
          ))}
        </Text>
      )}
    </Box>
      {menu.map((c, i) => {
        const on = c === pick;
        return (
          <Box key={c.name} paddingX={1}>
            <Text wrap="truncate-end">
              <Text color={on ? ACCENT : undefined} bold={on}>
                {(on ? "❯ " : "  ") + `/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(nameWidth + 2)}
              </Text>
              <Text dimColor={!on}>{c.description}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
