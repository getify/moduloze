(function UMDBundle(context,umdDefs){
	for (let [ name, dependencies, definition, ] of umdDefs) {
		if (typeof define === "function" && define.amd) {
			dependencies = Object.values(dependencies);
			define(name,dependencies,definition);
		}
		else if (typeof module !== "undefined" && module.exports) {
			dependencies = Object.entries(dependencies).map(([p,n]) => module.exports[n] || require(p));
			module.exports[name] = definition(...dependencies);
		}
		else {
			dependencies = Object.values(dependencies).map(n => context[n]);
			context[name] = definition(...dependencies);
		}
	}
})(
	(
		typeof globalThis != "undefined" ? globalThis :
		typeof global != "undefined" ? global :
		typeof window != "undefined" ? window :
		typeof self != "undefined" ? self :
		(new Function("return this"))()
	),
	[],
);
