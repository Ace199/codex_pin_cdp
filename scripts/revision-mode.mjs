import { createHash } from "node:crypto";
import path from "node:path";

export const REVISION_MARKER = "[Chat Pin 修订模式]";

export function contentHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function workspaceRelativeFile(filePath, workspacePath) {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.replaceAll("\\", "/");
}

export function revisionInstruction(relativePath) {
  const target = String(relativePath || "").trim();
  if (!target || target.startsWith("/") || target.includes("..")) {
    throw new Error("修订目标必须是当前工作区内的相对路径");
  }
  return `${REVISION_MARKER} 请把本消息中的要求直接应用到当前工作区文件 \`${target}\`；只修改相关内容并保留其余 Markdown 和代码块，必须实际修改文件，不要重新输出全文。`;
}

export function revisionMessage(userInput, relativePath) {
  const input = String(userInput ?? "").trim();
  if (!input) throw new Error("本次文档修改要求不能为空");
  return `${input}\n\n${revisionInstruction(relativePath)}`;
}

export function comparableComposerText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function composerHasRevisionMessage(actual, userInput, combinedMessage) {
  const actualText = comparableComposerText(actual);
  const expectedText = comparableComposerText(combinedMessage);
  const inputText = comparableComposerText(userInput);
  return Boolean(
    actualText
    && actualText === expectedText
    && actualText.includes(comparableComposerText(REVISION_MARKER))
    && actualText.startsWith(inputText),
  );
}

export function withoutRevisionInstruction(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.includes(REVISION_MARKER))
    .join("\n")
    .trim();
}
