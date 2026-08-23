import { Box, Text, render, useInput, useStdout } from "ink";
import { useMemo, useReducer, useRef } from "react";
import { glyphs, theme } from "../terminal/ink/theme.js";

export type OnboardingChoice =
  "connect" | "explore" | "classic" | "start" | "finish" | "cancel";

interface ChoiceRow {
  id: OnboardingChoice;
  label: string;
  hint: string;
}

export interface OnboardingLaunchpadProps {
  providerConfigured: boolean;
  unicode: boolean;
  onChoose: (choice: OnboardingChoice) => void;
}

export function OnboardingLaunchpad({
  providerConfigured,
  unicode,
  onChoose,
}: OnboardingLaunchpadProps) {
  const options = useMemo<ChoiceRow[]>(
    () =>
      providerConfigured
        ? [
            { id: "start", label: "Open Morrow", hint: "start working now" },
            {
              id: "finish",
              label: "Finish here",
              hint: "return to your terminal",
            },
            {
              id: "classic",
              label: "Customize setup",
              hint: "profile, modes, skills, and project",
            },
          ]
        : [
            {
              id: "connect",
              label: "Connect a model",
              hint: "the only step required to run tasks",
            },
            {
              id: "explore",
              label: "Explore first",
              hint: "skip setup; connect later",
            },
            {
              id: "classic",
              label: "Classic guided setup",
              hint: "configure every option",
            },
          ],
    [providerConfigured],
  );
  const selectedRef = useRef(0);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const selected = selectedRef.current;
  const { stdout } = useStdout();
  const width = Math.min(76, Math.max(44, stdout?.columns || 76));
  const g = glyphs(unicode);

  useInput((input, key) => {
    if (key.escape) return void onChoose("cancel");
    if (key.upArrow) {
      selectedRef.current =
        (selectedRef.current - 1 + options.length) % options.length;
      redraw();
      return;
    }
    if (key.downArrow) {
      selectedRef.current = (selectedRef.current + 1) % options.length;
      redraw();
      return;
    }
    if (key.return) return void onChoose(options[selectedRef.current]!.id);
    if (/^[1-3]$/.test(input))
      return void onChoose(options[Number(input) - 1]!.id);
  });

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box marginTop={1}>
        <Text bold color={theme.accent}>
          MORROW
        </Text>
        <Text color={theme.faint}> private · local-first · yours</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.copy}>
          Private intelligence, ready on your machine.
        </Text>
        <Text color={theme.soft}>
          See useful work before configuring a personality, skills, or a
          project.
        </Text>
      </Box>

      <Box
        borderColor={providerConfigured ? theme.success : theme.borderAccent}
        borderStyle={unicode ? "round" : "classic"}
        flexDirection="column"
        marginTop={1}
        paddingX={1}
      >
        <Text color={providerConfigured ? theme.success : theme.warning}>
          {providerConfigured
            ? `${g.done} A model is connected. Morrow can work.`
            : `${g.pending} Connect one model to run a task.`}
        </Text>
        <Text color={theme.faint}>
          Credentials stay local and go only to the provider you choose.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.faint}>Try this next:</Text>
        <Text color={theme.copy}>{'  morrow "Summarize this repository"'}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const active = index === selected;
          return (
            <Box key={option.id}>
              <Text color={active ? theme.accent : theme.faint}>
                {active ? `${g.chevron} ` : "  "}
              </Text>
              <Text
                bold={active}
                color={active ? theme.copy : theme.soft}
              >{`${index + 1}. ${option.label}`}</Text>
              <Text color={theme.faint}>{`  ${option.hint}`}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.faint}>↑↓ choose 1–3 jump ⏎ continue esc pause</Text>
      </Box>
    </Box>
  );
}

export function runOnboardingLaunchpad(input: {
  providerConfigured: boolean;
  unicode: boolean;
}): Promise<OnboardingChoice> {
  return new Promise((resolve) => {
    let settled = false;
    let instance: ReturnType<typeof render>;
    const choose = (choice: OnboardingChoice) => {
      if (settled) return;
      settled = true;
      instance.unmount();
      // Ink tears down asynchronously: `unmount()` only starts it, and stdin
      // stays in raw mode with Ink's listeners attached until `waitUntilExit`
      // settles. Resolving before then hands a raw-mode stdin to whatever runs
      // next -- and the classic flow runs next, on `readline`, which never sees
      // a line event because raw mode does not emit them. The prompt then hangs
      // forever and Node reports an unsettled top-level await instead of asking
      // the question. Wait for the real teardown, then restore cooked mode
      // ourselves: Ink's own cleanup assumes the process is exiting, which is
      // exactly the assumption the "Customize setup" path breaks.
      void instance.waitUntilExit().then(() => {
        const stdin = process.stdin;
        if (
          stdin.isTTY &&
          stdin.isRaw &&
          typeof stdin.setRawMode === "function"
        ) {
          stdin.setRawMode(false);
        }
        stdin.resume();
        resolve(choice);
      });
    };
    instance = render(
      <OnboardingLaunchpad
        providerConfigured={input.providerConfigured}
        unicode={input.unicode}
        onChoose={choose}
      />,
      { exitOnCtrlC: false },
    );
  });
}
