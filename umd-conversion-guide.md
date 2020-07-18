# Moduloze: UMD Conversion Guide

This guide builds [on the Overview Example from the top-level conversion guide](conversion-guide.md#overview-example).

## Conversion Overview Example: UMD

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

Let's take a look at the UMD output produced, in two separate parts: the auto-generated UMD wrapper boilerplate, and the conversion of the `./src/test.js` module's code.

### UMD Wrapper

First, the UMD wrapper:

```js
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

    // ..

});
```

In this UMD wrapper, first notice that `TestModule` is the exported name for this overall module. That name came from the dependency-map (`depMap`) in the configuration for the build, as shown [in the Overview Example](#conversion-guide.md#overview-example). Moreover, the names `Whatever` and `Another` are used for the `./src/whatever.js` and `./src/another.js` modules, respectively; again these names come from `depMap`.

However, `./src/something.js` isn't listed in the dependency map (it probably should be!), so it's treated as an *unknown dependency*. Normally, that would throw an error, but in this case it doesn't because the config included `ignoreUnknownDependency: true`. It still has to have a name, so the name `Mz_540737562` was randomly generated for it, and will be used throughout all files in this current build run for any matching `./src/something.js` dependency import.

The UMD wrapper ensures this module will load properly in all of the following environments:

* Node.js (if you didn't want to use the original CJS, for some reason)

* A browser, using an AMD-style loader such as [RequireJS](https://requirejs.org/)

* A browser, using normal `<script src=..>` style loading, or a basic script loader (ie, [LABjs](https://github.com/getify/LABjs))

### Converted Module

Now, let's look at the `./src/test.js` module's converted code:

```js
var {
    Something
} = Mz_540737562;
var anotherVal = Another.another();
var _exp2 = {};
_exp2.whatever = Whatever();
Object.assign(_exp2, {
    Something,
    Another: anotherVal
});
return _exp2;
```

Let's break that conversion down.

#### Converted Imports

The UMD wrapper automatically takes care of the entirety of a default import, like the first `Whatever` import; that statement is effectively removed (having been replaced by just the `Whatever` named parameter -- see the UMD wrapper boilerplate).

The named import for `Something` is computed against the imported module binding (auto-named `Mz_540737562` above).

And the computation of `anotherVal` is performed against the imported `Another` module binding.

#### Converted Exports

All assignments to `module.exports` are rewritten to be performed against an auto-generated variable (`_exp2` above), such as `_exp2.whatever = ..`, including other non-obvious assignment computations/expressions, like the `Object.assign(..)`.

Finally, the `_exp2` intermediary is returned as the single exported value for the module.

## Other Conversion Variations

Let's also explore a variety of other forms of import and export conversion.

### Import Forms

When `require("..")` is encountered in the original source, the UMD wrapper takes care of loading this dependency, and setting it into the scope of the UMD module (via parameter) by its dependency name, or is auto-generated (like `Mz_43812323`), if unknown.

**Note:** In the following snippets, `DependencyName` stands in for this identifier (whether by its configured name, or auto-generated).

```js
require("..");

// handled by the UMD wrapper
```

```js
var x = require("..");

// handled by the UMD wrapper
```

```js
// var x = ..
x = require("..");

// converts to:

x = DependencyName;
```

**Note:**

```js
var x = require("..").something;

// converts to:

var x = DependencyName.something;
```

```js
// var x = ..
x = require("..").something;

// converts to:

x = DependencyName.something;
```

```js
var { something } = require("..");

// converts to:

var { something } = DependencyName;
```

```js
var { something: x } = require("..");

// converts to:

var { something: x } = DependencyName;
```

```js
// var something = ..
({ something } = require(".."));

// converts to:

({ something } = DependencyName);
```

```js
// var x = ..
({ something: x } = require(".."));

// converts to:

({ something: x } = DependencyName);
```

```js
var x = require("..").something(42);

// converts to:

var x = DependencyName.something(42);
```

```js
// var x = ..

x = require("..").something(42);

// converts to:

x = DependencyName.something(42);
```

```js
var x = require("..")(42);

// converts to:

var x = DependencyName(42);
```

```js
// var x = ..

x = require("..")(42);

// converts to:

x = DependencyName(42);
```

```js
something( require("..") );

// converts to:

something( DependencyName );
```

### Export Forms

In all the following forms, `module.exports` is recognized the same as just `exports`, so they're interchangeable in the conversion.

In UMD builds, any operations against `module.exports` are actually performed against an auto-generated substitute (ie, `_exp`), and then at the end of the module, a `return _exp` is inserted.

**Note:** multiple assignments to `module.exports` (ie, `module.exports = ..`, not just `module.exports.x = ..`) are *permitted* in UMD builds. However, you should avoid this, as it's creating confusion by overriding earlier assignments. In the ESM build format, an exception will be thrown, because multiple default exports are not allowed by ESM. It *is* however common (and fine!) to have a single assignment to `module.exports` and then subsequently assign additional properties (ie, `module.exports.x = ..`).

```js
module.exports = something;

// converts to:

var _exp = {};
// ..
_exp = something;
//..
return _exp;
```

```js
module.exports = 42;

// converts to:

var _exp = {};
// ..
_exp = 42;
// ..
return _exp;
```

```js
module.exports = something(42);

// converts to:

var _exp = {};
// ..
_exp = something(42);
// ..
return _exp;
```

```js
module.exports = function something() { .. };

// converts to:

var _exp = {};
// ..
_exp = function something() { .. };
// ..
return _exp;
```

```js
module.exports.x = something;

// converts to:

var _exp = {};
// ..
_exp.x = something;
// ..
return _exp;
```

```js
module.exports.x = something.y;

// converts to:

var _exp = {};
// ..
_exp.x = something.y;
// ..
return _exp;
```

```js
module.exports.x = 42;

// converts to:

var _exp = {};
// ..
_exp.x = 42;
// ..
return _exp;
```

```js
module.exports.x = function something() { .. };

// converts to:

var _exp = {};
// ..
_exp.x = function something() { .. };
// ..
return _exp;
```

```js
Object.assign(module.exports,{
    something() { .. },
    x: 42
});

// converts to:

var _exp = {};
// ..
Object.assign(_exp,{
    something() { .. },
    x: 42
});
// ..
return _exp;
```

```js
something(module.exports);

// converts to:

var _exp = {};
// ..
something(_exp);
// ..
return _exp;
```

### Import + Export Forms

// TODO
