# Moduloze

Convert CommonJS (CJS) modules to UMD and ESM formats

## Overview

Moduloze enables authoring JS modules in the CommonJS (CJS) format that's native to the Node.js ecosystem, and converting those modules to Universal Module Definition (UMD) and ES Modules (ESM) formats.

UMD is particularly useful in browsers where ESM is not already being used in the application. CJS continues to work fully in all versions of Node, but in the latest Node versions, the ESM format for modules is also working, albeit with some unique limitations. UMD also works in all versions of Node, though it basically works identically to CJS.

The most common envisioned use-case for Moduloze is to author a utility that's designed to work in both Node and the browser, as many OSS libs/frameworks are. By authoring in the CJS format, and using Moduloze as a build process, the UMD/ESM formats are seamlessly available for use in the browser without additional authoring effort.

Alternatively, Moduloze can be used as a one-time "upgrade" code-mod, to take a set of CJS modules and convert them to ESM format.

Moduloze comes as a library that can be used directly, but also includes a helpful CLI that drives a lot of the logic necessary to convert a tree of files from CJS to UMD/ESM formats. It's recommended to use the CLI unless there are specific concerns that must be worked around.

## Module Format Conversion

Moduloze recognizes and handles a wide range of typical CJS `require(..)` and `module.exports` usage patterns.

For example, consider this CJS import:

```js
var Whatever = require("./path/to/whatever.js");
```

The ESM-build equivalent would (by default) be:

```js
import Whatever from "./path/to/whatever.js";
```

The UMD-build equivalent is handled in the UMD wrapper, where `Whatever` would automatically be set as an identifier (parameter) in scope for your UMD module code; thus, the entire `require(..)` containing statement would be removed.

And for this CJS export:

```js
module.exports = Whatever(42);
```

The ESM-build equivalent would (by default) be:

```js
export default Whatever(42);
```

The UMD-build equivalent would be:

```js
// auto inserted at the top of a UMD module that has exports
var _exp1 = {};

// ..

_exp1 = Whatever(42);

// ..

// auto inserted at the bottom of a UMD module that has exports
return _exp1;
```

For a much more detailed illustration of all the different conversion forms, please see the [Conversion Guide](./conversion-guide.md).

### Unsupported

There are variations which are not supported, since they are impossible (or impractical) to express in the target UMD or (more often) ESM format.

For example, `require(..)` calls for importing dependencies **must** have a single string-literal argument. Any sort of variable or expression in the argument position will reject the `require(..)` call and fail the build. The main reason is that ESM `import` statements require string literals.

Yes, JS recently added a dynamic `import(..)` function, which can handle expression arguments, but `import(..)` has a bunch of other usage nuances that are impractical for Moduloze to support, such as being async (returning promises). Moreover, the UMD wrapper pattern doesn't support arbitrary expression logic for computing the dependency paths; it would make the UMD wrapper intractably complex.

Both `require(..)` calls and `module.exports` must also be at the top level scope, not inside loops or conditionals. Again, this is primarily because ESM `import` and `export` statements must be at the top level scope and not wrapped in any block or other statement. Additionally, supporting these variations would make the UMD wrapper intractably complex.

