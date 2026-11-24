# ohnomaxx.github.io

Blog space powered by Jekyll.

Might looks better at https://ohnomaxx.github.io/

## Note changelog

Write a normal Markdown section at the start of the note body, after the closing
front-matter `---`:

```markdown
## 更新日志

- 2026-11-10：补充唤醒流程说明。
- 2026-11-08：初稿。

## 正文

Note content starts here.
```

The first heading may be `logs`, `Changelog`, `Change log`, `更新日志`, `修改记录`, or
`变更记录`. Its section ends at the next heading of the same or higher level.
Entries retain their Markdown formatting and written order. The site turns this
section into an expandable panel labeled `logs` at the bottom of the note,
using content already in the page;
there are no GitHub requests or YAML changelog fields. Without JavaScript, the
section remains readable as ordinary Markdown. Notes without this opening section
are unchanged.
