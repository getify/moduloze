# Moduloze: ESM Conversion Guide

This guide builds [on the Overview Example from the top-level conversion guide](conversion-guide.md#overview-example).

## Conversion Overview Example: ESM

`./src/test.js`:

```js
var Whatever = require("./src/whatever.js");
var { Something } = require("./src/something.js");
var anotherVal = require("./src/another.js").another();

module.exports.whatever = Whatever();

Object.assign(module.exports,{
    Something,
    Another: anotherVal,
});
```

### Converted Module

```js
import Whatever from "./src/whatever.mjs";
import { Something } from "./src/something.js";
import _imp from "./src/another.mjs";

var anotherVal = _imp();

let _exp = Whatever();

export { _exp as whatever };
var _exp2 = {};
Object.assign(_exp2, {
  Something,
  Another: anotherVal
});
export default _exp2;
```

Let's break that conversion down.

#### Imports

By default, `var Whatever = require(..)` becomes `import Whatever from ".."`. If you set the [`namespaceImport` configuration](README.md#configuration-settings) to `true`, it would have been `import * as Whatever from ".."`. The difference is, do you want Moduloze to assume that your modules always export a single default export (so use a default `import ..` form), or that your modules always export one or more named exports (so use a namespace `import * as ..` form, to collect all named imports under the single namespace).

You should typically design all your modules to follow one or the other of those two strategies, and not mix-n-match, and then set the configuration flag to use the appropriate `import` form. Otherwise, the `import` forms Moduloze produces may very well not work as expected. Moduloze *does not* analyze the export patterns to automatically select the appropriate `import` form to use.

The import form `var { Something } = require(..)` -- or alternately, `var xyz = require(..).Something` -- signals a single named import: `import { Something } from ".."`.

If `require(..)` otherwise shows up as part of some expression, such as `require(..).another()`, then the module is first default imported (or namespace imported, depending on the `namespaceImport` config) to bind to an auto-generated identifier (`_imp`, in this case), and then the rest of the expression is computed with that result (`var anotherVal = _imp()`).

#### Exports

The named export `module.exports.whatever = ..` is an expression, which can't be directly exported. So first the computation of the export is assigned to an auto-generated variable (`_exp` in this case), and then exported by name with `export { _exp as whatever }`.

When `module.exports` shows up in any other expression besides a direct or named assignment, the results are actually computed first and assigned to an auto-generated variable (`_exp2` in this case), and then exported. The assumption is that any such operations performed against `module.exports` (via the intermediary `_exp2`) should have their final computed result exported as a default export (`export default _exp2`).