For more details on limitations, please see the [Conversion Guide](./conversion-guide.md#whats-not-supported).

## CLI

To use the CLI:

```cmd
mz --from="./src" [--to="./dist"] [--recursive] [--build-umd] [--build-esm] [--bundle-umd] [--dep-map="./path/to/dep-map.json"] [--config="./path/to/.mzrc"]
```

See `mz --help` output for all available parameter flags.

### CLI Flags

* `--from-path=PATH`: specifies the path to a directory (or a single file) containing the module(s) to convert; defaults to `./` in the current working directory

* `--to-path=PATH`: specifies the path to a directory to write the converted module file(s), in sub-directories corresponding to the chosen build format (`umd/` and `esm/`, respectively); defaults to `./.mz-build` in the current working directory

* `--recursive` (alias `-r`): traverse the source directory recursively

* `--build-umd` (alias `-u`): builds the UMD format (`umd/*` in the output path)

* `--build-esm` (alias `-e`): builds the ESM format (`esm/*` in the output path)

* `--bundle-umd` (alias `-b`): specifies a path to write out a UMD bundle file (single UMD module exposing/exporting all converted UMD modules, by name); if specified but empty, defaults to `./umd/bundle.js` in the output directory; if omitted, skips UMD bundle

* `--dep-map` (alias `-m`): specifies the path to a JSON file to load the dependency map from; defaults to "./package.json", in which it will look for a `mz-dependencies` field to get the dependency map contents; otherwise, should be to a standalone JSON file with the dependency map contents specified directly

* `--config` (alias `-c`): specifies the path to a configuration file (JSON format) for some or all settings; defaults to `./.mzrc` in the current working directory; see [Configuration Settings](#configuration-settings)

The CLI tool will also read the following settings from the current process environment (or source them from a .env file in the current working directory):

* `RCPATH`: corresponds to the `--config` parameter (see above)
* `FROMPATH`: corresponds to the `--from` parameter (see above)
* `TOPATH`: corresponds to the `--to` parameter (see above)
* `DEPMAPPATH`: corresponds to the `--dep-map` parameter (see above)

## Library

To use the library directly in code, instead of as a CLI tool:

```js
var {
    build,
    bundleUMD,            /* optional */
    umdIndex,             /* optional */
    esmIndex,             /* optional */
    defaultLibConfig,     /* optional */
} = require("moduloze");
```

### `build(..)`

The `build(..)` method is the primary utility of the library, that does the main work of converting a single module from its CJS format to UMD and/or ESM formats.

Parameters:

* `config` (*object*): configuration object; (see [Configuration Settings](#configuration-settings))

* `pathStr` (*string*): the path to the CJS module file being converted

* `code` (*string*): contents of the CJS module file being converted

* `depMap` (*object*): a map of the dependencies (from their path to a local/common name for the module) that will/may be encountered in this file's `require(..)` statements

The return value from `build(..)` is an object containing properties corresponding the chosen build format(s): `umd` (for a UMD-format build) and `esm` (for an ESM-format build). Each build-format result object contains properties holding the converted code and other relevant metadata:

* `code` (*string*): converted module code ready to write to another file

* `ast` (*string*): the Babylon parser's AST (node tree object)

* `refDeps` (*object*): map of dependencies actually encountered in the file (same structure as `depMap` parameter above)

* `pathStr`: (*string*): the resolved/normalized path for the source module

* `name` (*string*): the local/common name of the module (from the `depMap`, or auto-generated if unknown)

Example usage:

```js
var fs = require("fs");
var { build } = require("moduloze");

var srcPath = "./src/whatever.js";
var moduleContents = fs.readFileSync(srcPath,{ encoding: "utf-8" });

var config = {
    buildUMD: true,
    buildESM: true
};

var depMap = {
    "./src/whatever.js": "Whatever",
    "./src/another.js": "Another"
};

var { umd, esm } = build(
    config,
    srcPath,
    moduleContents,
    depMap
);

console.log(umd.code);
// (function UMD(name,context,depen...

console.log(esm.code);
// import Another from "./anoth...
```

### `bundleUMD(..)`

Docs coming soon.

### `umdIndex(..)`

Docs coming soon.

### `esmIndex(..)`

Docs coming soon.

### `defaultLibConfig(..)`

Docs coming soon.

## Configuration Settings

The configuration object (either in a JSON file like `.mzrc` or passed into the library directly) can include the following settings:

* `buildESM` (*boolean*): build the ESM format; defaults to `false`

* `buildUMD` (*boolean*): build the UMD format; defaults to `false`

* `ignoreUnknownDependency` (*boolean*): suppresses exceptions when encountering an `require(..)` with a dependency path that is not in the known dependency map, useful if you rely on external dependencies that aren't being converted by Moduloze; defaults to `false`

* `ignoreCircularDependency` (*boolean*): suppresses exceptions when encountering a circular dependency in the converted modules; defaults to `false`; **Note:** because of how UMD works, circular dependencies will always fail in UMD, but ESM circular dependencies are generally OK.

* `.mjs` (*boolean*): rename outputed ESM modules from `.js` (or `.cjs`) file extensions to `.mjs`, which can make using the ESM format modules in Node easier; defaults to `false`; **Note:** the "." is intentionally part of the configuration name!

* `.cjs` (*boolean*): when traversing the source files that have `.cjs` file extensions, rename them to `.js` for the UMD build and either `.js` (or `.mjs`, depending on that configuration) for the ESM build; defaults to `false`;  **Note:** the "." is intentionally part of the configuration name!

* `namespaceImport` (*boolean*): for ESM builds, assume dependencies should be imported as namespaces (`import * as .. from ..`) rather than as default imports (`import .. from ..`); defaults to `false`; for example: `xyx = require("./xyz.js")` will be converted to `import * as xyz from "./xyz.js"` instead of `import xyz from "./xyz.js"`

* `namespaceExport` (*boolean*): for ESM builds, when generating the "index" roll-up build, assume dependencies should be re-exported as namespaces (`export * as .. from ..`) rather than as default exports (`export .. from ..`); defaults to `false`; for example: use `export * as xyz from "./xyz.js"` instead of `export { default as xyz } from "./xyz.js"`; **Note:** the `xyz` identifier name here comes from the dependency map (or auto-generated, if unknown)

* `exportDefaultFrom` (*boolean*): for ESM builds, overrides `namespaceExport` to switch to the TC39-proposed `export xyz from "./xyz.js"` form for the index builds (**warning:** not yet officially part of the JS specification); defaults to `false`

### CLI-only configurations

* `from` *string*: path for the source of module(s) to convert (CLI-only configuration)

* `to` *string*: path to write out the converted modules (CLI-only configuration)

* `depMap` *string*, *object*: if a *string*, path to load the dependency map; otherwise, an object that contains the dependency map

* `bundleUMDPath` *string*: (see the [CLI `--bundle-umd` parameter](#cli-flags))

* `skip` *array*: a list of strings containing [glob patterns](https://github.com/micromatch/micromatch#matching-features) that (relatively) specify files from the source path to skip over

* `copyOnSkip` *boolean*: copy skipped files to the target output path

* `copyFiles` *array*: a list of strings containing paths of files to copy from the source path to the target build output

* `recursive` *boolean*: (see the [CLI `--recursive` parameter](#cli-flags))

* `buildESM` *boolean*: (see the [CLI `--build-esm` parameter](#cli-flags))

* `buildUMD` *boolean*: (see the [CLI `--build-umd` parameter](#cli-flags))

* `generateIndex` *boolean*: for each build format, generates the "index.js" equivalent roll-up that "imports and re-exports" all source modules

## License

All code and documentation are (c) 2020 Kyle Simpson and released under the [MIT License](http://getify.mit-license.org/). A copy of the MIT License [is also included](LICENSE.txt).
