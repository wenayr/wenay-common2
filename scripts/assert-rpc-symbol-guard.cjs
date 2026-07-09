const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.join(process.cwd(), 'src', 'Common', 'rcp');
const assignmentOperators = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

function files(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function isAssignmentWrite(node) {
  const p = node.parent;
  return ts.isBinaryExpression(p) && p.left === node && assignmentOperators.has(p.operatorToken.kind);
}

function lineAndColumn(source, pos) {
  const lc = source.getLineAndCharacterOfPosition(pos);
  return `${lc.line + 1}:${lc.character + 1}`;
}

const failures = [];
for (const file of files(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  function visit(node) {
    if (ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.argumentExpression)
      && node.argumentExpression.text === 'IS_RPC_LISTEN'
      && !isAssignmentWrite(node)) {
      failures.push(`${path.relative(process.cwd(), file)}:${lineAndColumn(source, node.getStart(source))}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
}

if (failures.length) {
  console.error('Forbidden direct reads of [IS_RPC_LISTEN]. Use Object.prototype.hasOwnProperty.call(obj, IS_RPC_LISTEN).');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log('PASS rpc symbol guard: no direct reads of [IS_RPC_LISTEN]');