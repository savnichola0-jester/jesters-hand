// Exercises the actual template through Yoga (the native layout engine), without
// Firebase, login, or writes. Text measurement is deterministic, not font-exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import Yoga from 'yoga-layout';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = new URL('../components/recruit/JestersDeskTemplate.tsx', import.meta.url);
const source = process.argv.includes('--stdin') ? fs.readFileSync(0, 'utf8') : fs.readFileSync(filename, 'utf8');
const jsx = (type, props) => ({ type, props });
const fragment = Symbol('fragment');
const flatten = value => Array.isArray(value)
  ? Object.assign({}, ...value.map(flatten)) : value || {};
const react = {
  Children: { map: (children, fn) => [children].flat(Infinity).map(fn) },
  useState: value => [value, () => {}],
  useEffect: () => {},
};
const native = {
  StyleSheet: { create: styles => styles, absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
  ...Object.fromEntries(['View', 'Text', 'Pressable', 'Image', 'ActivityIndicator'].map(name => [name, name])),
};
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, {
  module, exports: module.exports,
  require: name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: fragment };
    if (name === 'react-native') return native;
    if (name === '@/lib/recruitService') return { getRecruitPhotoUri: async () => null };
    throw new Error(`Unexpected dependency ${name}`);
  },
});

function expand(element) {
  if (element == null || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(expand);
  if (typeof element !== 'object') return [element];
  if (element.type === fragment) return expand(element.props.children);
  if (typeof element.type === 'function') return expand(element.type(element.props));
  return [{ ...element, children: expand(element.props.children), style: flatten(element.props.style) }];
}

function measuredText(text, style, available, fontScale) {
  const font = (style.fontSize || 14) * fontScale;
  const line = (style.lineHeight || (style.fontSize || 14) * 1.3) * fontScale;
  const advance = font * 0.52;
  const limit = Number.isFinite(available) ? Math.max(1, Math.floor(available / advance)) : 100000;
  // Wrap whole words when possible, including explicit newlines.
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    let used = 0;
    lines++;
    for (const word of paragraph.split(/\s+/)) {
      if (used && used + word.length + 1 > limit) { lines++; used = 0; }
      const length = word.length + (used ? 1 : 0);
      lines += Math.max(0, Math.ceil(length / limit) - 1);
      used = (used + length) % limit || limit;
    }
  }
  return { width: Math.min(available, Math.max(1, text.length * advance)), height: lines * line };
}

function build(element, fontScale) {
  const node = Yoga.Node.create();
  const style = element.style;
  const enums = {
    flexDirection: { row: Yoga.FLEX_DIRECTION_ROW, column: Yoga.FLEX_DIRECTION_COLUMN },
    flexWrap: { wrap: Yoga.WRAP_WRAP },
    alignItems: { center: Yoga.ALIGN_CENTER, 'flex-start': Yoga.ALIGN_FLEX_START, stretch: Yoga.ALIGN_STRETCH },
    alignContent: { 'flex-start': Yoga.ALIGN_FLEX_START },
    justifyContent: { center: Yoga.JUSTIFY_CENTER, 'space-between': Yoga.JUSTIFY_SPACE_BETWEEN },
    position: { absolute: Yoga.POSITION_TYPE_ABSOLUTE },
  };
  for (const [key, values] of Object.entries(enums)) {
    const value = values[style[key]];
    if (value !== undefined) node[`set${key === 'position' ? 'PositionType' : key[0].toUpperCase() + key.slice(1)}`](value);
  }
  for (const key of ['width', 'height', 'minWidth', 'maxWidth', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'aspectRatio']) {
    if (style[key] !== undefined) node[`set${key[0].toUpperCase() + key.slice(1)}`](style[key]);
  }
  for (const [name, method] of [['padding', 'setPadding'], ['margin', 'setMargin'], ['border', 'setBorder']]) {
    for (const [suffix, edge] of Object.entries({
      '': Yoga.EDGE_ALL, Vertical: Yoga.EDGE_VERTICAL, Horizontal: Yoga.EDGE_HORIZONTAL,
      Top: Yoga.EDGE_TOP, Bottom: Yoga.EDGE_BOTTOM, Left: Yoga.EDGE_LEFT, Right: Yoga.EDGE_RIGHT,
    })) {
      const value = style[`${name}${suffix}${name === 'border' ? 'Width' : ''}`];
      if (value !== undefined) node[method](edge, value);
    }
  }
  if (style.gap !== undefined) node.setGap(Yoga.GUTTER_ALL, style.gap);
  const result = { element, node, children: [] };
  if (element.type === 'Text') {
    const text = element.children.join('');
    const textScale = Math.min(fontScale, element.props.maxFontSizeMultiplier || Infinity);
    node.setMeasureFunc((width, widthMode) => measuredText(text, style, widthMode === Yoga.MEASURE_MODE_UNDEFINED ? Infinity : width, textScale));
    result.text = text;
  } else {
    for (const child of element.children.filter(child => typeof child === 'object')) {
      const nested = build(child, fontScale);
      node.insertChild(nested.node, result.children.length);
      result.children.push(nested);
    }
  }
  return result;
}

