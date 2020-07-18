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

let anotherVal = _imp();

let _exp = Whatever();

export { _exp as whatever };
let _exp2 = {};
Object.assign(_exp2, {
  Something,
  Another: anotherVal
});
export default _exp2;
```

Let's break that conversion down.

#### Converted `import`s

By default, `var Whatever = require(..)` becomes `import Whatever from ".."`. If you set the [`namespaceImport` configuration](README.md#configuration-settings) to `true`, it would have been `import * as Whatever from ".."`. The difference is, do you want Moduloze to assume that your modules always export a single default export (so use a default `import ..` form), or that your modules always export one or more named exports (so use a namespace `import * as ..` form, to collect all named imports under the single namespace).

You should typically design all your modules to follow one or the other of those two strategies, and not mix-n-match, and then set the configuration flag to use the appropriate `import` form. Otherwise, the `import` forms Moduloze produces may very well not work as expected. Moduloze *does not* analyze the export patterns to automatically select the appropriate `import` form to use.

The import form `var { Something } = require(..)` -- or alternately, `var xyz = require(..).Something` -- signals a single named import: `import { Something } from ".."`.

If `require(..)` otherwise shows up as part of some expression, such as `require(..).another()`, then the module is first default imported (or namespace imported, depending on the `namespaceImport` config) to bind to an auto-generated identifier (`_imp`, in this case), and then the rest of the expression is computed with that result (`var anotherVal = _imp()`).

#### Converted `export`s

The named export `module.exports.whatever = ..` is an expression, which can't be directly exported. So first the computation of the export is assigned to an auto-generated variable (`_exp` in this case), and then exported by name with `export { _exp as whatever }`.

When `module.exports` shows up in any other expression besides a direct or named assignment, the results are actually computed first and assigned to an auto-generated variable (`_exp2` in this case), and then exported. The assumption is that any such operations performed against `module.exports` (via the intermediary `_exp2`) should have their final computed result exported as a default export (`export default _exp2`).

## Other Conversion Variations

Let's also explore a variety of other forms of import and export conversion.

### Import Forms

```js
require("..");

// converts to:

import "..";
```

```js
var x = require("..");

// converts to:

import x from "..";

// or, if "importNamespace" config is set:

import * as x from "..";
```

```js
// var x = ..
x = require("..");

// converts to:

import { default as _imp } from "..";
x = _imp;

// or, if "importNamespace" config is set:

import * as _imp from "..";
x = _imp;
```

```js
var x = require("..").something;

// converts to:

import { something as x } from "..";
```

```js
var x = require("..").default;

// converts to:

import x from "..";
```

```js
// var x = ..
x = require("..").something;

// converts to:

import { something as _imp } from "..";
x = _imp;
```

```js
// var x = ..
x = require("..").default;

// converts to:

import _imp from "..";
x = _imp;
```

```js
var { something } = require("..");

// converts to:

import { something } from "..";
```

```js
var { something: x } = require("..");

// converts to:

import { something as x } from "..";
```

```js
// var something = ..
({ something } = require(".."));

// converts to:

import { something as _imp } from "..";
something = _imp;
```

```js
// var x = ..
({ something: x } = require(".."));

// converts to:

import { something as imp } from "..";
x = _imp;
```

```js
var x = require("..").something(42);

// converts to:

import _imp from "..";
var x = _imp.something(42);

// or, if "namespaceImport" config is set:

import * as _imp from "..";
var x = _imp.something(42);
```

```js
// var x = ..

x = require("..").something(42);

// converts to:

import _imp from "..";
x = _imp.something(42);

// or, if "namespaceImport" config is set:

import * as _imp from "..";
x = _imp.something(42);
```

```js
var x = require("..")(42);

// converts to:

import _imp from "..";
var x = _imp(42);

// or, if "namespaceImport" config is set:

import * as _imp from "..";
var x = _imp(42);
```

```js
// var x = ..

x = require("..")(42);

// converts to:

import _imp from "..";
x = _imp(42);

// or, if "namespaceImport" config is set:

import * as _imp from "..";
x = _imp(42);
```

```js
something( require("..") );

// converts to:

import _imp from "..";
something( _imp );

// or, if "namespaceImport" config is set:

import * as _imp from "..";
something( _imp );
```

### Export Forms

In all the following forms, `module.exports` is recognized the same as just `exports`, so they're interchangeable in the conversion.

ESM modules can only have a single "default export" (like `export default ..` or `export { something as default }`), so Moduloze will throw an exception if more than one export conversion results in such a statement.

```js
module.exports = something;

// converts to:

export default something;
```

```js
module.exports = 42;

// converts to:

export default 42;
```

```js
module.exports = something(42);

// converts to:

export default something(42);
```

```js
module.exports = function something() { .. };

// converts to:

export default function something() { .. };
```

```js
module.exports.x = something;

// converts to:

export { something as x };
```

```js
module.exports.x = something.y;

// converts to:

export var { y: x } = something;
```

```js
module.exports.x = 42;

// converts to:

let _exp = 42;
export { _exp as x };
```

```js
module.exports.x = function something() { .. };

// converts to:

let _exp = function something() { .. };
export { _exp as x };
```

```js
Object.assign(module.exports,{
    something() { .. },
    x: 42
});

// converts to:

let _exp = {};
Object.assign(_exp,{
    something() { .. },
    x: 42
});
export default _exp;
```

```js
something(module.exports);

// converts to:

let _exp = {};
something(_exp);
export default _exp;
```

### Import + Export Forms

The following are recognized combined forms that are effectively import and re-export in the same statement. In some cases, this can take advantage of the `export .. from ..` combined form.

```js
module.exports = require("..");

// converts to:

import _imp from "..";
export default _imp;

// or, if "namespaceImport" config is set:

import * as _imp from "..";
export default _imp;
```

```js
module.exports = require("..").x;

// converts to:
export { x as default } from "..";
```

```js
module.exports.something = require("..").x;

// converts to:
export { x as something } from "..";
```

```js
module.exports.x = require("..");

// converts to:

import _imp from "..";
export { _imp as x };

// or, if "namespaceImport" config is set:
import * as _imp from "..";
export { _imp as x };
```
