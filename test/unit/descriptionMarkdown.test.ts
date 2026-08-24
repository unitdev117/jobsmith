import { describe, expect, test } from "bun:test";
import {
  isWrappedDescription,
  renderDescription,
  unwrapDescription,
} from "../../src/server/descriptionMarkdown.ts";

describe("wrapped markdown descriptions", () => {
  test("unwrapped plain text never renders", () => {
    expect(renderDescription("just plain words")).toBeNull();
    expect(renderDescription("curly { braces } mid-string")).toBeNull();
    expect(isWrappedDescription("{x}")).toBe(true);
    // Trim rule: surrounding whitespace does not defeat the wrapper.
    expect(isWrappedDescription("  {x}")).toBe(true);
    expect(isWrappedDescription("{x} \n")).toBe(true);
  });

  test("empty bodies and lone braces fall back to raw display", () => {
    expect(renderDescription("{}")).toBeNull();
    expect(renderDescription("{   }")).toBeNull();
    expect(renderDescription("{")).toBeNull();
    expect(unwrapDescription(" { a b } ")).toBe("a b");
  });

  test("renders headings with the expected tag", () => {
    const html = renderDescription("{# Release notes}");
    expect(html).toContain("<h1>Release notes</h1>");
  });

  test("renders bold, italic, lists, quotes, tables, tasks, strikes", () => {
    const html = renderDescription(
      "{**bold** *italic*\n\n- one\n- two\n\n1. first\n\n2. second\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~}",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('type="checkbox"');
  });

  test("fenced code preserves content verbatim, including braces", () => {
    const html = renderDescription('{```\n{ "a": 1 }\n```}');
    expect(html).toContain("<pre><code>");
    expect(html).toContain("{ &quot;a&quot;: 1 }");
  });

  test("raw HTML survives only as escaped text", () => {
    const html = renderDescription(
      "{<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<b>bold claim</b>}",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    // Escaped text may still spell out the payload; only elements are fatal.
    expect(html!.replaceAll(/&lt;[^&]*&gt;/g, "")).not.toContain("onerror=");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;");
  });

  test("keeps only http, https, and mailto link destinations", () => {
    const html = renderDescription(
      "{[safe](https://ok.com) [plain](http://ok.com) [mail](mailto:a@b.c)}",
    );
    expect(html).toContain('href="https://ok.com"');
    expect(html).toContain('href="http://ok.com"');
    expect(html).toContain('href="mailto:a@b.c"');
  });

  test("dead-ends unsafe schemes while keeping visible labels", () => {
    const html = renderDescription(
      "{[js](javascript:x) [JS](JAVASCRIPT:x) [data](data:text/html,x) [rel](//host/p) [vbs](vbscript:x)}",
    );
    expect((html!.match(/href="#"/g) ?? []).length).toBe(5);
    expect(html).toContain(">js</a>");
    expect(html).toContain(">data</a>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("vbscript:");
  });

  test("query ampersands survive entity round-trips", () => {
    const html = renderDescription("{[q](https://ok.com/?a=1&b=2)}");
    expect(html).toContain('href="https://ok.com/?a=1&amp;b=2"');
  });

  test("embedded images are dropped entirely", () => {
    const html = renderDescription("{![alt](https://x.com/a.png)}");
    expect(html).not.toContain("<img");
    expect(html).toContain("<p>");
  });

  test("single newlines stay in one paragraph; blank lines split them", () => {
    const soft = renderDescription("{line one\nline two}")!;
    expect(soft.match(/<p>/g)).toHaveLength(1);
    expect(soft).not.toContain("<br");
    expect(soft).toContain("line one\nline two");
    const split = renderDescription("{one\n\ntwo}")!;
    expect(split.match(/<p>/g)).toHaveLength(2);
  });
});
