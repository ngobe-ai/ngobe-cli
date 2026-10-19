import {useEffect, useRef, useState, useSyncExternalStore} from "react";
import {Box, Text, Spacer, measureElement, useApp, useInput, usePaste, useWindowSize} from "ink";
import type {DOMElement} from "ink";
import type {Entry, NoteTone, Store} from "./store.js";

export interface TuiConfig {
  model: string;
  baseURL: string;
  cwd: string;
  yolo: boolean;
}

interface Props {
  store: Store;
  config: TuiConfig;
  onInterrupt: () => boolean;
}

const HEADER_H = 1;
const HINT_H = 1;

export function App({store, config, onInterrupt}: Props) {
  useSyncExternalStore(store.subscribe, () => store.version);
  const {rows} = useWindowSize();
  const {exit} = useApp();
  const contentRef = useRef<DOMElement>(null);
  const inputRef = useRef<DOMElement>(null);
  const [contentH, setContentH] = useState(0);
  const [inputH, setInputH] = useState(1);
  const [stick, setStick] = useState(true); // keep the transcript pinned to the latest line
  const [offset, setOffset] = useState(0); // contentOffsetY while the user has scrolled up

  useEffect(() => {
    if (store.exitRequested) exit();
  }, [store.exitRequested, exit]);

  // Measure the transcript and input after every render so the scroll window stays exact.
  useEffect(() => {
    const content = contentRef.current ? measureElement(contentRef.current).height : 0;
    const input = inputRef.current ? measureElement(inputRef.current).height : 1;
    if (content !== contentH) setContentH(content);
    if (input !== inputH) setInputH(input);
  });

  const bodyH = Math.max(1, rows - HEADER_H - HINT_H - inputH);
  const maxOffset = Math.max(0, contentH - bodyH);
  const scrolled = !stick && maxOffset > 0;

  // Content that fits entirely (e.g. right after /clear) snaps back to the bottom.
  useEffect(() => {
    if (maxOffset === 0 && !stick) {
      setStick(true);
      setOffset(0);
    }
  }, [maxOffset, stick]);

  useInput((_input, key) => {
    if (key.pageUp) {
      setStick(false);
      setOffset((o) => Math.max(0, o - Math.max(1, bodyH - 2)));
    } else if (key.pageDown && !stick) {
      const next = offset + Math.max(1, bodyH - 2);
      if (next >= maxOffset) {
        setStick(true);
        setOffset(0);
      } else {
        setOffset(next);
      }
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={HEADER_H} gap={1}>
        <Text wrap="truncate-end">
          <Text bold color="cyan">
            mugamba
          </Text>
          <Text dimColor>
            {" "}
            · {config.model} · {config.baseURL}
          </Text>
        </Text>
        <Spacer />
        <Text wrap="truncate-start">
          <Text dimColor>{config.cwd}</Text>
          {config.yolo ? <Text color="yellow"> [yolo]</Text> : null}
          {store.status ? <Text dimColor> · {store.status}</Text> : null}
          {scrolled ? <Text color="yellow"> · scrolled, PgDn for latest</Text> : null}
        </Text>
      </Box>

      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        contentOffsetY={stick ? maxOffset : Math.min(offset, maxOffset)}
      >
        <Box flexDirection="column" flexShrink={0} ref={contentRef}>
          {store.entries.map((e) => (
            <EntryView key={e.id} entry={e} />
          ))}
        </Box>
      </Box>

      <Box flexShrink={0} ref={inputRef}>
        <InputBox
          store={store}
          onCtrlC={onInterrupt}
          onActivity={() => {
            if (!stick) {
              setStick(true);
              setOffset(0);
            }
          }}
        />
      </Box>

      <Box height={HINT_H} paddingLeft={1}>
        <Text dimColor>
          {store.confirm
            ? "y allow · n deny · a always (non-shell) · esc deny"
            : "enter send · paste for multi-line · PgUp/PgDn scroll · /help"}
        </Text>
      </Box>
    </Box>
  );
}

const NOTE_COLOR: Record<NoteTone, string> = {info: "gray", warn: "yellow", error: "red"};

function EntryView({entry}: {entry: Entry}) {
  switch (entry.kind) {
    case "user":
      return (
        <Box paddingX={1} gap={1}>
          <Text bold color="cyan">
            ❯
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box paddingX={1}>
          <Text>{entry.text || " "}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box paddingX={1}>
          <Text color="cyan">
            • {entry.text}
          </Text>
        </Box>
      );
    case "note":
      return (
        <Box paddingX={1}>
          <Text color={NOTE_COLOR[entry.tone ?? "info"]}>{entry.text}</Text>
        </Box>
      );
  }
}

function InputBox({
  store,
  onCtrlC,
  onActivity,
}: {
  store: Store;
  onCtrlC: () => boolean;
  onActivity: () => void;
}) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
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
    if (key.ctrl && input === "c") {
      if (!onCtrlC()) store.requestExit();
      return;
    }

    if (store.confirm) {
      if (input === "y" || input === "Y") store.answerConfirm("y");
      else if (input === "n" || input === "N" || key.escape) store.answerConfirm("n");
      else if (input === "a") store.answerConfirm("a");
      return;
    }

    onActivity();

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
  return (
    <Box
      borderStyle="round"
      borderColor={confirm ? "yellow" : "gray"}
      paddingX={1}
      flexDirection="column"
      maxHeight={8}
      overflowY="hidden"
    >
      {confirm ? (
        <Text>
          <Text bold color="yellow">
            ?{" "}
          </Text>
          {confirm.prompt} <Text dimColor>[y/n/a]</Text>
        </Text>
      ) : (
        <Text>
          <Text bold color="cyan">
            ❯{" "}
          </Text>
          {lines.map((line, i) => (
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
  );
}
