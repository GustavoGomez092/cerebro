// The chat's Markdown renderer: answers render as Markdown, never as raw HTML, and links open safely.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/ui/markdown";

const html = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>);

test("Markdown renders bold, lists, headings and code spans", () => {
  const out = html("## Recent work\n\n- **landing page** hero\n- session `a1b2c3`\n");
  expect(out).toContain("<h2>Recent work</h2>");
  expect(out).toContain("<strong>landing page</strong>");
  expect(out).toContain("<li>");
  expect(out).toContain("a1b2c3</code>");
  expect(out).not.toContain("**");
});

test("raw HTML in an answer is never rendered as HTML", () => {
  const out = html('Hi <script>alert(1)</script> <img src=x onerror="alert(2)"> <b>x</b>\n\n<div onclick="y()">block</div>');
  expect(out).not.toContain("<script");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<div onclick");
  expect(out).not.toContain("<b>");
});

test("links open in a new tab with noreferrer noopener, and javascript: links are dropped", () => {
  const out = html("[report](https://example.com/r) and [bad](javascript:alert(1))");
  expect(out).toContain('href="https://example.com/r"');
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noreferrer noopener"');
  expect(out).not.toContain("javascript:");
});

test("a half-streamed fence (no code yet) renders instead of throwing", () => {
  expect(html("Here:\n\n```bash\n")).toContain("<pre");
  expect(html("```\n\n```")).toContain("<pre");
});

test("fenced code renders as a plain code block (no HTML injection path)", () => {
  const out = html("```bash\nbun test <web>\n```");
  expect(out).toContain("<pre");
  expect(out).toContain("bun test &lt;web&gt;");
});
