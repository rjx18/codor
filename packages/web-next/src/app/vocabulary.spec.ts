import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.spec.') ? [path] : [];
  });
}

function humanStrings(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const strings: string[] = [];
  const visit = (node: ts.Node): void => {
    // Module paths and machine identifiers are not copy shown to a person.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return strings;
}

const callsCodorASwitchboard = (value: string): boolean =>
  /(?<![\w-])switchboard(?![\w-])/i.test(value) && /\s/.test(value.trim());

describe('product vocabulary', () => {
  it('keeps switchboard as a machine identifier, never human-facing copy', () => {
    const offenders = sourceFiles(sourceRoot).flatMap((file) =>
      humanStrings(file)
        .filter(callsCodorASwitchboard)
        .map((text) => `${file}: ${JSON.stringify(text.trim())}`),
    );
    expect(offenders).toEqual([]);
  });

  it('still permits the pairing protocol field', () => {
    expect(callsCodorASwitchboard('switchboard_sign_pub')).toBe(false);
    expect(callsCodorASwitchboard('Browsers paired to this switchboard.')).toBe(true);
  });
});