function audit(tree, fontScale, errors, parentId = '') {
  const box = tree.node.getComputedLayout();
  const id = tree.element.props.testID || parentId;
  if (tree.text !== undefined) {
    const needed = measuredText(tree.text, tree.element.style, box.width + 1, Math.min(fontScale, tree.element.props.maxFontSizeMultiplier || Infinity)).height;
    if (box.height + 1 < needed) errors.push(`${id || tree.text.slice(0, 35)}: text compressed to ${box.height}, needs ${needed.toFixed(1)}`);
  }
  const flowing = tree.children.filter(child => child.element.style.position !== 'absolute');
  for (let i = 0; i < flowing.length; i++) {
    const a = flowing[i].node.getComputedLayout();
    if (a.left < -1 || a.left + a.width > box.width + 2.5) errors.push(`${id || tree.element.type}: child ${flowing[i].text?.slice(0, 35) || flowing[i].element.type} exceeds available width (${a.left}+${a.width} > ${box.width})`);
    if (a.top < -1 || a.top + a.height > box.height + 2.5) errors.push(`${id || tree.element.type}: child ${flowing[i].text?.slice(0, 40) || flowing[i].element.type} exceeds available height (${a.top}+${a.height} > ${box.height})`);
    for (const sibling of flowing.slice(i + 1)) {
      const b = sibling.node.getComputedLayout();
      if (Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > 1
        && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 1) {
        errors.push(`${id}: neighboring content boxes overlap`);
      }
    }
  }
  for (const child of tree.children) audit(child, fontScale, errors, id);
}

let cases = 0;
for (const width of [320, 360, 390, 430, 724]) {
  for (const fontScale of [1, 1.3, 2]) {
    for (const longCopy of [false, true]) {
      const text = new Proxy({}, { get: (_, field) => longCopy
        ? `${String(field)} — A longer newspaper paragraph with several sentences that should make this field grow without covering the next story. `.repeat(3)
        : undefined });
      const elements = expand(jsx(module.exports.default, {
        width, content: { text, photos: {} }, editable: true,
      }));
      const tree = build(elements[0], fontScale);
      tree.node.calculateLayout(width, undefined, Yoga.DIRECTION_LTR);
      const errors = [];
      audit(tree, fontScale, errors);
      tree.node.freeRecursive();
      assert.equal(errors.length, 0, `width=${width}, fontScale=${fontScale}, longCopy=${longCopy}\n${errors.slice(0, 12).join('\n')}`);
      cases++;
    }
  }
}
console.log(`PASS: ${cases} native Yoga template layouts; no compressed text, overflowing sections, or overlapping boxes. No database access.`);
