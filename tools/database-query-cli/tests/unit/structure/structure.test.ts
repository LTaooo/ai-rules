import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function files(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)],
    );
}
it('organizes behavior in classes and documents every named method with Chinese JSDoc', () => {
    const violations: string[] = [];
    const sourceRoot = resolve('src');
    expect(
        readdirSync(sourceRoot)
            .filter((name) => name.endsWith('.ts'))
            .sort(),
    ).toEqual(['cli.ts', 'index.ts']);
    for (const filename of files(sourceRoot).filter((name) => name.endsWith('.ts'))) {
        const text = readFileSync(filename, 'utf8');
        const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            if (
                ts.isFunctionDeclaration(node) ||
                (ts.isVariableStatement(node) &&
                    node.modifiers?.some(
                        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                    ) &&
                    node.declarationList.declarations.some(
                        (declaration) =>
                            declaration.initializer &&
                            (ts.isArrowFunction(declaration.initializer) ||
                                ts.isFunctionExpression(declaration.initializer)),
                    ))
            )
                violations.push(`${filename}: standalone function`);
            if (
                ts.isMethodDeclaration(node) ||
                ts.isConstructorDeclaration(node) ||
                ts.isGetAccessor(node) ||
                ts.isSetAccessor(node) ||
                ts.isMethodSignature(node) ||
                (ts.isPropertyDeclaration(node) &&
                    node.initializer &&
                    (ts.isArrowFunction(node.initializer) ||
                        ts.isFunctionExpression(node.initializer)))
            ) {
                const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
                if (!docs.some((doc) => /[一-鿿]/.test(doc.getText(source))))
                    violations.push(
                        `${filename}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: missing Chinese JSDoc`,
                    );
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    expect(violations).toEqual([]);
});
