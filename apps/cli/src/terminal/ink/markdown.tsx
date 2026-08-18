import { Box, Text } from "ink";
import { parseBlocks, type Block, type InlineSpan } from "../markdown-blocks.js";
import { glyphs, theme } from "./theme.js";

/**
 * Assistant prose, rendered.
 *
 * Before this, an answer was one flat `<Text>`, so `**Build & edit**` reached
 * the screen with its asterisks intact and a fenced code block was
 * indistinguishable from a sentence. Nothing about that is a colour problem —
 * it is the absence of structure, which is what made long answers tiring to
 * read.
 *
 * Blocks come from the shared parser, so this file only decides how each one
 * looks. Ink owns wrapping: spans are separate `<Text>` nodes inside a wrapping
 * parent rather than a pre-styled ANSI string, which is what keeps a bolded
 * phrase from breaking the line maths.
 */

function Span({ span }: { span: InlineSpan }) {
  switch (span.kind) {
    case "bold":
      return <Text bold color={theme.copy}>{span.text}</Text>;
    case "italic":
      return <Text italic color={theme.copy}>{span.text}</Text>;
    case "code":
      return <Text color={theme.mdCode}>{span.text}</Text>;
    case "link":
      // The href is kept but dimmed: a link whose target is hidden is a link
      // nobody can act on from a terminal.
      return (
        <Text>
          <Text color={theme.mdLink} underline>{span.text}</Text>
          <Text color={theme.faint}> ({span.href})</Text>
        </Text>
      );
    default:
      return <Text color={theme.copy}>{span.text}</Text>;
  }
}

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <Text>
      {spans.map((span, index) => (
        <Span key={index} span={span} />
      ))}
    </Text>
  );
}

function BlockView({ block, unicode, width }: { block: Block; unicode: boolean; width: number }) {
  const g = glyphs(unicode);

  switch (block.kind) {
    case "heading":
      return (
        <Box marginTop={1}>
          <Text bold color={theme.mdHeading}>
            <Spans spans={block.spans} />
          </Text>
        </Box>
      );

    case "bullet":
      return (
        <Box paddingLeft={block.depth * 2}>
          <Text color={theme.mdBullet}>{g.bullet} </Text>
          <Box flexGrow={1}>
            <Spans spans={block.spans} />
          </Box>
        </Box>
      );

    case "numbered":
      return (
        <Box paddingLeft={block.depth * 2}>
          <Text color={theme.mdBullet}>{block.marker} </Text>
          <Box flexGrow={1}>
            <Spans spans={block.spans} />
          </Box>
        </Box>
      );

    case "quote":
      return (
        <Box>
          <Text color={theme.mdQuote}>{g.quote} </Text>
          <Text color={theme.mdQuote} italic>
            <Spans spans={block.spans} />
          </Text>
        </Box>
      );

    case "code":
      return (
        <Box
          borderColor={theme.mdCodeFence}
          borderStyle="round"
          flexDirection="column"
          marginY={1}
          paddingX={1}
          width={Math.min(width, 100)}
        >
          {block.lang ? <Text color={theme.faint}>{block.lang}</Text> : null}
          {block.lines.map((line, index) => (
            <Text color={theme.mdCodeBlock} key={index}>
              {line || " "}
            </Text>
          ))}
        </Box>
      );

    case "rule":
      return (
        <Box marginY={1}>
          <Text color={theme.mdRule}>{g.rule.repeat(Math.min(width, 60))}</Text>
        </Box>
      );

    case "blank":
      return <Text> </Text>;

    default:
      return <Spans spans={block.spans} />;
  }
}

export function Markdown({ text, unicode, width }: { text: string; unicode: boolean; width: number }) {
  const blocks = parseBlocks(text);
  // Leading and trailing blanks are the model's formatting habits, not content;
  // honouring them would open every answer with an empty line.
  let start = 0;
  let end = blocks.length;
  while (start < end && blocks[start]?.kind === "blank") start += 1;
  while (end > start && blocks[end - 1]?.kind === "blank") end -= 1;

  return (
    <Box flexDirection="column">
      {blocks.slice(start, end).map((block, index) => (
        <BlockView block={block} key={index} unicode={unicode} width={width} />
      ))}
    </Box>
  );
}
