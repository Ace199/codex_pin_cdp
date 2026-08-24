import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  comparableComposerText,
  composerHasRevisionMessage,
  contentHash,
  REVISION_MARKER,
  revisionInstruction,
  revisionMessage,
  withoutRevisionInstruction,
  workspaceRelativeFile,
} from "../scripts/revision-mode.mjs";

const injectionSource = await readFile(new URL("../inject/codex-pin.user.js", import.meta.url), "utf8");

test("revision target is expressed as a portable workspace-relative path", () => {
  assert.equal(
    workspaceRelativeFile(
      String.raw`D:\projects\maya\pins\pin_thread.md`,
      String.raw`D:\projects\maya`,
    ),
    process.platform === "win32" ? "pins/pin_thread.md" : "",
  );

  if (process.platform !== "win32") {
    assert.equal(
      workspaceRelativeFile("/work/maya/pins/pin_thread.md", "/work/maya"),
      "pins/pin_thread.md",
    );
  }
});

test("revision target rejects files outside the current workspace", () => {
  const workspace = path.resolve("workspace-a");
  const outside = path.resolve("workspace-b", "pin.md");
  assert.equal(workspaceRelativeFile(outside, workspace), "");
});

test("revision instruction requires an actual file edit and preserves unrelated Markdown", () => {
  const instruction = revisionInstruction("pins/pin_thread.md");
  assert.match(instruction, /`pins\/pin_thread\.md`/);
  assert.match(instruction, /实际修改文件/);
  assert.match(instruction, /保留其余 Markdown 和代码块/);
  assert.match(instruction, /不要重新输出全文/);
});

test("revision instruction rejects an unsafe path", () => {
  assert.throws(() => revisionInstruction("../pin.md"), /工作区内的相对路径/);
  assert.throws(() => revisionInstruction(""), /工作区内的相对路径/);
});

test("revision message keeps the user request first and appends the hidden constraint", () => {
  const message = revisionMessage("请缩短第二节。", "pins/pin_thread.md");
  assert.ok(message.startsWith("请缩短第二节。\n\n"));
  assert.ok(message.endsWith(revisionInstruction("pins/pin_thread.md")));
  assert.throws(() => revisionMessage("  ", "pins/pin_thread.md"), /不能为空/);
});

test("composer verification tolerates rich-editor whitespace normalization", () => {
  const input = "对于特别说明那块区可以再详细一些";
  const message = revisionMessage(input, "pins/pin_demo.md");
  const editorText = message
    .replace("\n\n", "\n\n\n")
    .replace("Chat Pin", "Chat\u00a0Pin");
  assert.equal(composerHasRevisionMessage(editorText, input, message), true);
  assert.equal(comparableComposerText("a\u200bb\n\n c"), "ab\n c");
  assert.notEqual(comparableComposerText("a  b"), comparableComposerText("a b"));
  assert.equal(composerHasRevisionMessage(input, input, message), false);
  assert.equal(
    composerHasRevisionMessage(`${input}\n\n[Chat Pin 修订模式] 错误目标`, input, message),
    false,
  );
});

test("hidden revision submission keeps the Codex composer focusable", () => {
  assert.match(injectionSource, /data-codex-chat-pin-submitting[\s\S]*opacity:0!important/);
  assert.doesNotMatch(
    injectionSource,
    /data-codex-chat-pin-submitting[\s\S]{0,300}visibility:hidden/,
  );
});

test("content hashes change only when file content changes", () => {
  assert.equal(contentHash("same"), contentHash("same"));
  assert.notEqual(contentHash("before"), contentHash("after"));
});

test("visible revision instruction can be removed without deleting the user request", () => {
  const instruction = revisionInstruction("pins/pin_thread.md");
  assert.equal(
    withoutRevisionInstruction(`${instruction}\n\n请缩短第二节。`),
    "请缩短第二节。",
  );
  assert.equal(withoutRevisionInstruction(`请缩短第二节。\n${REVISION_MARKER} stale`), "请缩短第二节。");
});
