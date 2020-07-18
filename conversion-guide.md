# Moduloze: Conversion Guide

There's a wide variety of supported forms of `require(..)` and `module.exports` expressions that Moduloze can recognize and convert, and a lot of factors that control which output is created. The goal in these conversion guides is to try to document as much of that detail as practical.

## Overview Example

Consider the following CJS code (in a file like `./src/test.js`):

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

And consider the build command (either directly in code as shown, or via the CLI) essentially looking like this:

```js
var config = {
    buildUMD: true,
    buildESM: true,
    ignoreUnknownDependency: true
};

var depMap = {
    "./src/test.js": "TestModule",
    "./src/whatever.js": "Whatever",
    "./src/another.js": "Another"
};

var results = build(
    config,
    "./src/test.js",
    testModuleCode,
    depMap
);
```

### ESM Conversion

The converted ESM code (in `results.esm.code`) will look like this:

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

For more information on all the nuances of this conversion (and all other forms), see the [ESM Conversion Guide](esm-conversion-guide.md).

### UMD Conversion

The converted UMD code (in `results.umd.code`) will look like this:

```js
/* NOTE: this is all auto-generated UMD wrapper stuff */
/* ************************************* */
(function UMD(name, context, dependencies, definition) {
  if (typeof define === "function" && define.amd) {
    dependencies = Object.keys(dependencies).map(p => p.replace(/^\.\//, ""));
    define(name, dependencies, definition);
  } else if (typeof module !== "undefined" && module.exports) {
    dependencies = Object.keys(dependencies).map(p => require(p));
    module.exports = definition(...dependencies);
  } else {
    dependencies = Object.values(dependencies).map(n => context[n]);
    context[name] = definition(...dependencies);
  }
})("TestModule", typeof globalThis != "undefined" ? globalThis : typeof global != "undefined" ? global : typeof window != "undefined" ? window : typeof self != "undefined" ? self : new Function("return this")(), {
  "./src/whatever.js": "Whatever",
  "./src/something.js": "Mz_540737562",
  "./src/another.js": "Another"
}, function DEF(Whatever, Mz_540737562, Another) {
/* ************************************* */
/* Note: this is where your module's code goes */

  var {
    Something
  } = Mz_540737562;
  let anotherVal = Another.another();
  let _exp2 = {};
  _exp2.whatever = Whatever();
  Object.assign(_exp2, {
    Something,
    Another: anotherVal
  });
  return _exp2;

});
```

**Note:** The code comments and extra blank lines are added here only for easier readability; they're not actually included in the output.

For more information on all the nuances of this conversion (and all other forms), see the [UMD Conversion Guide](umd-conversion-guide.md).

## What's Not Supported

The ["Unsupported"](README.md#unsupported) section of the README covers two major limitations on supported forms:

* `require(..)` must have a single string literal (delimited with `'` or `"`, not `` ` ``)

* `require(..)` and `module.exports` must be part of a statement in the top-level scope of the program

In addition, there are some other limitations to be aware of:

* Circular dependencies are impossible in UMD format; so by default, Moduloze complains if a dependency cycle is detected. If you're only building ESM format, and want to let ESM manage the circular dependency resolution, you can turn on the [`ignoreCircularDependency` configuration](README.md#configuration-settings).

* Multiple re-assignments of `module.exports` in the same file is not allowed, since each re-assignment is translated in ESM as a `export default ..`, and only one of those is allowed per ESM module. This would be a red flag anyway; if you find this error raised in your conversion, it likely means the source file is confusingly stepping on its own toes with its conflicting `module.exports` behavior.
